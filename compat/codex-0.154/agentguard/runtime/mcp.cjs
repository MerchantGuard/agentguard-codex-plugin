#!/usr/bin/env node
'use strict';

// Read-only stdio MCP. This module never initializes keys, policies, or ledgers.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
const { locations } = require('./common.cjs');
const {readPolicy} = require('./policy-file.cjs');
const {readHealth} = require('./health.cjs');
const {readSessionLicense, readLatestLicenseStatus} = require('./license.cjs');

const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 100000;
const PAGE_LIMIT = 200;
const schemas = {
  get_status: { type: 'object', properties: { day: { type: 'string', description: 'UTC day, YYYY-MM-DD. Defaults to today.' }, sessionId: {type: 'string', description: 'Current host session identifier.'} }, additionalProperties: false },
  list_decisions: { type: 'object', properties: { fromSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: PAGE_LIMIT } }, additionalProperties: false },
  verify_chain: { type: 'object', properties: {}, additionalProperties: false },
  export_receipts: { type: 'object', properties: { sessionId: {type: 'string', description: 'Current host session identifier.'}, fromSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: PAGE_LIMIT } }, additionalProperties: false },
};
const descriptions = {
  get_status: 'Read license tier, seat count and limit, seat storage and verification status, expiry, effective mode, shadow reason, daily signed decision totals, and fail-open counts and rates for the last hour and since worker start. License and health reads are offline.',
  list_decisions: 'Read a bounded page of content-free tool decision summaries from the local ledger.',
  verify_chain: 'Verify every local ledger signature and hash link against the local public verification key; never accesses private keys.',
  export_receipts: 'With a valid paid license, return a page of signed content-free receipts and the public verification key for a records custodian. No files are written. Concatenate pages to verify the complete chain.',
};
const TOOLS = Object.keys(schemas).map(name => ({ name, description: descriptions[name], inputSchema: schemas[name], annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));

const ENTRY_KEYS = new Set(['sequence', 'decision', 'previousHash', 'entryHash', 'signature', 'signerFingerprint', 'builderCode', 'publicKeyHex']);
const DECISION_KEYS = new Set(['decisionId', 'timestamp', 'action', 'triggeredCap', 'triggeredScopeKey', 'projectedCents', 'windowSpendBefore', 'windowSpendAfter', 'provider', 'modelRequested', 'modelResolved', 'policyId', 'policyVersion', 'enforcementMode', 'reasons', 'entryType', 'originalDecisionId', 'actor', 'costBasis', 'provenance', 'outcomeReceipt', 'governanceReceipt', 'estimatedInputTokens', 'estimatedOutputTokens', 'actualInputTokens', 'actualOutputTokens', 'actualCents', 'deltaCents', 'partial', 'plugin']);
const PLUGIN_KEYS = new Set(['schema', 'event', 'toolName', 'inputSha256', 'inputBytes', 'inputKeys', 'toolUseId', 'sessionId', 'agentId', 'capabilityTier', 'unitCostCents', 'chargedCents', 'chargedWindows', 'startedAt', 'durationMs', 'durationSource', 'outputBytes', 'success', 'decisionId', 'gate', 'reasonCode', 'burnReceiptId', 'license', 'policyReasonCode', 'requestId', 'integrity']);
const FORBIDDEN_KEY = /^(?:tool_input|tool_response|tool_output|input|output|prompt|completion|content|messages|text|body|raw|privateKey|private_key|signingKey|signing_key|secret|secretKey|secret_key|accessToken|access_token|authorization|apiKey|api_key|licenseKey|license_key)$/i;

function metadataOnly(value, depth = 0) {
  if (depth > 12) throw new Error('Ledger metadata nesting is invalid.');
  if (Array.isArray(value)) return value.forEach(item => metadataOnly(item, depth + 1));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error('Ledger contains a disallowed content or secret field.');
    metadataOnly(item, depth + 1);
  }
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !ENTRY_KEYS.has(key))) throw new Error('Ledger entry schema is invalid.');
  const decision = entry.decision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) || Object.keys(decision).some(key => !DECISION_KEYS.has(key))) throw new Error('Ledger decision schema is invalid.');
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0 || !/^[a-f0-9]{64}$/.test(entry.entryHash) || !/^[a-f0-9]{64}$/.test(entry.previousHash) || !/^[a-f0-9]{128}$/.test(entry.signature) || !/^[a-f0-9]{16}$/.test(entry.signerFingerprint)) throw new Error('Ledger signature metadata is invalid.');
  if (typeof decision.timestamp !== 'string' || !Number.isFinite(Date.parse(decision.timestamp)) || typeof decision.decisionId !== 'string' || !Number.isSafeInteger(decision.projectedCents) || decision.projectedCents < 0) throw new Error('Ledger decision metadata is invalid.');
  metadataOnly(decision);
  for (const metadata of [decision.plugin, decision.outcomeReceipt?.plugin]) {
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some(key => !PLUGIN_KEYS.has(key)))) throw new Error('Plugin metadata schema is invalid.');
    if (metadata?.integrity !== undefined && (!metadata.integrity || typeof metadata.integrity !== 'object' || Array.isArray(metadata.integrity) || Object.keys(metadata.integrity).some(key => !['reason', 'confirmedSequence', 'confirmedHash', 'recoveredHeadHash', 'recoveredRows', 'truncatedBytes', 'checkpointMissing'].includes(key)))) throw new Error('Integrity metadata schema is invalid.');
    if (metadata?.chargedWindows !== undefined && (!Array.isArray(metadata.chargedWindows) || metadata.chargedWindows.some(window => !window || typeof window !== 'object' || Array.isArray(window) || Object.keys(window).some(key => !['scopeKey', 'window', 'windowStart'].includes(key))))) throw new Error('Plugin budget metadata schema is invalid.');
  }
}

function assertArgs(name, args) {
  const schema = schemas[name];
  if (!schema) throw new Error('Unknown read-only tool.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) throw new Error('Unexpected argument.');
  if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 512)) throw new Error('sessionId must be a host session identifier.');
  if (args.fromSequence !== undefined && (!Number.isSafeInteger(args.fromSequence) || args.fromSequence < 0)) throw new Error('fromSequence must be a non-negative integer.');
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > PAGE_LIMIT)) throw new Error('limit must be an integer from 1 to 200.');
  if (args.day !== undefined && (typeof args.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.day) || !Number.isFinite(Date.parse(args.day)) || new Date(args.day).toISOString().slice(0, 10) !== args.day)) throw new Error('day must be a valid UTC date.');
}

function summary(entry) {
  const d = entry.decision;
  const metadata = d.plugin || d.outcomeReceipt?.plugin || {};
  return { sequence: entry.sequence, entryHash: entry.entryHash, decisionId: d.decisionId, timestamp: d.timestamp, action: d.action, entryType: d.entryType || 'decision', provider: d.provider, model: d.modelRequested, actor: d.actor, projectedCents: d.projectedCents, reasons: d.reasons, originalDecisionId: d.originalDecisionId, toolName: metadata.toolName, event: metadata.event, gate: metadata.gate };
}

function failOpen(decision) {
  const metadata = decision.plugin || decision.outcomeReceipt?.plugin || decision.governanceReceipt || decision.outcomeReceipt || {};
  return metadata.failOpen === true || ['fail_open', 'fail-open'].includes(metadata.event) || ['fail_open', 'fail-open'].includes(metadata.kind);
}

function seatEvidence(status) {
  const seatsUsed = Number.isSafeInteger(status?.seatsUsed) && status.seatsUsed >= 0 ? status.seatsUsed : null;
  const seatLimit = Number.isSafeInteger(status?.seatLimit) && status.seatLimit >= 0 ? status.seatLimit : null;
  const seatStorage = ['kv', 'memory'].includes(status?.seatStorage) ? status.seatStorage : null;
  const seatsVerified = status?.seatsVerified === true && seatStorage === 'kv'
    && seatsUsed !== null && seatLimit !== null;
  return {seatsUsed, seatLimit, seatStorage, seatsVerified};
}

// Display entitlement and seat evidence without the worker's private identity
// bookkeeping. New snapshot fields do not automatically become MCP output.
function displayLicense(status) {
  const fields = ['paid', 'mode', 'reason', 'tier', 'seatsUsed', 'seatLimit',
    'seatStorage', 'seatsVerified', 'seatRefreshedAt', 'expiresAt', 'graceUntil',
    'offlineGrace', 'source', 'refreshedAt', 'seatStatus', 'seatHeartbeatAt',
    'seatHeartbeatError'];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(status, key))
    .filter(key => status[key] === null || ['string', 'boolean', 'number'].includes(typeof status[key]))
    .map(key => [key, status[key]]));
}

function createReader(options = {}) {
  const dataDir = path.resolve(options.dataDir || locations().data);
  const store = new sdk.NdjsonDecisionLogStore(options.tenant || 'ledger', { home: dataDir });
  const publicKeyPath = path.join(dataDir, options.publicKeyFile || 'public-key.hex');

  async function snapshot() {
    let stat;
    try { stat = fs.statSync(store.filePath); } catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Ledger cannot be read.'); }
    if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) throw new Error('Ledger exceeds the read-only server size limit.');
    // The SDK intentionally skips malformed NDJSON lines. Verify the physical
    // file first so this audit reader never reports a truncated chain as valid.
    const lines = fs.readFileSync(store.filePath, 'utf8').split('\n').filter(line => line.trim());
    if (lines.length > MAX_ROWS) throw new Error('Ledger exceeds the read-only server entry limit.');
    let physical;
    try { physical = lines.map(line => JSON.parse(line)); } catch { throw new Error('Ledger contains malformed JSON.'); }
    physical.forEach(validateEntry);
    const entries = await store.read(0, MAX_ROWS + 1);
    if (entries.length !== physical.length) throw new Error('Ledger changed while reading; retry.');
    const physicalHashes = physical.map(entry => entry.entryHash).sort();
    if (entries.map(entry => entry.entryHash).sort().some((hash, i) => hash !== physicalHashes[i])) throw new Error('Ledger changed while reading; retry.');
    entries.forEach(validateEntry);
    return entries;
  }

  function publicKey(entries) {
    let encoded;
    try { encoded = fs.readFileSync(publicKeyPath, 'utf8').trim(); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Public verification key cannot be read.');
      encoded = entries[0]?.publicKeyHex;
    }
    if (!encoded && entries.length === 0) return null;
    if (typeof encoded !== 'string' || !/^[a-f0-9]{64}$/i.test(encoded)) throw new Error('Public verification key is missing or invalid.');
    const fingerprint = createHash('sha256').update(Buffer.from(encoded, 'hex')).digest('hex').slice(0, 16);
    if (entries.some(entry => entry.signerFingerprint !== fingerprint || (entry.publicKeyHex && entry.publicKeyHex.toLowerCase() !== encoded.toLowerCase()))) throw new Error('Ledger signer does not match the public verification key.');
    return encoded.toLowerCase();
  }

  async function verify(entries) {
    const key = publicKey(entries);
    return { ...(key ? await sdk.verifyChain(entries, Buffer.from(key, 'hex')) : { ok: true }), entries: entries.length, publicKeyHex: key, lastEntryHash: entries.at(-1)?.entryHash || null };
  }

  function pendingRecovery() {
    let count = 0;
    for (const name of ['fail-open-pending.ndjson', 'fail-open-pending.ndjson.recovering']) {
      const filename = path.join(dataDir, name);
      try {
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) throw new Error('Recovery queue cannot be counted safely.');
        // These are physical queue records, not signed or verified decisions.
        // Do not parse, return, replay, or write their payloads from this reader.
        count += fs.readFileSync(filename, 'utf8').split('\n').filter(line => line.trim()).length;
      } catch (error) { if (error.code !== 'ENOENT') throw new Error('Recovery queue cannot be read.'); }
    }
    return { pendingAuditRecovery: count > 0, pendingFailOpenEvents: count, pendingRecoveryStatus: count ? 'unsigned_unverified' : 'none' };
  }

  function license(args, entries) {
    let config;
    try { config = readPolicy(dataDir); }
    catch { return {tier: 'free', mode: 'shadow', reason: 'license_required', paid: false, seatsUsed: null, seatLimit: null, seatStorage: null, seatsVerified: false, expiresAt: null, source: 'policy_unavailable'}; }
    const sessionId = args.sessionId || process.env.CODEX_THREAD_ID || entries.at(-1)?.decision.plugin?.sessionId || 'local';
    const parameters = {data: dataDir, sessionId, policy: config.policy};
    const status = !args.sessionId && !process.env.CODEX_THREAD_ID && !entries.length && args.displayOnly
      ? readLatestLicenseStatus(parameters) : readSessionLicense(parameters);
    const effectivePolicy = status.paid ? config.policy : config.personal;
    return {...status, ...seatEvidence(status), mode: status.paid ? effectivePolicy.mode || 'enforce' : 'shadow'};
  }

  async function call(name, args = {}) {
    assertArgs(name, args);
    const entries = await snapshot();
    if (name === 'verify_chain') return verify(entries);
    if (name === 'get_status') {
      const day = args.day || new Date().toISOString().slice(0, 10);
      const today = entries.filter(entry => entry.decision.timestamp.slice(0, 10) === day);
      const decisions = today.filter(entry => !['outcome', 'settlement'].includes(entry.decision.entryType) && entry.decision.plugin?.event !== 'integrity');
      const health = readHealth({data: dataDir, entries});
      return { license: displayLicense(license({...args, displayOnly: true}, entries)), health, integrityEvents: today.filter(entry => entry.decision.plugin?.event === 'integrity').length, day, timezone: 'UTC', decisions: decisions.length, spendCents: decisions.filter(entry => entry.decision.action !== 'block').reduce((total, entry) => total + (entry.decision.plugin?.chargedCents ?? entry.decision.projectedCents), 0), blocks: decisions.filter(entry => entry.decision.action === 'block').length, failOpenEvents: today.filter(entry => failOpen(entry.decision)).length, outcomes: today.filter(entry => entry.decision.entryType === 'outcome').length, totalEntries: entries.length, ...pendingRecovery() };
    }
    const from = args.fromSequence || 0;
    const limit = args.limit || 100;
    const eligible = entries.filter(entry => entry.sequence >= from);
    const page = eligible.slice(0, limit);
    const nextSequence = eligible.length > page.length ? page.at(-1).sequence + 1 : null;
    if (name === 'list_decisions') return { entries: page.map(summary), nextSequence, totalEntries: entries.length };
    const entitlement = license(args, entries);
    if (!entitlement.paid) {
      const error = new Error('Receipt export requires a paid license.');
      error.code = entitlement.reason || 'license_required';
      throw error;
    }
    const verification = await verify(entries);
    if (!verification.ok) throw new Error('Ledger verification failed; export refused.');
    return { format: 'agentguard-signed-receipts-v1', publicKeyHex: verification.publicKeyHex, verified: true, complete: from === 0 && nextSequence === null, entries: page, nextSequence, totalEntries: entries.length, lastEntryHash: verification.lastEntryHash };
  }
  return { call, filePath: store.filePath };
}

async function handleRpc(request, reader) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (request.id !== undefined && typeof request.id !== 'string' && typeof request.id !== 'number' && request.id !== null)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } };
  if (request.id === undefined) return null;
  const respond = result => ({ jsonrpc: '2.0', id: request.id, result });
  switch (request.method) {
    case 'initialize': return respond({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agentguard', version: require('../package.json').version } });
    case 'ping': return respond({});
    case 'tools/list': return respond({ tools: TOOLS });
    case 'tools/call': {
      try {
        const result = await reader.call(request.params?.name, request.params?.arguments || {});
        return respond({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        if (['license_required', 'seat_limit'].includes(error.code)) return respond({isError: true, content: [{type: 'text', text: `${error.code}: verification is free; receipt export requires a valid paid license and an available seat.`}]});
        // Never return raw filesystem/SDK errors, which could contain contents.
        return respond({ isError: true, content: [{ type: 'text', text: 'Read-only audit request failed: check arguments, ledger integrity, and the public verification key locally.' }] });
      }
    }
    default: return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found.' } };
  }
}

function startServer(reader = createReader()) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  input.on('line', line => {
    pending = pending.then(async () => {
      if (!line.trim()) return;
      let request;
      try { if (Buffer.byteLength(line) > 1024 * 1024) throw new Error(); request = JSON.parse(line); } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON request.' } }) + '\n');
        return;
      }
      const response = await handleRpc(request, reader);
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    }).catch(() => { process.stderr.write('agentguard: read-only MCP request failed.\n'); });
  });
  return input;
}

module.exports = { createReader, handleRpc, startServer, TOOLS };
if (require.main === module) startServer();
