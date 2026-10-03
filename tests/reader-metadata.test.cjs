'use strict';
// The read-only reader (status, list, verify, export) has to read every row
// the gates write. In Claude Code the burn gate records the permission mode,
// an asked launch records asked, the first enforced launch records the Burn
// policy it seeded, and an agent's attempt to lift a STOP records the kind of
// override. Each was outside the reader's schema, so one such row made every
// reader call fail. Engine-level, temporary directories only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const burn = require('@agentguard-run/burn');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const {createReader} = require('../runtime/mcp.cjs');
const root = path.resolve(__dirname, '..');
const free = {paid: false, tier: 'free', mode: 'enforce', reason: null};
const ORIGINAL_ENV = {...process.env};
const SESSION = 'reader-session';
const T0 = Date.now() - 10 * 60_000;
const line = record => JSON.stringify(record) + '\n';

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-reader-metadata-'));
  const data = path.join(base, 'data'), home = path.join(base, 'burn'), cwd = path.join(base, 'work');
  for (const dir of [data, home, cwd]) fs.mkdirSync(dir, {recursive: true});
  for (const key of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'AGENTGUARD_PLUGIN_POLICY']) delete process.env[key];
  Object.assign(process.env, {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: path.join(base, 'claude'),
    AGENTGUARD_HOME: home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1'});
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce'}));
  // No burn-policy.json: the first gated launch seeds it, as on a fresh install.
  const transcript = path.join(base, 'transcript.jsonl');
  let body = '';
  for (let i = 0; i < 15; i++) body += line({type: 'assistant', uuid: `u-${i}`, timestamp: new Date(T0 + i * 2_000).toISOString(),
    message: {role: 'assistant', content: [{type: 'tool_use', id: `toolu_${i}`, name: 'Agent', input: {description: 'x', prompt: 'p'}}]}});
  fs.writeFileSync(transcript, body);
  const engine = new Engine({licenseReader: () => free});
  await engine.init();
  t.after(async () => {
    await engine.close();
    for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
    Object.assign(process.env, ORIGINAL_ENV);
    fs.rmSync(base, {recursive: true, force: true});
  });
  let count = 0;
  const raw = (tool, extra = {}) => ({session_id: SESSION, tool_use_id: `toolu_reader_${count++}`, cwd, transcript_path: transcript,
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, ...extra});
  return {data, home, raw, engine, transcript, cwd};
}

test('the reader reads a seeded Burn policy, a launch with its permission mode, an asked launch and an override attempt', async t => {
  const f = await fixture(t);
  // What runtime/client.cjs sends for a Claude Code launch: the permission mode rides along.
  const launch = metadata(f.raw('Agent', {permission_mode: 'default'}), 'burn');
  launch.permissionMode = 'default';
  const asked = await f.engine.handle({meta: launch, transcriptPath: f.transcript, workingDirectory: f.cwd});
  assert.equal(asked.output.hookSpecificOutput?.permissionDecision, 'ask', 'the 16th launch asks');
  assert.ok(fs.existsSync(path.join(f.home, 'burn-policy.json')), 'the first enforced launch seeded Burn\'s policy');
  // The agent tries to lift the STOP itself.
  const override = metadata(f.raw('Bash', {tool_input: {command: 'npx agentguard-burn resume'}}), 'spend');
  assert.equal(override.burnOverride, 'command');
  const refused = await f.engine.handle({meta: override});
  assert.equal(refused.output.hookSpecificOutput?.permissionDecision, 'deny');
  await f.engine.flush();

  const reader = createReader({dataDir: f.data});
  const listed = await reader.call('list_decisions', {});
  const events = listed.entries.map(entry => entry.event);
  assert.ok(events.includes('burn_policy_seeded'));
  assert.ok(listed.entries.some(entry => entry.toolName === 'Agent' && entry.asked === true), 'the asked launch is listed with asked');
  const verified = await reader.call('verify_chain', {});
  assert.equal(verified.ok, true);
  assert.equal(verified.entries, listed.totalEntries);
  const status = await reader.call('get_status', {sessionId: SESSION});
  assert.equal(status.blocks >= 1, true);
  assert.equal(burn.DEFAULT_THRESHOLDS.spawnRate.stop, 16, 'the fixture relies on the shipped burst limit');
});

test('the reader stays strict: a recorded field with the wrong type is still refused', async t => {
  const f = await fixture(t);
  const launch = metadata(f.raw('Agent', {permission_mode: 'default'}), 'burn');
  launch.permissionMode = 'default; rm -rf';
  await f.engine.handle({meta: launch, transcriptPath: f.transcript, workingDirectory: f.cwd});
  await f.engine.flush();
  await assert.rejects(createReader({dataDir: f.data}).call('list_decisions', {}), /metadata/i);
});

test('the reader reads the work receipt the worker writes when a session ends: list, verify, status and get_work_receipt', async t => {
  const f = await fixture(t);
  const launch = metadata(f.raw('Agent', {permission_mode: 'default'}), 'burn');
  launch.permissionMode = 'default';
  await f.engine.handle({meta: launch, transcriptPath: f.transcript, workingDirectory: f.cwd});
  assert.equal((await f.engine.sessionReceipt({sessionId: SESSION, transcriptPath: f.transcript})).receipt, 'appended');
  await f.engine.flush();
  const reader = createReader({dataDir: f.data});
  const listed = await reader.call('list_decisions', {});
  const row = listed.entries.find(entry => entry.event === 'session_receipt');
  assert.deepEqual(row.receipt.decisions, {allowed: 0, asked: 1, saidYes: 0, stopped: 0}, 'the asked launch, with said no left out');
  const verified = await reader.call('verify_chain', {});
  assert.equal(verified.ok, true);
  assert.equal(verified.entries, listed.totalEntries);
  assert.equal((await reader.call('get_status', {sessionId: SESSION})).totalEntries, listed.totalEntries);
  const receipt = await reader.call('get_work_receipt', {sessionId: SESSION});
  assert.deepEqual([receipt.found, receipt.signature.sequence, receipt.signature.valid, receipt.chain.verified], [true, row.sequence, true, true]);
});
