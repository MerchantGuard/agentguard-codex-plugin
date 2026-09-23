'use strict';
const matrix = require('./helper-host-matrix.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sdk = require('@agentguard-run/spend');
const { readPrivate, writeMessage } = require('../runtime/client.cjs');
const root = path.join(__dirname, '..');

function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-hook-no-sockets-'));
  const tag = crypto.createHash('sha256').update(data).digest('hex').slice(0, 24);
  const ipc = path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${tag}`);
  const blocker = path.join(data, 'no-network.cjs');
  const attempts = path.join(data, 'network-attempts');
  fs.writeFileSync(blocker, `
    const fs = require('node:fs');
    const blocked = () => { fs.appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n'); throw new Error('socket_forbidden'); };
    const net = require('node:net');
    net.connect = blocked; net.createConnection = blocked; net.createServer = blocked;
    net.Socket.prototype.connect = blocked; net.Server.prototype.listen = blocked;
    const tls = require('node:tls'); tls.connect = blocked; tls.createServer = blocked;
    for (const name of ['node:http', 'node:https']) {
      const module = require(name); module.request = blocked; module.get = blocked; module.createServer = blocked;
      if (module.Agent) module.Agent.prototype.createConnection = blocked;
    }
    require('node:dgram').createSocket = blocked;
    for (const name of ['node:dns', 'node:dns/promises']) {
      const dns = require(name);
      for (const key of Object.keys(dns)) if (/^(lookup|resolve|reverse)/.test(key)) dns[key] = blocked;
    }
    globalThis.fetch = blocked;
    if (globalThis.WebSocket) globalThis.WebSocket = class { constructor() { blocked(); } };
  `, { mode: 0o600 });
  const env = { ...process.env, PLUGIN_DATA: data, PLUGIN_ROOT: root,
    AGENTGUARD_HOME: path.join(data, 'burn'), AGENTGUARD_PLUGIN_POLICY: path.join(data, 'policy.json'),
    AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0',
    NODE_OPTIONS: `--require=${blocker}` };
  matrix.environment(env, data);
  fs.writeFileSync(env.AGENTGUARD_PLUGIN_POLICY, JSON.stringify({ version: 1, mode: 'enforce', tenantId: 'synthetic-tenant', maxCapability: 'payment_execute', toolRules: [], caps: [] }), { mode: 0o600 });
  t.after(() => {
    spawnSync(process.execPath, ['runtime/control.cjs', 'stop'], { cwd: root, env, timeout: 3000 });
    fs.rmSync(ipc, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
  return { data, ipc, attempts, env };
}

test('Every tool hook records a verified outcome without opening any network or Unix socket', async t => {
  const f = fixture(t);
  const raw = matrix.payload({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'synthetic-offline-call',
    session_id: 'synthetic-offline-session', tool_input: { path: 'PRIVATE_PATH_NOT_FOR_LEDGER' } }, 'PreToolUse', 'Read');
  raw.cwd = f.data; raw.transcript_path = path.join(f.data, 'not-created-yet.jsonl');
  for (const hook of ['session-start', 'burn-gate', 'spend-gate', 'receipt', 'session-end']) {
    const payload = hook === 'receipt' ? { ...raw, hook_event_name: 'PostToolUse', tool_response: { content: 'PRIVATE_OUTPUT_NOT_FOR_LEDGER' }, duration_ms: 3 } : raw;
    const child = spawnSync(process.execPath, [`hooks/${hook}.cjs`], { cwd: root, env: f.env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '', `${hook} must complete its signed path rather than fail open`);
    const output = JSON.parse(child.stdout);
    if (hook === 'session-start') assert.match(output.systemMessage, /AgentGuard presets/);
    else if (['receipt', 'session-end'].includes(hook)) assert.deepEqual(output, {});
    else assert.notEqual(output.hookSpecificOutput?.permissionDecision, 'deny');
  }
  assert.equal(fs.existsSync(f.attempts), false, 'No network API or Unix socket may be attempted');
  const text = fs.readFileSync(path.join(f.data, 'ledger', 'decisions.ndjson'), 'utf8');
  const entries = text.trim().split('\n').map(JSON.parse);
  assert.equal(entries.every(entry => entry.decision.plugin.host === matrix.host), true);
  assert.ok(entries.some(entry => entry.decision.plugin.event === 'decision'));
  const admission = entries.find(entry => entry.decision.plugin.event === 'decision' && entry.decision.plugin.gate === 'spend');
  const outcome = entries.find(entry => entry.decision.plugin.event === 'outcome');
  assert.equal(outcome.decision.originalDecisionId, admission.decision.decisionId);
  assert.equal((await sdk.verifyChain(entries, Buffer.from(fs.readFileSync(path.join(f.data, 'public-key.hex'), 'utf8').trim(), 'hex'))).ok, true);
  assert.equal(/PRIVATE_PATH_NOT_FOR_LEDGER|PRIVATE_OUTPUT_NOT_FOR_LEDGER/.test(text), false);
  assert.equal(fs.lstatSync(path.join(f.ipc, 'worker.ready')).isFile(), true);
  assert.equal(fs.readdirSync(f.ipc).some(name => /\.(request|response)$/.test(name)), false);
  t.diagnostic(`Five hook subprocesses, zero socket attempts, ${entries.length} signed rows, chain valid.`);
});

test('Filesystem IPC rejects symlink messages and messages larger than its fixed bound', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-ipc-safety-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'target'), link = path.join(directory, 'link');
  fs.writeFileSync(target, '{"safe":true}', { mode: 0o600 }); fs.symlinkSync(target, link);
  assert.throws(() => readPrivate(link));
  assert.throws(() => writeMessage(path.join(directory, 'oversized.request'), { value: 'x'.repeat(32768) }), /ipc_message_too_large/);
  assert.equal(fs.existsSync(path.join(directory, 'oversized.request')), false);
  fs.chmodSync(target, 0o644);
  assert.throws(() => readPrivate(target), /ipc_file_not_private/);
});
