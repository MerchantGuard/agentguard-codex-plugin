'use strict';
// Sub-agents in Claude Code: with Burn 0.3.21 the plugin reads a session the
// way Burn's own hook does, so sub-agent usage counts toward "Session so far"
// and the session limit, and a STOP prints the finished-sub-agents line exactly
// as Burn prints it. With Burn 0.3.20 (what the lockfile installs until 0.3.21
// is published) it reads the session transcript alone, as before, and these
// tests check that fallback instead. Engine-level, temporary directories only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const burn = require('@agentguard-run/burn');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const root = path.resolve(__dirname, '..');
const free = {paid: false, tier: 'free', mode: 'enforce', reason: null};
const ORIGINAL_ENV = {...process.env};
const permission = output => output.hookSpecificOutput?.permissionDecision ?? 'allow';

const version = require('@agentguard-run/burn/package.json').version;
const readsSubagents = ['readSessionIncremental', 'saveReaderCursor', 'restoreReaderCursor', 'cloneReaderCursor', 'decisionCostLine']
  .every(name => typeof burn[name] === 'function');
test('Burn 0.3.21 and later always give the plugin the children-aware reader', () => {
  const [major, minor, patch] = version.split('.').map(Number);
  if (major > 0 || minor > 3 || patch >= 21) assert.equal(readsSubagents, true, `Burn ${version} must export the sub-agent reader`);
  else assert.equal(readsSubagents, false, `Burn ${version} predates it; the plugin keeps reading the session transcript alone`);
});

const T0 = Date.now() - 10 * 60_000;
const iso = at => new Date(at).toISOString();
const line = record => JSON.stringify(record) + '\n';
let sequence = 0;
const response = (at, usage) => ({type: 'assistant', uuid: `synthetic-uuid-${++sequence}`, timestamp: iso(at), message: {id: `synthetic-msg-${sequence}`,
  model: 'claude-opus-5-5', role: 'assistant', content: [], usage: {input_tokens: usage.input ?? 0, cache_creation_input_tokens: usage.write ?? 0,
    cache_read_input_tokens: usage.read ?? 0, output_tokens: 0, cache_creation: {ephemeral_5m_input_tokens: usage.write ?? 0, ephemeral_1h_input_tokens: 0}}}});
const finished = id => ({type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 60_000), sessionId: 'flow-session',
  content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>`});

// The demo session: 102K tokens in the main conversation, `launches` Agent calls,
// and three finished sub-agents of 1.3M tokens each (4.0M in all).
async function fixture(t, {host = 'claude-code', launches = 15, burnPolicy} = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-burn-subagents-'));
  const home = path.join(data, 'burn');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-burn-subagents-workspace-'));
  for (const key of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'AGENTGUARD_PLUGIN_POLICY']) delete process.env[key];
  Object.assign(process.env, host === 'claude-code' ? {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: path.join(data, 'claude')} : {PLUGIN_ROOT: root, PLUGIN_DATA: data},
    {AGENTGUARD_HOME: home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1'});
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce'}));
  const policy = burnPolicy ?? JSON.stringify({...burn.DEFAULT_POLICY, mode: 'enforce'});
  fs.mkdirSync(home, {recursive: true}); fs.writeFileSync(path.join(home, 'burn-policy.json'), policy);
  const transcript = path.join(data, 'transcript.jsonl'), subagents = path.join(data, 'transcript', 'subagents');
  let body = line(response(T0, {input: 2_000, write: 100_000}));
  for (let i = 0; i < launches; i++) body += line({type: 'assistant', uuid: `synthetic-launch-${i}`, timestamp: iso(T0 + 1_000 + i * 2_000),
    message: {role: 'assistant', content: [{type: 'tool_use', id: `toolu_launch_${i}`, name: 'Agent', input: {description: 'x', prompt: 'p'}}]}});
  for (const id of ['a', 'b', 'c']) body += line(finished(id));
  fs.writeFileSync(transcript, body);
  fs.mkdirSync(subagents, {recursive: true});
  for (const id of ['a', 'b', 'c'])
    fs.writeFileSync(path.join(subagents, `agent-${id}.jsonl`), line(response(T0 + 40_000, {write: 300_000})) + line(response(T0 + 41_000, {read: 1_000_000})));
  let engine = new Engine({licenseReader: () => free});
  await engine.init();
  t.after(async () => {
    await engine.close();
    for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
    Object.assign(process.env, ORIGINAL_ENV);
    fs.rmSync(data, {recursive: true, force: true});
    fs.rmSync(cwd, {recursive: true, force: true});
  });
  let count = 0;
  const raw = (tool, extra = {}) => ({session_id: 'flow-session', tool_use_id: `toolu_flow_${count++}`, cwd, transcript_path: transcript,
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, ...extra});
  const gate = async (input, permissionMode) => {
    const meta = metadata(input, 'burn');
    if (permissionMode) meta.permissionMode = permissionMode;
    return engine.handle({meta, transcriptPath: transcript, workingDirectory: cwd});
  };
  // A restarted worker reads the cursors it saved, not the transcripts from the start.
  const restart = async () => { await engine.close(); engine = new Engine({licenseReader: () => free}); await engine.init(); };
  // Burn's own hook on the same session, in its own home with the same policy: what the plugin must match.
  const own = input => {
    const ownHome = fs.mkdtempSync(path.join(data, 'own-burn-'));
    fs.writeFileSync(path.join(ownHome, 'burn-policy.json'), policy);
    return burn.handlePreToolUse({...input, tool_use_id: 'own-' + input.tool_use_id}, ownHome);
  };
  return {data, home, transcript, subagents, raw, gate, restart, own, engine: () => engine};
}

const FOUR_LINES = ['AgentGuard: 15 sub-agents in the last 15 active minutes. Limit: 15.', 'Session so far: 15 sub-agents, 4.0M tokens.',
  'The 3 sub-agents that finished in this session averaged 1.3M tokens each ($1.70 at API prices, not a bill). This one could differ.',
  'Allow this one launch? If you say no, nothing starts.'].join('\n');
const PARENT_ONLY = ['AgentGuard: 15 sub-agents in the last 15 active minutes. Limit: 15.', 'Session so far: 15 sub-agents, 102K tokens.',
  'Allow this one launch? If you say no, nothing starts.'].join('\n');

test('claude-code: the 16th launch asks with Burn\'s own text, sub-agents in "Session so far" and the finished-sub-agents line', async t => {
  const f = await fixture(t);
  const input = f.raw('Agent', {permission_mode: 'default'});
  const asked = await f.gate(input, 'default');
  assert.equal(permission(asked.output), 'ask');
  const reason = asked.output.hookSpecificOutput.permissionDecisionReason;
  if (readsSubagents) {
    assert.equal(reason, FOUR_LINES);
    assert.equal(reason, f.own(input).hookSpecificOutput.permissionDecisionReason, 'the plugin prints exactly what Burn\'s own hook prints');
    assert.equal(f.engine().gateway.sessions().find(session => session.sessionId === 'flow-session').state.totalTokens, 4_002_000);
  } else assert.equal(reason, PARENT_ONLY);
});

test('claude-code: the session limit counts sub-agent tokens', async t => {
  const policy = structuredClone(burn.DEFAULT_POLICY);
  policy.mode = 'enforce';
  policy.thresholds.sustained = {warnTokens: 500_000, stopTokens: 1_000_000};
  const f = await fixture(t, {launches: 2, burnPolicy: JSON.stringify(policy)});
  const result = await f.gate(f.raw('Agent', {permission_mode: 'default'}), 'default');
  if (readsSubagents) {
    assert.equal(permission(result.output), 'ask');
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /^AgentGuard: This session has used 4\.0M tokens\. Limit: 1\.0M\.\nSession so far: 2 sub-agents, 4\.0M tokens\.\nThe 3 sub-agents /);
  } else assert.equal(permission(result.output), 'allow', 'the session transcript alone holds 102K tokens');
});

test('claude-code: a refused launch shows the same line in Burn\'s own STOP box', async t => {
  const f = await fixture(t);
  const input = f.raw('Agent', {permission_mode: 'bypassPermissions'});
  const refused = await f.gate(input, 'bypassPermissions');
  assert.equal(permission(refused.output), 'deny');
  const box = refused.output.hookSpecificOutput.permissionDecisionReason;
  if (readsSubagents) assert.equal(box, f.own(input).hookSpecificOutput.permissionDecisionReason, 'the plugin prints exactly Burn\'s own box');
  else assert.ok(box.includes('Session so far: 15 sub-agents, 102K tokens.') && !box.includes('The 3 sub-agents that finished'), box);
  box.split('\n').slice(1).forEach(row => assert.equal(Array.from(row).length, 66, row));
});

const fsModule = require('node:fs');
// Bytes read from files under `directory` while `run` runs, through the reads Burn's incremental reader makes.
async function bytesReadUnder(directory, run) {
  const {openSync, readSync, closeSync} = fsModule;
  const watched = new Set();
  let bytes = 0;
  fsModule.openSync = (file, ...rest) => { const fd = openSync(file, ...rest); if (String(file).startsWith(directory)) watched.add(fd); return fd; };
  fsModule.readSync = (fd, ...rest) => { const read = readSync(fd, ...rest); if (watched.has(fd)) bytes += read; return read; };
  fsModule.closeSync = fd => { watched.delete(fd); closeSync(fd); };
  try { const result = await run(); return {result, bytes}; } finally { Object.assign(fsModule, {openSync, readSync, closeSync}); }
}

test('claude-code: repeat calls read 0 bytes of unchanged sub-agent transcripts, and a restarted worker resumes each where it stopped', async t => {
  const f = await fixture(t, {launches: 2});
  const first = await bytesReadUnder(f.subagents, () => f.gate(f.raw('Read')));
  assert.equal(first.result.warning, undefined);
  assert.equal(first.bytes > 0, readsSubagents);
  const again = await bytesReadUnder(f.subagents, () => f.gate(f.raw('Read')));
  assert.equal(again.bytes, 0);
  await f.restart();
  const restarted = await bytesReadUnder(f.subagents, () => f.gate(f.raw('Read')));
  assert.equal(restarted.result.warning, undefined);
  assert.equal(restarted.bytes, 0, 'the saved cursor holds every sub-agent transcript\'s offset');
  const more = line(response(Date.now(), {input: 3_000_000}));
  fs.appendFileSync(path.join(f.subagents, 'agent-c.jsonl'), more);
  const grown = await bytesReadUnder(f.subagents, () => f.gate(f.raw('Read')));
  assert.equal(grown.bytes, readsSubagents ? Buffer.byteLength(more) : 0);
  const session = f.engine().gateway.sessions().find(item => item.sessionId === 'flow-session');
  assert.equal(session.state.totalTokens, readsSubagents ? 7_002_000 : 102_000, 'each response counted once');
});

test('codex: sub-agent transcripts are never read and the STOP text is unchanged', async t => {
  const f = await fixture(t, {host: 'codex'});
  const result = await bytesReadUnder(f.subagents, () => f.gate(f.raw('spawn_agent')));
  assert.equal(result.bytes, 0);
  assert.equal(permission(result.result.output), 'allow', 'Codex usage comes from its own transcript format, and this synthetic session has no Codex launches');
  assert.doesNotMatch(JSON.stringify(result.result.output), /sub-agents that finished/);
});
