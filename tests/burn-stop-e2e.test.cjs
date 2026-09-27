'use strict';
// End to end: the real hook scripts run as child processes with a temporary
// HOME, plugin data directory and AgentGuard home, against a transcript past
// Burn's 5B token limit. Nothing here reads or writes the real home.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const burn = require('@agentguard-run/burn');
const moments = require('../runtime/upgrade-moments.cjs');
const root = path.resolve(__dirname, '..');
const burnCli = require.resolve('@agentguard-run/burn/package.json').replace(/package\.json$/, 'dist/src/cli.js');
const STOP = 'This session has used 5.02B tokens. Limit: 5.00B.';
const readRows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

function fixture(t, {host = 'claude-code', burnPolicy} = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-e2e-home-')));
  const data = path.join(home, 'plugin-data'), agentguard = path.join(home, '.agentguard'), project = path.join(home, 'project');
  fs.mkdirSync(data, {mode: 0o700}); fs.mkdirSync(project);
  // Only what a hook needs: the temporary HOME, the host's plugin variables and
  // the AgentGuard home. No inherited AgentGuard, plugin or test variables.
  const env = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, AGENTGUARD_HOME: agentguard,
    AGENTGUARD_NOTIFY_SUPPRESS: '1', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0', NO_COLOR: '1',
    ...(host === 'claude-code' ? {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data} : {PLUGIN_ROOT: root, PLUGIN_DATA: data})};
  if (burnPolicy) { fs.mkdirSync(agentguard, {mode: 0o700}); fs.writeFileSync(path.join(agentguard, 'burn-policy.json'), burnPolicy, {mode: 0o600}); }
  // One model response past the 5B token limit, with Claude's own record shape.
  const transcript = path.join(project, 'session.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({uuid: 'e2e-usage-1', type: 'assistant', timestamp: new Date().toISOString(),
    message: {id: 'msg_e2e_1', role: 'assistant', usage: {input_tokens: 5_020_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0},
      content: [{type: 'text', text: 'SYNTHETIC_E2E_TRANSCRIPT_TEXT'}]}}) + '\n');
  const ipc = path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${crypto.createHash('sha256').update(data).digest('hex').slice(0, 24)}`);
  t.after(() => {
    stopProcesses(env, home);
    fs.rmSync(ipc, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  });
  const sessionId = `e2e-${host}-session`;
  let count = 0;
  const raw = (tool, extra = {}) => ({session_id: sessionId, transcript_path: transcript, cwd: project, hook_event_name: 'PreToolUse',
    tool_name: tool, tool_use_id: `toolu_e2e_${count++}`, tool_input: {}, ...extra});
  const hook = (name, input) => {
    const child = spawnSync(process.execPath, [path.join(root, 'hooks', name + '.cjs')], {env, input: JSON.stringify(input), encoding: 'utf8', timeout: 15000});
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '', `${name} must answer without failing open`);
    return JSON.parse(child.stdout);
  };
  // Session startup resolves the license in the worker; until it finishes the
  // session is in shadow. A real first spawn comes later than a test's.
  const client = path.join(root, 'runtime', 'client.cjs');
  const mode = () => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(client)}).request({control: 'effective-license', sessionId: ${JSON.stringify(sessionId)}}, {startWorker: false, timeoutMs: 1500})
    .then(result => process.stdout.write(String(result.license?.mode ?? '')), () => process.stdout.write('unavailable'))`], {env, encoding: 'utf8', timeout: 5000}).stdout;
  const started = () => { for (const deadline = Date.now() + 10000; Date.now() < deadline; pause(50)) if (mode() === 'enforce') return true; return false; };
  return {home, data, agentguard, project, transcript, env, sessionId, raw, hook, started,
    rows: () => readRows(path.join(data, 'ledger', 'decisions.ndjson')).map(row => row.decision),
    burnPolicyFile: path.join(agentguard, 'burn-policy.json')};
}

// The plugin processes this test started, and only those: the ones running this
// plugin's scripts with this test's temporary HOME in their environment.
function ours(home, script) {
  const listing = spawnSync('ps', ['eww', '-A', '-o', 'pid=,command='], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024}).stdout ?? '';
  return listing.split('\n').filter(line => line.includes(path.join(root, script)) && line.includes(`HOME=${home} `))
    .map(line => Number(line.trim().split(/\s+/)[0])).filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
}
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(home, script, ms) {
  for (const deadline = Date.now() + ms; ours(home, script).length && Date.now() < deadline;) pause(50);
  return ours(home, script);
}
// Lets the detached session startup finish (it could otherwise start a worker
// after the stop), stops the worker through its own mailbox so it flushes, and
// signals any worker of this HOME still running after that.
function stopProcesses(env, home) {
  waitFor(home, 'runtime/session-start.cjs', 5000);
  spawnSync(process.execPath, [path.join(root, 'runtime', 'control.cjs'), 'stop'], {env, timeout: 5000});
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const left = waitFor(home, 'runtime/daemon.cjs', 3000);
    if (!left.length) return;
    for (const pid of left) { try { process.kill(pid, signal); } catch { /* Already gone. */ } }
  }
  assert.deepEqual(waitFor(home, 'runtime/daemon.cjs', 3000), [], 'A test worker is still running.');
}

const permission = output => output.hookSpecificOutput?.permissionDecision ?? 'allow';

test('Claude Code end to end: a fresh install enforces, asks the person in interactive modes, refuses with the box otherwise, and refuses agent overrides', async t => {
  const f = fixture(t);
  const start = f.hook('session-start', {session_id: f.sessionId, transcript_path: f.transcript, cwd: f.project, hook_event_name: 'SessionStart', source: 'startup'});
  const pasteable = `! CLAUDE_PLUGIN_DATA=${moments.shellPath(f.data)} node ${moments.shellPath(path.join(root, 'runtime', 'policy-cli.cjs'))} preset careful`;
  // The short first-run line leads; the long pasteable preset command follows it.
  assert.equal(start.systemMessage, `${moments.FIRST_RUN_LINE}\nAgentGuard presets: solo-dev, careful and strict. No key or network is needed. Apply one by typing: ${pasteable}`);
  assert.equal(moments.FIRST_RUN_LINE, 'AgentGuard is on. If a session passes 15 sub-agents in 15 active minutes, 40 in 120, or 5B tokens, the next launch waits for your yes. Your sessions stay on this machine. See where a session went: ! npx agentguard-burn why');
  assert.equal(moments.FIRST_RUN_CODEX_LINE, 'AgentGuard is on. If a session passes 15 sub-agents in 15 active minutes, 40 in 120, or 5B tokens, the next launch is refused until you allow it. Your sessions stay on this machine. See where a session went: ! npx agentguard-burn why');
  // Once per machine: a second startup does not repeat it.
  assert.doesNotMatch(f.hook('session-start', {session_id: 'e2e-second-session', hook_event_name: 'SessionStart', source: 'startup'}).systemMessage ?? '', /AgentGuard is on/);
  assert.equal(f.started(), true, 'The session reaches Free enforcement once startup resolves.');

  // Default mode: Claude Code's own prompt, with Burn's words for the person.
  assert.equal(fs.existsSync(f.burnPolicyFile), false);
  const asked = f.hook('burn-gate', f.raw('Agent', {permission_mode: 'default'}));
  assert.deepEqual(asked, {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: `AgentGuard: ${STOP}\nSession so far: 0 sub-agents, 5.02B tokens.\nAllow this one launch? If you say no, nothing starts.`}});

  // The fresh install wrote Burn's shipped policy in enforce mode, privately, once.
  assert.deepEqual(JSON.parse(fs.readFileSync(f.burnPolicyFile, 'utf8')), {...burn.DEFAULT_POLICY, mode: 'enforce'});
  assert.equal(fs.statSync(f.burnPolicyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.agentguard).mode & 0o777, 0o700);
  assert.equal(f.rows().filter(row => row.plugin.event === 'burn_policy_seeded').length, 1);
  const held = f.rows().find(row => row.plugin.event === 'decision' && row.plugin.gate === 'burn');
  assert.equal(held.action, 'block'); assert.equal(held.plugin.asked, true); assert.equal(held.plugin.permissionMode, 'default');

  for (const mode of ['acceptEdits', 'plan', 'auto']) assert.equal(permission(f.hook('burn-gate', f.raw('Agent', {permission_mode: mode}))), 'ask', mode);
  // Modes that cannot show a prompt refuse with the STOP box and Burn's override command.
  for (const mode of ['bypassPermissions', 'dontAsk']) {
    const refused = f.hook('burn-gate', f.raw('Agent', {permission_mode: mode}));
    assert.equal(permission(refused), 'deny', mode);
    const box = refused.hookSpecificOutput.permissionDecisionReason;
    assert.ok(box.startsWith('\u2060\n┌') && box.endsWith('┘'), box);
    for (const line of ['AGENTGUARD STOP   sub-agent launch refused', STOP, 'Session so far: 0 sub-agents, 5.02B tokens.', 'WHAT TO DO', 'To launch it anyway, once, type this yourself:', `! ${burn.OVERRIDE_COMMAND}`])
      assert.ok(box.includes(line), `${mode}: ${line}`);
    // Every override the box prints runs through npx, so it works on a plugin-only install.
    assert.equal(box.split('agentguard-burn resume').length, box.split('npx agentguard-burn resume').length, box);
  }
  // The published policy file is the one Burn enforced; nothing rewrote it.
  assert.deepEqual(JSON.parse(fs.readFileSync(f.burnPolicyFile, 'utf8')).mode, 'enforce');
  assert.equal(f.rows().filter(row => row.plugin.event === 'burn_policy_seeded').length, 1);

  // The agent cannot lift the STOP itself; reading where a session went stays open.
  const attempt = f.raw('Bash', {permission_mode: 'bypassPermissions', tool_input: {command: 'npx @agentguard-run/burn resume --once --reason x'}});
  const refusedAttempt = f.hook('spend-gate', attempt);
  assert.deepEqual(refusedAttempt.hookSpecificOutput, {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: burn.AGENT_OVERRIDE_REASON});
  assert.equal(permission(f.hook('burn-gate', attempt)), 'allow');
  assert.equal(fs.existsSync(path.join(f.agentguard, 'override.json')), false);
  const why = f.raw('Bash', {tool_input: {command: 'npx @agentguard-run/burn why'}});
  assert.equal(permission(f.hook('spend-gate', why)), 'allow');
  assert.equal(permission(f.hook('burn-gate', why)), 'allow');
  const recorded = f.rows().find(row => row.plugin.toolUseId === attempt.tool_use_id && row.plugin.gate === 'spend');
  assert.equal(recorded.action, 'block'); assert.equal(recorded.plugin.reasonCode, 'burn_override:command');
  assert.equal(JSON.stringify(f.rows()).includes('SYNTHETIC_E2E_TRANSCRIPT_TEXT'), false);

  // The person's own override (a ! command never reaches a hook) lets one launch
  // through, and the line after it names the limit it passed.
  const person = spawnSync(process.execPath, [burnCli, 'resume', '--once', '--reason', 'e2e person approved'], {env: f.env, encoding: 'utf8', timeout: 15000});
  assert.equal(person.status, 0, person.stderr);
  const overridden = f.hook('burn-gate', f.raw('Agent', {permission_mode: 'bypassPermissions'}));
  assert.equal(permission(overridden), 'allow');
  assert.ok(overridden.systemMessage.endsWith(`AgentGuard STOP overridden once ("e2e person approved"): ${STOP}`), overridden.systemMessage);
  assert.equal(permission(f.hook('burn-gate', f.raw('Agent', {permission_mode: 'bypassPermissions'}))), 'deny');
});

test('Claude Code end to end: an existing shadow policy is left exactly as the person chose it', async t => {
  const policy = JSON.stringify({...burn.DEFAULT_POLICY, mode: 'shadow'}, null, 2);
  const f = fixture(t, {burnPolicy: policy});
  const start = f.hook('session-start', {session_id: f.sessionId, hook_event_name: 'SessionStart', source: 'startup'});
  assert.doesNotMatch(start.systemMessage ?? '', /AgentGuard is on/);
  assert.equal(f.started(), true, 'The plugin itself enforces; only Burn chose shadow.');
  const spawned = f.hook('burn-gate', f.raw('Agent', {permission_mode: 'default'}));
  assert.equal(permission(spawned), 'allow');
  assert.ok(spawned.systemMessage.endsWith(`AgentGuard STOP (shadow: would have refused): ${STOP}`), spawned.systemMessage);
  // With Burn in shadow there is no STOP to lift, so the command is not refused.
  assert.equal(permission(f.hook('spend-gate', f.raw('Bash', {tool_input: {command: 'npx @agentguard-run/burn resume --once --reason x'}}))), 'allow');
  assert.equal(fs.readFileSync(f.burnPolicyFile, 'utf8'), policy);
  assert.equal(f.rows().some(row => row.plugin.event === 'burn_policy_seeded'), false);
});

test('Codex end to end: a STOP is refused with the Codex box even in default permission mode, and agent overrides are refused', async t => {
  const f = fixture(t, {host: 'codex'});
  const refused = f.hook('burn-gate', f.raw('spawn_agent', {permission_mode: 'default'}));
  assert.equal(permission(refused), 'deny');
  const box = refused.hookSpecificOutput.permissionDecisionReason;
  assert.ok(box.startsWith('┌') && box.endsWith('┘'), box);
  assert.ok(box.includes(`To launch it anyway, once, run this in a terminal:`) && box.includes(`│ ${burn.OVERRIDE_COMMAND}`), box);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.burnPolicyFile, 'utf8')), {...burn.DEFAULT_POLICY, mode: 'enforce'});
  const attempt = f.hook('spend-gate', f.raw('Bash', {tool_input: {command: 'agentguard-burn shadow'}}));
  assert.equal(permission(attempt), 'deny');
  assert.equal(attempt.hookSpecificOutput.permissionDecisionReason,
    `AgentGuard: overrides come from the person, not the agent. Ask them to run it themselves in a terminal:\n${burn.OVERRIDE_COMMAND}`);
});
