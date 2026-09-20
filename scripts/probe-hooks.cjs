#!/usr/bin/env node
'use strict';

// A local synthetic hook probe. It never resolves a live license or calls a
// model. Each measured invocation is checked once; a fail-open is a failure.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sdk = require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/spend');
const burn = require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/burn');
const KEY = 'ag_SYNTHETIC_LOCAL_PROBE_LICENSE';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const round = value => Number(value.toFixed(2));
const readRows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return {min: round(sorted[0]), p50: round(percentile(.5)), p95: round(percentile(.95)), max: round(sorted.at(-1))};
}
function check(value, message) { if (!value) throw new Error(message); }

function preloadText(data, home, diskDelayMs) {
  // The only injected synchronous delay is Burn's two NDJSON appends. Worker
  // fdatasync completion is asynchronous. IPC and policy metadata are untouched.
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const append = fs.appendFileSync.bind(fs);
const sync = fs.fdatasync.bind(fs);
const counters = ${JSON.stringify(path.join(data, 'probe-disk-events.ndjson'))};
const sockets = ${JSON.stringify(path.join(data, 'probe-socket-attempts.ndjson'))};
const targets = new Set(${JSON.stringify([path.join(home, 'receipts.ndjson'), path.join(home, 'decisions.ndjson')])});
const delay = ${diskDelayMs};
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function note(kind) { append(counters, JSON.stringify({kind}) + '\\n'); }
fs.appendFileSync = function(file, ...args) {
  if (delay && typeof file === 'string' && targets.has(path.resolve(file))) {
    note(path.basename(file)); Atomics.wait(sleeper, 0, 0, delay);
  }
  return append(file, ...args);
};
fs.fdatasync = function(fd, callback) {
  if (!delay) return sync(fd, callback);
  note('fdatasync');
  return sync(fd, error => setTimeout(() => callback(error), delay));
};
const forbidden = () => { append(sockets, JSON.stringify({attempt: true}) + '\\n'); throw new Error('Probe sockets are forbidden.'); };
const net = require('node:net');
net.Socket.prototype.connect = forbidden; net.Server.prototype.listen = forbidden;
require('node:tls').connect = forbidden;
require('node:dgram').createSocket = forbidden;
require('node:http').request = forbidden; require('node:http').get = forbidden;
require('node:https').request = forbidden; require('node:https').get = forbidden;
require('node:dns').lookup = forbidden; require('node:dns').resolve = forbidden;
global.fetch = forbidden;
`;
}

async function runProbe({callsPerGate = 12, diskDelayMs = 0} = {}) {
  check(Number.isSafeInteger(callsPerGate) && callsPerGate >= 1 && callsPerGate <= 1000, 'Probe count must be an integer from 1 to 1000.');
  check(Number.isSafeInteger(diskDelayMs) && diskDelayMs >= 0 && diskDelayMs <= 1000, 'Disk delay must be an integer from 0 to 1000 ms.');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-latency-probe-'));
  const home = path.join(data, 'burn');
  const ipc = path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${digest(path.resolve(data)).slice(0, 24)}`);
  const env = {...process.env, PLUGIN_DATA: data, AGENTGUARD_HOME: home,
    AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0'};
  delete env.AGENTGUARD_PLUGIN_POLICY;
  delete env.AGENTGUARD_HOOK_BUDGET_MS;
  const preload = path.join(data, 'probe-preload.cjs');
  env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  const report = {timestamp: new Date().toISOString(), node: process.version, arch: process.arch,
    os: `${os.platform()} ${os.release()}`, loadAverage: os.loadavg().map(round),
    callsPerGate, warmupsExcluded: 2, diskDelayMs, hookBudgetMs: 250,
    timing: 'Hook subprocess wall time includes Node startup; one warmup per gate is excluded.',
    injection: diskDelayMs ? `${diskDelayMs} ms per Burn receipts/decisions append and asynchronous fdatasync callback; no IPC or metadata write delay.` : 'none',
    gates: {}, signedEntries: 0, signedFailOpenEvents: 0, pendingFailOpenEvents: 0, socketAttempts: 0,
    burnReceipts: 0, chainVerified: false, burnChainVerified: false};
  const ledgerFile = path.join(data, 'ledger', 'decisions.ndjson');
  const expected = [];
  try {
    fs.mkdirSync(home, {mode: 0o700});
    fs.writeFileSync(path.join(home, `license-${digest(KEY)}.json`), JSON.stringify({fetchedAt: Date.now(),
      status: {valid: true, tier: 'growth', seats: 50, expiresAt: new Date(Date.now() + 86400000).toISOString(), features: {maxActiveSeats: 50}}}), {mode: 0o600});
    // Model a successful org endpoint 204 without any network in the probe.
    fs.writeFileSync(path.join(data, 'org-policy-status.json'), JSON.stringify({license_fingerprint: digest(KEY),
      status: 'none', reason: null, org_policy_sha256: null, updated_at: new Date().toISOString()}), {mode: 0o600});
    fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, licenseKey: KEY,
      tenantId: 'synthetic-probe', mode: 'enforce', hookBudgetMs: 250, maxCapability: 'payment_execute',
      deniedTools: ['^mcp__synthetic__save_document$'], caps: [], toolRules: [], sessions: {}}), {mode: 0o600});
    const policy = structuredClone(burn.DEFAULT_POLICY);
    policy.mode = 'enforce';
    policy.thresholds.fanout = {warn: callsPerGate + 5, stop: callsPerGate + 10, maxDepth: 10};
    fs.writeFileSync(path.join(home, 'burn-policy.json'), JSON.stringify(policy), {mode: 0o600});
    const transcript = path.join(data, 'synthetic-transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({timestamp: new Date().toISOString(), usage: {input_tokens: 10, output_tokens: 1}}) + '\n', {mode: 0o600});
    fs.writeFileSync(preload, preloadText(data, home, diskDelayMs), {mode: 0o600});

    async function invoke(gate, index, warmup = false) {
      const deny = gate === 'spend' && !warmup && index % 4 === 0;
      const toolName = gate === 'burn' ? 'spawn_agent' : `mcp__synthetic__${deny ? 'save' : 'get'}_document`;
      const toolUseId = `synthetic-probe-${gate}-${warmup ? 'warmup' : index}`;
      const raw = {hook_event_name: 'PreToolUse', session_id: `synthetic-probe-${gate}`, tool_use_id: toolUseId,
        tool_name: toolName, tool_input: {probe: true}, cwd: data, transcript_path: transcript};
      const started = performance.now();
      const child = spawnSync(process.execPath, [path.join(root, 'hooks', `${gate}-gate.cjs`)], {
        input: JSON.stringify(raw), encoding: 'utf8', env, timeout: 10000});
      const elapsed = performance.now() - started;
      check(child.status === 0, `${gate} call ${index} exited unsuccessfully: ${child.stderr || child.error?.message || child.status}`);
      const output = JSON.parse(child.stdout);
      check(child.stderr === '', `${gate} call ${index} emitted a warning: ${child.stderr.trim()}`);
      check(output.hookSpecificOutput?.permissionDecision === (deny ? 'deny' : 'allow'), `${gate} call ${index} returned the wrong decision.`);
      const rows = readRows(ledgerFile);
      const own = rows.filter(row => row.decision.plugin?.toolUseId === toolUseId);
      check(own.length === 1, `${gate} call ${index} must produce exactly one signed row.`);
      check(own[0].decision.plugin.event === 'decision', `${gate} call ${index} produced a fail-open instead of a normal decision.`);
      check(own[0].decision.action === (deny ? 'block' : 'allow'), `${gate} call ${index} ledger action is wrong.`);
      check(own[0].decision.plugin.license?.paid === true, `${gate} call ${index} did not exercise paid enforcement.`);
      expected.push(toolUseId);
      return elapsed;
    }

    for (const gate of ['spend', 'burn']) {
      await invoke(gate, -1, true);
      const measurements = [];
      for (let i = 0; i < callsPerGate; i++) measurements.push(await invoke(gate, i));
      report.gates[gate] = {count: measurements.length, failOpen: 0, signedDecisions: measurements.length, wallMs: stats(measurements)};
    }
    const rows = readRows(ledgerFile);
    check(rows.length === expected.length, 'The chain row count differs from successful hook calls.');
    check(new Set(rows.map(row => row.decision.plugin.toolUseId)).size === expected.length, 'Duplicate hook decision identities were recorded.');
    report.signedEntries = rows.length;
    report.signedFailOpenEvents = rows.filter(row => row.decision.plugin.event === 'fail_open').length;
    report.pendingFailOpenEvents = ['fail-open-pending.ndjson', 'fail-open-pending.ndjson.recovering'].reduce((count, filename) => count + readRows(path.join(data, filename)).length, 0);
    const key = Buffer.from(fs.readFileSync(path.join(data, 'public-key.hex'), 'utf8').trim(), 'hex');
    report.chainVerified = (await sdk.verifyChain(rows, key)).ok;
    check(report.chainVerified, 'Signed decision chain failed verification.');
    const receipts = readRows(path.join(home, 'receipts.ndjson'));
    report.burnReceipts = receipts.length;
    let previous = null;
    report.burnChainVerified = receipts.every(receipt => {
      const valid = burn.verifyReceipt(receipt) && receipt.payload.previous === previous;
      previous = burn.receiptDigest(receipt); return valid;
    });
    check(receipts.length === callsPerGate + 1 && report.burnChainVerified, 'Burn receipt count or chain is invalid.');
    report.socketAttempts = readRows(path.join(data, 'probe-socket-attempts.ndjson')).length;
    check(report.socketAttempts === 0 && report.signedFailOpenEvents === 0 && report.pendingFailOpenEvents === 0, 'Probe recorded a socket attempt or fail-open.');
    const diskEvents = readRows(path.join(data, 'probe-disk-events.ndjson'));
    report.diskOperations = Object.fromEntries(['fdatasync', 'receipts.ndjson', 'decisions.ndjson'].map(kind => [kind, diskEvents.filter(event => event.kind === kind).length]));
    if (diskDelayMs) {
      check(report.diskOperations.fdatasync > 0, 'The asynchronous fdatasync delay was never exercised.');
      check(report.diskOperations['receipts.ndjson'] === callsPerGate + 1 && report.diskOperations['decisions.ndjson'] === callsPerGate + 1,
        'The two synchronous Burn append delays were not exercised for every spawn.');
    }
    return report;
  } finally {
    spawnSync(process.execPath, [path.join(root, 'runtime', 'control.cjs'), 'stop'], {env, timeout: 5000, encoding: 'utf8'});
    // The control response comes from this private worker, never a personal one.
    const until = Date.now() + 2000;
    while (fs.existsSync(path.join(ipc, 'worker.ready')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    check(!fs.existsSync(path.join(ipc, 'worker.ready')), 'Probe worker did not stop; scratch retained for inspection.');
    fs.rmSync(data, {recursive: true, force: true});
    fs.rmSync(ipc, {recursive: true, force: true});
  }
}
function formatReport(report) {
  const lines = [`AgentGuard local hook probe ${report.timestamp}`, `Node ${report.node} ${report.arch} | ${report.os} | load ${report.loadAverage.join(', ')}`,
    `${report.warmupsExcluded} warmups excluded | configured hook budget ${report.hookBudgetMs} ms | ${report.timing}`, `Disk injection: ${report.injection}`];
  for (const [gate, value] of Object.entries(report.gates)) lines.push(`${gate}: count=${value.count} fail-open=${value.failOpen} signed=${value.signedDecisions} wall ms min=${value.wallMs.min} p50=${value.wallMs.p50} p95=${value.wallMs.p95} max=${value.wallMs.max}`);
  lines.push(`Ledger: ${report.signedEntries} signed entries including warmups; fail-open=${report.signedFailOpenEvents}; pending=${report.pendingFailOpenEvents}; chain valid=${report.chainVerified}`,
    `Burn: ${report.burnReceipts} signed receipts; chain valid=${report.burnChainVerified}; socket attempts=${report.socketAttempts}`);
  if (report.diskDelayMs) lines.push(`Injected operations: ${JSON.stringify(report.diskOperations)}`);
  return lines.join('\n');
}
module.exports = {runProbe, formatReport};
if (require.main === module) {
  const count = process.argv[2] === undefined ? 12 : Number(process.argv[2]);
  if (process.argv.length > 3) { process.stderr.write('Usage: node scripts/probe-hooks.cjs COUNT\n'); process.exitCode = 1; }
  else runProbe({callsPerGate: count}).then(report => process.stdout.write(formatReport(report) + '\n'))
    .catch(error => {process.stderr.write(`AgentGuard hook probe failed: ${error.message}\n`); process.exitCode = 1;});
}
