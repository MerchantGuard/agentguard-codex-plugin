'use strict';
const matrix = require('./helper-host-matrix.cjs');
const {LICENSE_KEY, seedPaidLicense} = require('./helper-paid-license.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const sdk = require('@agentguard-run/spend');
const burn = require('@agentguard-run/burn');
const { Engine } = require('../runtime/engine.cjs');
const { metadata } = require('../runtime/common.cjs');
const recorded = matrix.payloads(require('./fixtures/codex-0.151.0-pretooluse.json').payloads);

function setup(t, thresholds = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-burn-hook-'));
  const home = path.join(data, 'burn');
  fs.mkdirSync(home);
  seedPaidLicense(home, LICENSE_KEY, data);
  const env = { ...process.env, PLUGIN_DATA: data, AGENTGUARD_HOME: home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0' };
  matrix.environment(env, data);
  delete env.AGENTGUARD_PLUGIN_POLICY;
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({ licenseKey: LICENSE_KEY, version: 1, tenantId: 'synthetic-local', mode: 'enforce', maxCapability: 'payment_execute', deniedTools: ['^spawn_agent$'], caps: [] }));
  const policy = structuredClone(burn.DEFAULT_POLICY);
  policy.mode = 'enforce';
  policy.thresholds.fanout = { warn: 1, stop: 1, maxDepth: 2 };
  Object.assign(policy.thresholds, thresholds);
  fs.writeFileSync(path.join(home, 'burn-policy.json'), JSON.stringify(policy));
  const ipc = path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${createHash('sha256').update(path.resolve(data)).digest('hex').slice(0, 24)}`);
  t.after(() => {
    spawnSync(process.execPath, [path.join(__dirname, '..', 'runtime', 'control.cjs'), 'stop'], { env, timeout: 5000 });
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(ipc, { recursive: true, force: true });
  });
  const invoke = (name, raw, { expectedWarning = false } = {}) => {
    const child = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', name + '.cjs')], { env, input: JSON.stringify(raw), encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    if (!expectedWarning) assert.equal(child.stderr, '', 'A normal hook call must not fail open.');
    return { output: JSON.parse(child.stdout), stderr: child.stderr };
  };
  const read = filename => fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { data, home, ipc, env, invoke, timeouts: 0, rows: () => read(path.join(data, 'ledger', 'decisions.ndjson')), receipts: () => read(path.join(home, 'receipts.ndjson')), read };
}
function payloads(f, tokens, attempt = 0) {
  const spawn = structuredClone(recorded.find(raw => raw.tool_name === matrix.spawnTool));
  const bash = structuredClone(recorded.find(raw => raw.tool_name === 'Bash'));
  const transcript = path.join(f.data, 'synthetic-transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify(matrix.transcript(tokens)) + '\n');
  for (const raw of [spawn, bash]) { raw.session_id = `synthetic-burn-session-${attempt}`; raw.tool_use_id += `_${attempt}`; raw.transcript_path = transcript; raw.cwd = f.data; }
  return { spawn, bash };
}
const permission = result => matrix.permission(result.output);
const verify = async f => assert.equal((await sdk.verifyChain(f.rows(), Buffer.from(fs.readFileSync(path.join(f.data, 'public-key.hex'), 'utf8').trim(), 'hex'))).ok, true);

async function recoverTimeout(f, result, raw, gate) {
  if (!result.stderr) return false;
  // Only the deliberately busy-worker test invokes this recovery helper.
  // Normal admission and denial tests never retry an unexpected fail-open.
  assert.match(result.stderr, /^agentguard: internal error; allowed tool call; audit recovery queued when storage is writable\.\n$/);
  if (gate === 'receipt') assert.deepEqual(result.output, {});
  else assert.equal(permission(result), 'allow');
  const queued = ['fail-open-pending.ndjson', 'fail-open-pending.ndjson.recovering'].flatMap(name => f.read(path.join(f.data, name)));
  assert.equal(queued.some(item => item.toolUseId === raw.tool_use_id && item.gate === gate && item.event === 'fail_open'), true, 'Timed-out hook must queue its fail-open event.');
  f.timeouts++;
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 40));
    // A spend-side spawn bypass wakes the worker without creating a new Burn
    // reservation or an unrelated charged decision.
    const wake = { ...raw, tool_name: 'spawn_agent', tool_use_id: `synthetic-recovery-${f.timeouts}-${i}` };
    const recovery = f.invoke('spend-gate', wake, {expectedWarning: true});
    assert.equal(permission(recovery), 'allow');
    if (recovery.stderr) assert.match(recovery.stderr,
      /^agentguard: fail-open rate [0-9.]+% in the last hour \(\d+\/\d+ gate calls\); cause: worker_timeout\.\n$/);
    if (f.rows().some(row => row.decision.plugin.event === 'fail_open' && row.decision.plugin.toolUseId === raw.tool_use_id && row.decision.plugin.gate === gate)) {
      await verify(f);
      return true;
    }
  }
  assert.fail('Queued fail-open event was not recovered into the signed chain.');
}

test('Burn hook subprocess observes the recorded Bash shape and admits then denies spawns at the existing cap', async t => {
  const f = setup(t);
  const { spawn: admitted, bash } = payloads(f, 15);
  const bypass = f.invoke('spend-gate', admitted);
  assert.equal(permission(bypass), 'allow');
  assert.equal(f.rows().length, 0);
  assert.equal(permission(f.invoke('burn-gate', bash)), 'allow');
  assert.equal(permission(f.invoke('burn-gate', admitted)), 'allow');
  const allowed = f.rows().find(row => row.decision.plugin.gate === 'burn' && row.decision.plugin.toolUseId === admitted.tool_use_id)?.decision;
  assert.ok(allowed, 'The first call must produce its normal signed Burn decision.');
  assert.equal(allowed.plugin.event, 'decision');
  assert.equal(allowed.action, 'allow');
  const postRaw = { ...admitted, hook_event_name: 'PostToolUse', duration_ms: 9, tool_response: { agent_id: 'synthetic-child', text: 'SYNTHETIC_OUTPUT_MUST_NOT_APPEAR' } };
  assert.deepEqual(f.invoke('receipt', postRaw).output, {});
  assert.equal(f.rows().some(row => row.decision.entryType === 'outcome' && row.decision.originalDecisionId === allowed.decisionId), true);
  const deniedRaw = { ...admitted, tool_use_id: 'call_SYNTHETIC_DENIED_SPAWN' };
  const denied = f.invoke('burn-gate', deniedRaw);
  assert.equal(permission(denied), 'deny');
  assert.equal(denied.output.hookSpecificOutput.permissionDecisionReason.includes('\n'), false);
  const deniedDecision = f.rows().find(row => row.decision.plugin.toolUseId === deniedRaw.tool_use_id)?.decision;
  assert.ok(deniedDecision, 'The capped call must produce its normal signed denial.');
  assert.equal(deniedDecision.plugin.event, 'decision');
  assert.equal(deniedDecision.action, 'block');
  const receipts = f.receipts();
  assert.equal(receipts.length, 2);
  assert.equal(receipts.every(receipt => burn.verifyReceipt(receipt)), true);
  const tips = new Map();
  for (const receipt of receipts) {
    assert.equal(receipt.payload.previous, tips.get(receipt.payload.sessionDigest) ?? null);
    tips.set(receipt.payload.sessionDigest, burn.receiptDigest(receipt));
  }
  assert.equal(receipts.find(receipt => receipt.payload.decisionId === allowed.plugin.burnReceiptId).payload.blocked, false);
  assert.equal(receipts.find(receipt => receipt.payload.decisionId === deniedDecision.plugin.burnReceiptId).payload.blocked, true);
  const gateway = new burn.Gateway(f.home, { sign: false });
  assert.equal(gateway.sessions().find(session => session.sessionId === admitted.session_id).state.totalTokens, 15);
  const rows = f.rows();
  assert.equal(rows.every(row => row.decision.plugin.host === matrix.host), true);
  assert.equal(rows.length, 3);
  assert.equal(rows.some(row => row.decision.plugin.event === 'fail_open'), false);
  await verify(f);
  assert.equal(JSON.stringify(rows).includes('SYNTHETIC_OUTPUT_MUST_NOT_APPEAR'), false);
  assert.equal(JSON.stringify(rows).includes('SYNTHETIC_TRANSCRIPT_CONTENT_MUST_NOT_APPEAR'), false);
  t.diagnostic('Burn allow, outcome and deny: 3 signed rows, 0 fail-open events, no retries.');
});

test('Burn hook subprocess preserves sustained-burn enforcement from observed transcript usage', async t => {
  const f = setup(t, { fanout: { warn: 24, stop: 40, maxDepth: 2 }, sustained: { warnTokens: 100, stopTokens: 200 } });
  const { spawn, bash } = payloads(f, 201);
  assert.equal(permission(f.invoke('burn-gate', bash)), 'allow');
  assert.equal(permission(f.invoke('burn-gate', spawn)), 'deny');
  const selected = f.rows().find(row => row.decision.plugin.toolUseId === spawn.tool_use_id)?.decision;
  assert.ok(selected, 'The sustained-burn call must deny on its first attempt.');
  assert.equal(selected.plugin.event, 'decision');
  const receipt = f.receipts().find(value => value.payload.decisionId === selected.plugin.burnReceiptId);
  assert.equal(receipt.payload.blocked, true);
  assert.equal(receipt.payload.measured.sessionTokens, 201);
  assert.equal(receipt.payload.reasons.some(reason => /sustained/i.test(reason)), true);
  assert.equal(burn.verifyReceipt(receipt), true);
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows().some(row => row.decision.plugin.event === 'fail_open'), false);
  await verify(f);
  t.diagnostic('Sustained-burn deny: 1 signed row, 0 fail-open events, no retries.');
});

test('Corrupted spend policy through the subprocess exits zero, allows, warns once, and signs fail-open', async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.data, 'policy.json'), 'SYNTHETIC_BROKEN_POLICY_MUST_NOT_APPEAR');
  const raw = { ...recorded.find(item => item.tool_name === 'Bash'), transcript_path: path.join(f.data, 'absent.jsonl'), cwd: f.data };
  const result = f.invoke('spend-gate', raw, { expectedWarning: true });
  assert.equal(permission(result), 'allow');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, /fail-open event recorded/);
  const rows = f.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision.plugin.event, 'fail_open');
  assert.equal(JSON.stringify(rows).includes('SYNTHETIC_BROKEN_POLICY_MUST_NOT_APPEAR'), false);
  assert.equal((await sdk.verifyChain(rows, Buffer.from(fs.readFileSync(path.join(f.data, 'public-key.hex'), 'utf8').trim(), 'hex'))).ok, true);
});

test('An intentionally busy worker times out safely and its queued event becomes a verified signed record', async t => {
  const f = setup(t);
  fs.mkdirSync(f.ipc, { recursive: true, mode: 0o700 });
  // An inert owner represents a busy worker. No test or hook needs a socket.
  fs.writeFileSync(path.join(f.ipc, 'worker.lock'), String(process.pid), { mode: 0o600 });
  fs.writeFileSync(path.join(f.ipc, 'worker.ready'), JSON.stringify({ pid: process.pid, transport: 'files-v1' }), { mode: 0o600 });
  const raw = { ...recorded.find(item => item.tool_name === 'Bash'), tool_use_id: 'synthetic-busy-worker-call', transcript_path: path.join(f.data, 'absent.jsonl'), cwd: f.data };
  let childResult;
  try {
    childResult = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'hooks', 'spend-gate.cjs')], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Busy-worker subprocess did not exit.')); }, 5000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      child.stdin.end(JSON.stringify(raw));
    });
  } finally {
    fs.unlinkSync(path.join(f.ipc, 'worker.lock'));
    fs.unlinkSync(path.join(f.ipc, 'worker.ready'));
  }
  assert.equal(childResult.code, 0);
  const result = { output: JSON.parse(childResult.stdout), stderr: childResult.stderr };
  assert.equal(await recoverTimeout(f, result, raw, 'spend'), true);
  assert.equal(f.timeouts, 1);
  const recovered = f.rows().find(row => row.decision.plugin.toolUseId === raw.tool_use_id);
  assert.equal(recovered.decision.plugin.event, 'fail_open');
  assert.equal(recovered.decision.action, 'allow');
  t.diagnostic('Forced busy-worker timeout: exit 0, allow, one warning, queued fail-open recovered into a verified signed chain.');
});

test('Observation-only Burn failure cannot replace an ordinary tool admission or its outcome link', async t => {
  const f = setup(t);
  const envKeys = [...matrix.envKeys, 'AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) { if (f.env[key] === undefined) delete process.env[key]; else process.env[key] = f.env[key]; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const engine = new Engine(); await engine.init();
  const raw = { ...recorded.find(item => item.tool_name === 'Bash'), session_id: 'synthetic-observation-session', tool_use_id: 'synthetic-observation-call' };
  await engine.handle({ meta: metadata(raw, 'spend') });
  const decisionId = f.rows()[0].decision.decisionId;
  await engine.failure(metadata(raw, 'burn'), 'synthetic_observation_error');
  // Replay the same signed history to cover worker restart as well as the
  // live pending-map behavior.
  await engine.flush();
  const restarted = new Engine(); await restarted.init();
  await restarted.handle({ meta: metadata({ ...raw, tool_response: { ok: true }, duration_ms: 3 }, 'receipt') });
  const rows = f.rows();
  assert.equal(rows.every(row => row.decision.plugin.host === matrix.host), true);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].decision.plugin.event, 'fail_open');
  assert.equal(rows[2].decision.entryType, 'outcome');
  assert.equal(rows[2].decision.originalDecisionId, decisionId);
  assert.equal((await sdk.verifyChain(rows, restarted.publicKey)).ok, true);
});

test('Ten independent cold workers start without a fail-open admission', async t => {
  for (let i = 0; i < 10; i++) {
    const f = setup(t);
    const raw = { ...recorded.find(item => item.tool_name === 'Bash'), tool_use_id: `synthetic-cold-${i}`, transcript_path: path.join(f.data, 'absent.jsonl'), cwd: f.data };
    const result = f.invoke('spend-gate', raw);
    assert.equal(permission(result), 'allow');
    assert.equal(result.stderr, '', `Cold worker ${i}: ${result.stderr}`);
    assert.equal(f.rows().length, 1);
    assert.equal(f.rows()[0].decision.plugin.event, 'decision');
    spawnSync(process.execPath, [path.join(__dirname, '..', 'runtime', 'control.cjs'), 'stop'], { env: f.env, timeout: 5000 });
  }
  t.diagnostic('10 sequential cold worker starts: 10 signed admissions, 0 fail-open warnings.');
});

test('Simultaneous PreToolUse hooks share one cold worker and one signed chain', async t => {
  const invokeAsync = (f, raw) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'hooks', 'spend-gate.cjs')], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Concurrent hook subprocess timeout.')); }, 10000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify(raw));
  });
  for (let iteration = 0; iteration < 4; iteration++) {
    const f = setup(t);
    const base = { ...recorded.find(item => item.tool_name === 'Bash'), transcript_path: path.join(f.data, 'absent.jsonl'), cwd: f.data };
    const results = await Promise.all([0, 1].map(n => invokeAsync(f, { ...base, tool_use_id: `synthetic-cold-pair-${iteration}-${n}` })));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '', `Cold pair ${iteration}: ${result.stderr}`);
      assert.equal(matrix.permission(JSON.parse(result.stdout)), 'allow');
    }
    const rows = f.rows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.sequence), [0, 1]);
    assert.equal(rows.every(row => row.decision.plugin.event === 'decision'), true);
    assert.equal((await sdk.verifyChain(rows, Buffer.from(fs.readFileSync(path.join(f.data, 'public-key.hex'), 'utf8').trim(), 'hex'))).ok, true);
    spawnSync(process.execPath, [path.join(__dirname, '..', 'runtime', 'control.cjs'), 'stop'], { env: f.env, timeout: 5000 });
  }
  t.diagnostic('4 simultaneous cold-start pairs: 8 signed admissions, 0 fail-open warnings; every chain verifies.');
});
