'use strict';
const {LICENSE_KEY, seedPaidLicense} = require('./helper-paid-license.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sdk = require('@agentguard-run/spend');
const { createReader, handleRpc, TOOLS } = require('../runtime/mcp.cjs');

const licenseHomes = new WeakMap();
async function fixture(t, specs = [{ action: 'allow', projectedCents: 5 }]) {
  if (!licenseHomes.has(t)) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-mcp-license-'));
    const prior = {AGENTGUARD_HOME: process.env.AGENTGUARD_HOME, AGENTGUARD_LICENSE_KEY: process.env.AGENTGUARD_LICENSE_KEY, AGENTGUARD_PLUGIN_POLICY: process.env.AGENTGUARD_PLUGIN_POLICY};
    process.env.AGENTGUARD_HOME = home;
    process.env.AGENTGUARD_LICENSE_KEY = '';
    delete process.env.AGENTGUARD_PLUGIN_POLICY;
    seedPaidLicense(home);
    licenseHomes.set(t, home);
    t.after(() => {
      for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
      fs.rmSync(home, {recursive: true, force: true});
    });
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-mcp-reader-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', licenseKey: LICENSE_KEY}));
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKeyHex = publicKey.toString('hex');
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), publicKeyHex);
  const store = new sdk.NdjsonDecisionLogStore('ledger', { home: dataDir, publicKeyHex });
  let previousHash = '0'.repeat(64);
  const entries = [];
  for (const spec of specs) {
    const sequence = entries.length;
    const decision = { decisionId: `synthetic-decision-${sequence}`, timestamp: new Date().toISOString(), action: 'allow', triggeredCap: null, triggeredScopeKey: null, projectedCents: 0, windowSpendBefore: 0, windowSpendAfter: 0, provider: 'imanage', modelRequested: 'save_document', modelResolved: 'save_document', policyId: 'synthetic-policy', policyVersion: 1, enforcementMode: 'enforce', reasons: ['Synthetic fixture decision.'], actor: { agentId: 'synthetic-agent', sessionId: 'synthetic-session' }, plugin: { schema: 'agentguard.codex.v1', event: 'decision', toolName: 'mcp__imanage__save_document', inputSha256: '0'.repeat(64), inputBytes: 21, gate: 'spend' }, ...spec };
    const entry = await sdk.signDecision({ sequence, decision, previousHash, privateKey, publicKey });
    await store.append(entry);
    entries.push(entry);
    previousHash = entry.entryHash;
  }
  return { dataDir, store, publicKey, publicKeyHex, entries, reader: createReader({ dataDir }) };
}

test('MCP exposes exactly four read-only tools and negotiates initialization', async () => {
  assert.deepEqual(TOOLS.map(tool => tool.name), ['get_status', 'list_decisions', 'verify_chain', 'export_receipts']);
  for (const tool of TOOLS) assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const response = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, {});
  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}), null);
});

test('MCP daily status counts unit spend once and includes blocks and fail-open events', async t => {
  const { reader } = await fixture(t, [
    { projectedCents: 5 },
    { action: 'block', projectedCents: 20 },
    { entryType: 'outcome', projectedCents: 5, originalDecisionId: 'synthetic-decision-0' },
    { plugin: { schema: 'agentguard.codex.v1', event: 'fail_open', gate: 'spend', reasonCode: 'policy_invalid' } },
  ]);
  const result = await reader.call('get_status');
  assert.deepEqual({ decisions: result.decisions, spendCents: result.spendCents, blocks: result.blocks, failOpenEvents: result.failOpenEvents, outcomes: result.outcomes }, { decisions: 3, spendCents: 5, blocks: 1, failOpenEvents: 1, outcomes: 1 });
});

test('MCP list is bounded and paginated and rejects filesystem arguments', async t => {
  const { reader } = await fixture(t, [{}, {}, {}]);
  const first = await reader.call('list_decisions', { limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal(first.nextSequence, 2);
  const next = await reader.call('list_decisions', { fromSequence: first.nextSequence });
  assert.equal(next.entries.length, 1);
  assert.equal(next.nextSequence, null);
  assert.equal(next.entries[0].toolName, 'mcp__imanage__save_document');
  await assert.rejects(reader.call('list_decisions', { limit: 201 }));
  await assert.rejects(reader.call('export_receipts', { path: '/tmp/should-not-be-written' }));
  await assert.rejects(reader.call('get_status', { day: '2026-02-30' }));
});

test('MCP verifies and exports exact signed records without writing files or keys', async t => {
  const { reader, dataDir, publicKey } = await fixture(t, [{}, {}]);
  const before = fs.readdirSync(dataDir, { recursive: true }).sort();
  const result = await reader.call('verify_chain');
  assert.equal(result.ok, true);
  assert.equal(result.entries, 2);
  const bundle = await reader.call('export_receipts');
  assert.equal(bundle.complete, true);
  assert.equal(bundle.verified, true);
  assert.equal((await sdk.verifyChain(bundle.entries, publicKey)).ok, true);
  assert.equal(JSON.stringify(bundle).includes('privateKey'), false);
  assert.deepEqual(fs.readdirSync(dataDir, { recursive: true }).sort(), before);
});

test('MCP reports tampering and refuses an unverifiable receipt export', async t => {
  const { reader, store } = await fixture(t);
  const row = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  row.decision.actor.agentId = 'different-synthetic-agent';
  fs.writeFileSync(store.filePath, JSON.stringify(row) + '\n');
  assert.equal((await reader.call('verify_chain')).ok, false);
  await assert.rejects(reader.call('export_receipts'), /verification failed/);
});

test('MCP rejects malformed physical NDJSON that the SDK read adapter would skip', async t => {
  const { reader, store } = await fixture(t);
  fs.appendFileSync(store.filePath, '{broken\n');
  await assert.rejects(reader.call('verify_chain'), /malformed JSON/);
});

test('MCP refuses content and unknown fields and does not echo raw error details', async t => {
  const { reader, store } = await fixture(t);
  const row = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  row.decision.plugin.tool_input = { document: 'synthetic-private-content-must-not-escape' };
  fs.writeFileSync(store.filePath, JSON.stringify(row) + '\n');
  const response = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_decisions' } }, reader);
  assert.equal(response.result.isError, true);
  assert.equal(JSON.stringify(response).includes('synthetic-private-content'), false);
  row.decision.plugin = { unknownField: 'synthetic-private-content-must-not-escape' };
  fs.writeFileSync(store.filePath, JSON.stringify(row) + '\n');
  await assert.rejects(reader.call('export_receipts'));
});

test('MCP empty ledger remains read-only and public-key substitution is rejected', async t => {
  const { dataDir, reader } = await fixture(t, []);
  assert.equal((await reader.call('get_status')).totalEntries, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'ledger')), false);
  const populated = await fixture(t);
  fs.writeFileSync(path.join(populated.dataDir, 'public-key.hex'), '11'.repeat(32));
  await assert.rejects(populated.reader.call('verify_chain'), /signer/);
});

test('MCP subprocess speaks JSON-RPC stdio, handles invalid JSON, and has no write tools', async t => {
  const { dataDir } = await fixture(t);
  const requests = [
    '{broken',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'verify_chain' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write_policy', arguments: {} } }),
  ].join('\n') + '\n';
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'runtime', 'mcp.cjs')], { input: requests, encoding: 'utf8', env: { ...process.env, PLUGIN_DATA: dataDir }, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(output[0].error.code, -32700);
  assert.equal(output[1].result.tools.length, 4);
  assert.equal(output[2].result.structuredContent.ok, true);
  assert.equal(output[3].result.isError, true);
});

test('MCP reports unsigned recovery queues separately without parsing or importing them', async t => {
  const { dataDir, reader, store } = await fixture(t, [
    { projectedCents: 5 },
    { plugin: { schema: 'agentguard.codex.v1', event: 'fail_open', gate: 'spend', reasonCode: 'synthetic_failure' } },
  ]);
  fs.writeFileSync(path.join(dataDir, 'fail-open-pending.ndjson'), '{"synthetic":"must-not-return-this-payload"}\n\n{not-valid-json\n');
  fs.writeFileSync(path.join(dataDir, 'fail-open-pending.ndjson.recovering'), '{"synthetic":"interrupted-batch"}\n');
  const ledgerBefore = fs.readFileSync(store.filePath, 'utf8');
  const result = await reader.call('get_status');
  assert.equal(result.pendingAuditRecovery, true);
  assert.equal(result.pendingFailOpenEvents, 3);
  assert.equal(result.pendingRecoveryStatus, 'unsigned_unverified');
  assert.equal(result.failOpenEvents, 1);
  assert.equal(result.totalEntries, 2);
  assert.equal(JSON.stringify(result).includes('must-not-return-this-payload'), false);
  assert.equal(fs.readFileSync(store.filePath, 'utf8'), ledgerBefore);
  assert.equal((await reader.call('verify_chain')).ok, true);
});
