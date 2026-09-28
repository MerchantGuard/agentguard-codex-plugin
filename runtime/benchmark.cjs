'use strict';
// Benchmark transport is local and unsigned. The external collector verifies
// coverage and signs these canonical events after the agent loses access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {RULES, scanGuardPack, guardResult} = require('./guard-pack.cjs');
const {canonicalize} = require('./org-policy-contract.cjs');
const {outcomeSuccess, locations} = require('./common.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const HEX = /^[a-f0-9]{64}$/;
const WARN = 'agentguard: benchmark measurement incomplete; execution remains allowed.\n';
const CONSENT_WARN = 'agentguard: benchmark consent missing for this run; normal enforcement applies.\n';
const CONSENT_FILE = 'benchmark-consent.json';
const enabled = (env = process.env) => env.AGENTGUARD_BENCHMARK === '1';

function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('benchmark_identity_invalid');
  return value;
}
function context(env) {
  const depthText = env.AGENTGUARD_BENCH_SPAWN_DEPTH;
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(depthText ?? '')) throw new Error('benchmark_identity_invalid');
  const parent = env.AGENTGUARD_BENCH_PARENT_AGENT_ID ? identifier(env.AGENTGUARD_BENCH_PARENT_AGENT_ID) : null;
  const depth = Number(depthText), agent = identifier(env.AGENTGUARD_BENCH_AGENT_ID);
  if (depth === 0 && parent !== null || depth > 0 && parent === null || parent === agent) throw new Error('benchmark_identity_invalid');
  return {run_id: identifier(env.AGENTGUARD_BENCH_RUN_ID), agent_id: agent, parent_agent_id: parent, spawn_depth: depth};
}
function absolute(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) throw new Error('benchmark_path_invalid');
  return file;
}
function readPolicy(env) {
  const file = absolute(env.AGENTGUARD_BENCH_POLICY_FILE);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let policy;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error('benchmark_policy_invalid');
    policy = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  const expected = env.AGENTGUARD_BENCH_POLICY_HASH;
  if (!HEX.test(expected ?? '') || hash(canonicalize(policy)) !== expected) throw new Error('benchmark_policy_hash_mismatch');
  const scannerHash = hash(fs.readFileSync(path.join(__dirname, 'guard-pack.cjs')));
  if (policy?.version !== 1 || policy.enforced !== false || policy.scanner_sha256 !== scannerHash
    || !Array.isArray(policy.rules) || policy.rules.length !== RULES.length) throw new Error('benchmark_policy_invalid');
  const config = {rules: {}};
  for (const [index, expectedRule] of RULES.entries()) {
    const rule = policy.rules[index];
    if (!rule || Object.keys(rule).sort().join(',') !== 'action,id,pattern,reason'
      || rule.id !== expectedRule.id || rule.pattern !== expectedRule.pattern || rule.reason !== expectedRule.reason
      || !['stop', 'warn', 'off'].includes(rule.action)) throw new Error('benchmark_policy_invalid');
    config.rules[rule.id] = rule.action;
  }
  return {policyHash: expected, config};
}
function append(file, events) {
  const fd = fs.openSync(absolute(file), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || process.getuid && stat.uid !== process.getuid()) throw new Error('benchmark_transport_invalid');
    const bytes = Buffer.from(events.map(event => canonicalize(event)).join('\n') + '\n');
    if (fs.writeSync(fd, bytes) !== bytes.length) throw new Error('benchmark_transport_incomplete');
  } finally { fs.closeSync(fd); }
}
function incomplete(env) {
  try { append(absolute(env.AGENTGUARD_BENCH_EVENTS_FILE) + '.incomplete', [{reason: 'benchmark_measurement_incomplete'}]); } catch { /* The collector also requires full hook coverage. */ }
  process.stderr.write(WARN);
}
function observe(gate, raw, options = {}) {
  const env = options.env ?? process.env;
  if (!enabled(env)) throw new Error('benchmark_mode_required');
  // The portable hook list runs both gates on every call. One gate owns all
  // benchmark decisions, including spawn tools, so it cannot count twice.
  if (gate === 'burn') return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('benchmark_payload_invalid');
  const identity = context(env), timestamp = (options.now ?? (() => new Date()))().toISOString();
  if (raw.agent_id !== undefined && raw.agent_id !== identity.agent_id) throw new Error('benchmark_identity_mismatch');
  const sessionId = identifier(raw.session_id ?? raw.sessionId);
  const toolCallId = ['spend', 'receipt'].includes(gate) ? identifier(raw.tool_use_id) : null;
  const event = (type, data) => ({schema_version: 1,
    event_id: hash(canonicalize([identity.run_id, identity.agent_id, sessionId, toolCallId, type])),
    type, timestamp, ...identity, data});
  let events;
  if (gate === 'session-start') events = [event('session_start', {session_id: sessionId})];
  else if (gate === 'session-end') events = [event('session_end', {session_id: sessionId})];
  else if (gate === 'receipt') events = [event('tool_result', {tool_call_id: toolCallId,
    success: outcomeSuccess(raw, identifier(raw.tool_name)),
    ...(Number.isFinite(raw.duration_ms) && raw.duration_ms >= 0 ? {duration_ms: raw.duration_ms} : {})})];
  else if (gate === 'spend') {
    const tool = identifier(raw.tool_name), input = raw.tool_input ?? {};
    const {policyHash, config} = readPolicy(env);
    const scan = scanGuardPack(tool, input, {cwd: raw.cwd});
    const result = guardResult(scan.ruleIds, config, 'enforce');
    events = [event('tool_request', {tool_call_id: toolCallId, tool_name: tool, input_sha256: hash(canonicalize(input))}),
      event('policy_decision', {tool_call_id: toolCallId, classification: result.stop ? 'STOP' : result.warning || scan.reason ? 'WARN' : 'CLEAN',
        rule_ids: scan.ruleIds, policy_hash: policyHash, enforced: false, ...(scan.reason ? {uncertainty: scan.reason} : {})})];
    if (scan.reason) incomplete(env);
  } else throw new Error('benchmark_gate_invalid');
  append(env.AGENTGUARD_BENCH_EVENTS_FILE, events);
  return events;
}
// The environment switch alone never weakens Enforce. Benchmark mode applies
// only when the operator recorded consent for this run id as a signed row in
// the plugin's own ledger (policy-cli benchmark on <run-id>, from their
// terminal; the agent cannot run that verb). The hook checks the consent file,
// the ledger row it names, its signature under the worker's public key, and
// that no later row revoked it. Anything else falls through to normal
// enforcement and leaves an incomplete-measurement marker.
async function consent(env = process.env, data = locations().data) {
  const runId = env.AGENTGUARD_BENCH_RUN_ID;
  if (typeof runId !== 'string' || !ID.test(runId)) return false;
  let record;
  try {
    const fd = fs.openSync(path.join(data, CONSENT_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || process.getuid && stat.uid !== process.getuid()) return false;
      record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  if (!record || typeof record !== 'object' || record.version !== 1 || record.run_id !== runId
    || !Number.isSafeInteger(record.sequence) || record.sequence < 0 || !HEX.test(record.entry_hash ?? '')) return false;
  let publicKey, lines;
  try {
    publicKey = fs.readFileSync(path.join(data, 'public-key.hex'), 'utf8').trim();
    lines = fs.readFileSync(path.join(data, 'ledger', 'decisions.ndjson'), 'utf8').split('\n');
  } catch { return false; }
  if (!HEX.test(publicKey)) return false;
  let granted = null;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { return false; }
    const meta = entry?.decision?.plugin;
    if (!meta || meta.event !== 'benchmark_consent' || meta.runId !== runId) continue;
    if (entry.sequence === record.sequence) {
      if (entry.entryHash !== record.entry_hash || meta.granted !== true) return false;
      const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
      if (!(await sdk.verifyEntry(entry, Buffer.from(publicKey, 'hex')))) return false;
      granted = true;
    } else if (granted === true && entry.sequence > record.sequence && meta.granted === false) return false;
  }
  return granted === true;
}
async function run(gate, text) {
  if (!(await consent().catch(() => false))) {
    try { append(absolute(process.env.AGENTGUARD_BENCH_EVENTS_FILE) + '.incomplete', [{reason: 'benchmark_consent_missing'}]); } catch { /* The collector also requires consent. */ }
    process.stderr.write(CONSENT_WARN);
    return false;
  }
  try { observe(gate, JSON.parse(text ?? fs.readFileSync(0, 'utf8'))); }
  catch { incomplete(process.env); }
  // No explicit allow override, denial, worker, license reader or socket.
  process.stdout.write('{}\n');
  return true;
}
module.exports = {enabled, context, readPolicy, observe, consent, run, CONSENT_FILE};
