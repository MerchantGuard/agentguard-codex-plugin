'use strict';
// runtime/mod-status.cjs, the read side of the AgentGuard mod: its sub-agent
// counts and session tokens must be the numbers Burn's gateway decides on, its
// rows must be this session's signed decisions, and reading must change
// nothing. Engine-level, temporary directories only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const burn = require('@agentguard-run/burn');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const root = path.resolve(__dirname, '..');
const script = path.join(root, 'runtime', 'mod-status.cjs');
const free = {paid: false, tier: 'free', mode: 'enforce', reason: null};
const ORIGINAL_ENV = {...process.env};
const SESSION = 'live-session';
const T0 = Date.now() - 10 * 60_000;
const iso = at => new Date(at).toISOString();
const line = record => JSON.stringify(record) + '\n';

// A Claude Code session whose transcript already holds `launches` Agent calls.
async function fixture(t, {launches = 15} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mod-status-'));
  const data = path.join(base, 'data'), home = path.join(base, 'burn'), cwd = path.join(base, 'work');
  for (const dir of [data, home, cwd]) fs.mkdirSync(dir, {recursive: true});
  for (const key of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'AGENTGUARD_PLUGIN_POLICY']) delete process.env[key];
  Object.assign(process.env, {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: path.join(base, 'claude'),
    AGENTGUARD_HOME: home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1', HOME: base});
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce'}));
  fs.writeFileSync(path.join(home, 'burn-policy.json'), JSON.stringify({...burn.DEFAULT_POLICY, mode: 'enforce'}));
  const transcript = path.join(base, 'transcript.jsonl');
  let body = line({type: 'assistant', uuid: 'u-0', timestamp: iso(T0), message: {id: 'm-0', model: 'claude-opus-5-5', role: 'assistant', content: [],
    usage: {input_tokens: 2_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 0, output_tokens: 0}}});
  for (let i = 0; i < launches; i++) body += line({type: 'assistant', uuid: `u-launch-${i}`, timestamp: iso(T0 + 1_000 + i * 2_000),
    message: {role: 'assistant', content: [{type: 'tool_use', id: `toolu_launch_${i}`, name: 'Agent', input: {description: 'x', prompt: 'p'}}]}});
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
  const raw = (tool, extra = {}) => ({session_id: SESSION, tool_use_id: `toolu_live_${count++}`, cwd, transcript_path: transcript,
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, permission_mode: 'default', ...extra});
  const gate = async input => {
    const meta = metadata(input, 'burn');
    meta.permissionMode = 'default';
    return engine.handle({meta, transcriptPath: transcript, workingDirectory: cwd});
  };
  const ran = async input => engine.handle({meta: metadata({...input, hook_event_name: 'PostToolUse', tool_response: {status: 'completed'}}, 'receipt')});
  const run = (args, env = process.env) => JSON.parse(execFileSync(process.execPath, [script, ...args], {env: {...env, AGENTGUARD_MOD_STATUS_DEBUG: '1'}, encoding: 'utf8'}));
  return {base, data, home, raw, gate, ran, run, engine};
}

// Every file under a folder with its size and content hash, to prove a read changed nothing.
function tree(dir) {
  const out = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out[path.relative(dir, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

test('the counts are the numbers Burn\'s gateway decides on, and the limits are the shipped ones', async t => {
  const f = await fixture(t);
  const asked = await f.gate(f.raw('Agent'));
  assert.equal(asked.output.hookSpecificOutput?.permissionDecision, 'ask', 'the 16th launch asks');
  const out = f.run(['--session', SESSION]);
  assert.equal(out.ok, true);
  const view = f.engine.gateway.peek(SESSION);
  const thresholds = burn.DEFAULT_THRESHOLDS;
  assert.equal(out.burn.burst.count, burn.windowSum(view.state.spawnsByActiveMinute, view.state.activeMinutes, thresholds.spawnRate.windowActiveMinutes));
  assert.equal(out.burn.sustained.count, burn.windowSum(view.state.spawnsByActiveMinute, view.state.activeMinutes, thresholds.fanout.windowActiveMinutes));
  assert.equal(out.burn.tokens.used, view.state.totalTokens);
  assert.deepEqual([out.burn.burst.limit, out.burn.burst.windowActiveMinutes, out.burn.sustained.limit, out.burn.sustained.windowActiveMinutes, out.burn.tokens.limit],
    [15, 15, 40, 120, 5_000_000_000]);
  assert.ok(out.burn.burst.count >= 15, 'the transcript\'s 15 launches are counted');
  assert.equal(out.burn.mode, 'enforce');
});

test('an asked launch reads "asked you", and "allowed by you" once it ran', async t => {
  const f = await fixture(t);
  const input = f.raw('Agent');
  await f.gate(input);
  let out = f.run(['--session', SESSION]);
  assert.equal(out.ledger.decisions[0].tool, 'Agent');
  assert.equal(out.ledger.decisions[0].result, 'asked you');
  assert.equal(out.ledger.asked, 1);
  await f.ran(input);
  out = f.run(['--session', SESSION]);
  assert.equal(out.ledger.decisions[0].result, 'allowed by you');
  // The same launch, found by its tool call for the row stamp
  assert.deepEqual(out.ledger.launches[input.tool_use_id], {sequence: out.ledger.decisions[0].sequence, result: 'allowed by you'});
});

test('a launch under the limit reads "started", plain allows stay out of the rows, and other sessions never show', async t => {
  const f = await fixture(t, {launches: 2});
  await f.gate(f.raw('Agent'));
  await f.engine.handle({meta: metadata(f.raw('Read'), 'spend')});
  await f.gate({...f.raw('Agent'), session_id: 'someone-else'});
  const out = f.run(['--session', SESSION]);
  assert.deepEqual(out.ledger.decisions.map(row => [row.tool, row.result]), [['Agent', 'started']]);
  assert.equal(out.ledger.recorded, 2, 'the Read call is recorded, though not shown as a row');
});

test('--verify checks every signature, and a changed byte in the ledger fails the check', async t => {
  const f = await fixture(t, {launches: 2});
  await f.gate(f.raw('Agent'));
  await f.engine.flush();
  let out = f.run(['--session', SESSION, '--verify']);
  assert.equal(out.ledger.ledger.verified, true);
  assert.match(out.ledger.ledger.signer, /^[a-f0-9]{16}$/);
  const file = path.join(f.data, 'ledger', 'decisions.ndjson');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('"action":"allow"', '"action":"block"'));
  out = f.run(['--session', SESSION, '--verify']);
  assert.notEqual(out.ledger?.ledger?.verified, true, 'a tampered ledger is never reported as verified');
});

test('reading changes nothing in the plugin data or in Burn\'s home', async t => {
  const f = await fixture(t);
  await f.gate(f.raw('Agent'));
  await f.engine.flush();
  const before = {data: tree(f.data), home: tree(f.home)};
  f.run(['--session', SESSION, '--verify']);
  f.run(['--session', 'never-seen']);
  assert.deepEqual({data: tree(f.data), home: tree(f.home)}, before);
});

test('without CLAUDE_PLUGIN_DATA, the installed plugin\'s data folder is found by name; a session never gated reads zero', async t => {
  const f = await fixture(t, {launches: 2});
  await f.gate(f.raw('Agent'));
  await f.engine.flush();
  const installed = path.join(f.base, 'claude', 'plugins', 'data', 'agentguard-inline');
  fs.mkdirSync(path.dirname(installed), {recursive: true});
  fs.cpSync(f.data, installed, {recursive: true});
  const env = {...process.env};
  delete env.CLAUDE_PLUGIN_DATA;
  const out = f.run(['--session', SESSION], env);
  assert.equal(out.ledger.decisions[0].result, 'started');
  const empty = f.run(['--session', 'never-seen'], env);
  assert.deepEqual([empty.burn.burst.count, empty.burn.tokens.used, empty.burn.seen, empty.ledger.decisions.length], [0, 0, false, 0]);
});

test('a missing or malformed session id is refused, and a fresh machine creates no folders', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mod-status-fresh-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const env = {...ORIGINAL_ENV, HOME: base, AGENTGUARD_HOME: path.join(base, '.agentguard'), CLAUDE_CONFIG_DIR: path.join(base, '.claude')};
  for (const key of ['CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA']) delete env[key];
  const run = args => JSON.parse(execFileSync(process.execPath, [script, ...args], {env, encoding: 'utf8'}));
  assert.deepEqual(run([]), {v: 1, ok: false, error: 'session_required'});
  assert.equal(run(['--session', 'bad id with spaces']).error, 'session_required');
  const out = run(['--session', 'fresh-session']);
  assert.equal(out.ok, true);
  assert.equal(out.burn.seen, false);
  assert.equal(fs.existsSync(path.join(base, '.agentguard')), false, 'no Burn home was created');
});
