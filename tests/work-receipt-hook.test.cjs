'use strict';
// SessionEnd end to end, as Claude Code runs it: real hook processes and a
// real worker. SessionEnd gets one signed receipt written before it returns,
// a second SessionEnd for the same session adds nothing, and every failure is
// quiet: exit 0, "{}" and nothing on stderr. HOME, AGENTGUARD_HOME, the plugin
// data folder and the Claude config folder are all temporary.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const burn = require('@agentguard-run/burn');
const sdk = require('@agentguard-run/spend');
const {workerReady} = require('../runtime/client.cjs');
const {locations} = require('../runtime/common.cjs');
const receipts = require('../runtime/work-receipt.cjs');
const root = path.resolve(__dirname, '..');
const SESSION = 'hook-receipt-session';
const T0 = Date.now() - 10 * 60_000;
const iso = at => new Date(at).toISOString();
const line = record => JSON.stringify(record) + '\n';
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const response = (id, at, tokens, extra = {}) => ({type: 'assistant', uuid: `hook-uuid-${id}`, timestamp: iso(at), ...extra,
  message: {id: `hook-msg-${id}`, model: 'claude-opus-5-5', role: 'assistant', content: [{type: 'text', text: 'SYNTHETIC_TRANSCRIPT_MUST_NOT_APPEAR'}],
    usage: {input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}}});

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-receipt-hook-')));
  const data = path.join(base, 'data'), home = path.join(base, 'agentguard'), cwd = path.join(base, 'secret-repo'), config = path.join(base, 'claude');
  for (const dir of [data, home, cwd, config]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const env = {...process.env, HOME: base, AGENTGUARD_HOME: home, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: config,
    AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0', AGENTGUARD_NOTIFY_SUPPRESS: '1'};
  for (const key of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_BENCHMARK']) delete env[key];
  // The largest warm budget keeps a loaded test machine from failing gates open.
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', hookBudgetMs: 1900}));
  fs.writeFileSync(path.join(home, 'burn-policy.json'), JSON.stringify({...burn.DEFAULT_POLICY, mode: 'enforce'}));
  // The session's transcript: two responses and one sub-agent that finished.
  const transcript = path.join(config, 'projects', '-secret-repo', `${SESSION}.jsonl`);
  fs.mkdirSync(path.join(transcript.replace(/\.jsonl$/, ''), 'subagents'), {recursive: true});
  fs.writeFileSync(transcript, line({type: 'user', uuid: 'hook-user', timestamp: iso(T0), message: {role: 'user', content: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'}})
    + line(response('p1', T0 + 1_000, 300)));
  const loc = locations(data);
  t.after(() => {
    spawnSync(process.execPath, [path.join(root, 'runtime', 'control.cjs'), 'stop'], {env, timeout: 5000});
    fs.rmSync(loc.ipc, {recursive: true, force: true});
    fs.rmSync(base, {recursive: true, force: true});
  });
  const hook = (name, input) => {
    const began = Date.now();
    const child = spawnSync(process.execPath, [path.join(root, 'hooks', name)], {env, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 20000});
    return {status: child.status, stdout: child.stdout, stderr: child.stderr, ms: Date.now() - began};
  };
  let call = 0;
  const pre = (session, tool, input) => ({session_id: session, transcript_path: transcript, cwd, permission_mode: 'default', hook_event_name: 'PreToolUse',
    tool_name: tool, tool_input: input, tool_use_id: `toolu_hook_receipt_${call++}`});
  // Each tool call as Claude Code runs it: both gates, then the outcome hook. These calls
  // only set the session up. On a heavily loaded machine a gate can still fail open; its
  // call is then recorded as a deferred fail-open row, which the worker signs before it
  // builds the receipt, so the receipt's counts are the same either way.
  const FAILED_OPEN = 'agentguard: internal error; allowed tool call; audit recovery queued when storage is writable.\n';
  const toolCall = (session, tool, input) => {
    const raw = pre(session, tool, input);
    for (const gate of ['burn-gate.cjs', 'spend-gate.cjs']) {
      const result = hook(gate, raw);
      assert.equal(result.status, 0, `${gate} ${tool}`);
      assert.ok(['', FAILED_OPEN].includes(result.stderr), `${gate} ${tool}: ${result.stderr}`);
      assert.notEqual(JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision, 'deny');
    }
    const done = hook('receipt.cjs', {...raw, hook_event_name: 'PostToolUse', tool_response: {content: 'SYNTHETIC_OUTPUT_MUST_NOT_APPEAR'}, duration_ms: 3});
    assert.deepEqual([done.status, done.stdout], [0, '{}\n']);
    assert.ok(['', FAILED_OPEN].includes(done.stderr), done.stderr);
  };
  const end = (session, transcriptPath = transcript) => hook('session-end.cjs', {session_id: session, transcript_path: transcriptPath, cwd, hook_event_name: 'SessionEnd', reason: 'other'});
  const rows = () => { try { return fs.readFileSync(path.join(data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(text => JSON.parse(text)); } catch { return []; } };
  const receiptRows = session => rows().filter(row => row.decision.plugin.event === 'session_receipt' && row.decision.plugin.sessionId === session);
  const spooled = () => { try { return fs.readFileSync(path.join(data, receipts.SPOOL), 'utf8'); } catch { return ''; } };
  const waitFor = (predicate, ms = 15000) => { const deadline = Date.now() + ms; while (!predicate()) { if (Date.now() > deadline) return false; sleep(25); } return true; };
  // Start a worker the way the first tool call of a session does, and wait until it is ready.
  // Burn's gateway is built on the worker's first launch decision, which can take longer than
  // a warm hook waits, so one launch of this warm-up session is decided before the test's own
  // calls; another warm-up call records it if that first hook gave up waiting.
  const startWorker = session => {
    hook('spend-gate.cjs', pre(session, 'Read', {}));
    assert.ok(waitFor(() => workerReady(loc)), 'the worker starts');
    const launch = pre(session, 'Agent', {description: 'warm-up'});
    hook('burn-gate.cjs', launch);
    const recorded = () => rows().some(row => row.decision.plugin.toolUseId === launch.tool_use_id);
    assert.ok(waitFor(() => recorded() || (hook('spend-gate.cjs', pre(session, 'Read', {})), recorded()), 30000), 'the warm-up launch is recorded');
  };
  const stopWorker = () => {
    spawnSync(process.execPath, [path.join(root, 'runtime', 'control.cjs'), 'stop'], {env, timeout: 5000});
    assert.ok(waitFor(() => !workerReady(loc)), 'the worker stops');
  };
  return {base, data, home, cwd, transcript, env, loc, hook, toolCall, end, rows, receiptRows, spooled, waitFor, startWorker, stopWorker};
}

test('SessionEnd writes exactly one signed receipt, and a second SessionEnd adds none, even through a worker restart', async t => {
  const f = fixture(t);
  f.startWorker('warmup-session');
  f.toolCall(SESSION, 'Read', {file_path: path.join(f.cwd, 'notes-file.txt')});
  f.toolCall(SESSION, 'Agent', {description: 'x', prompt: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'});
  // After the last tool call: the sub-agent's transcript, its end, and a closing response.
  fs.writeFileSync(path.join(f.transcript.replace(/\.jsonl$/, ''), 'subagents', 'agent-hooksub.jsonl'), line(response('c1', T0 + 30_000, 2_000, {isSidechain: true})));
  fs.appendFileSync(f.transcript, line({type: 'queue-operation', operation: 'enqueue', timestamp: iso(T0 + 40_000), sessionId: SESSION,
    content: '<task-notification>\n<task-id>hooksub</task-id>\n<status>completed</status>\n<summary>SYNTHETIC_OUTPUT_MUST_NOT_APPEAR</summary>\n</task-notification>'})
    + line(response('p2', T0 + 50_000, 25)));
  const ended = f.end(SESSION);
  assert.deepEqual([ended.status, ended.stdout, ended.stderr], [0, '{}\n', '']);
  assert.ok(ended.ms < 2000, `SessionEnd stays inside its two-second hook budget (${ended.ms} ms)`);
  // When the worker answered in time, nothing waits in the spool and the row was written
  // before the hook returned. A worker too slow to answer still writes it, a moment later.
  if (f.spooled() === '') assert.equal(f.receiptRows(SESSION).length, 1, 'written before SessionEnd returned');
  else assert.ok(f.waitFor(() => f.receiptRows(SESSION).length > 0), 'written once the worker gets to it');
  const [row, ...extra] = f.receiptRows(SESSION);
  assert.deepEqual(extra, []);
  const receipt = row.decision.plugin.receipt;
  assert.deepEqual({...receipt, firstActivityAt: undefined, lastActivityAt: undefined}, {version: 1, firstActivityAt: undefined, lastActivityAt: undefined,
    tokens: 300 + 2_000 + 25, subagents: {started: 1, finished: 1, endedWithoutFinishing: 0},
    decisions: {allowed: 2, asked: 0, saidYes: 0, saidNo: 0, stopped: 0}, burnPolicyMode: 'enforce', pluginVersion: require('../package.json').version});
  assert.equal(receipt.firstActivityAt, iso(T0 + 1_000));
  assert.ok(Date.parse(receipt.lastActivityAt) >= T0 + 50_000);
  const publicKey = Buffer.from(fs.readFileSync(path.join(f.data, 'public-key.hex'), 'utf8').trim(), 'hex');
  assert.equal((await sdk.verifyChain(f.rows(), publicKey)).ok, true, 'signed and chained with every other row');
  const ledger = fs.readFileSync(path.join(f.data, 'ledger', 'decisions.ndjson'), 'utf8');
  for (const text of ['SYNTHETIC_PROMPT_MUST_NOT_APPEAR', 'SYNTHETIC_OUTPUT_MUST_NOT_APPEAR', 'SYNTHETIC_TRANSCRIPT_MUST_NOT_APPEAR', 'notes-file.txt', 'secret-repo', f.base]) {
    assert.equal(ledger.includes(text), false, text);
  }
  // The same session ends again (a resumed session): exit 0, "{}", and still one receipt.
  const again = f.end(SESSION);
  assert.deepEqual([again.status, again.stdout, again.stderr], [0, '{}\n', '']);
  assert.equal(f.receiptRows(SESSION).length, 1);
  // A restarted worker takes every request that waited for it, and still writes no second receipt.
  f.stopWorker();
  f.startWorker('restart-session');
  assert.ok(f.waitFor(() => f.spooled() === ''), 'the spool is cleared');
  assert.equal(f.receiptRows(SESSION).length, 1);
  assert.equal((await sdk.verifyChain(f.rows(), publicKey)).ok, true);
  t.diagnostic(`receipt row #${row.sequence}: ${JSON.stringify(row.decision.plugin)}`);
});

test('with no worker running, SessionEnd fails open at once and the receipt is written when a worker starts', t => {
  const f = fixture(t);
  const ended = f.end('cold-session');
  assert.deepEqual([ended.status, ended.stdout, ended.stderr], [0, '{}\n', '']);
  assert.ok(ended.ms < 1500, `no wait without a worker (${ended.ms} ms)`);
  assert.equal(fs.existsSync(path.join(f.data, 'ledger')), false, 'the hook itself never writes the ledger');
  const spool = f.spooled().trim().split('\n').map(text => JSON.parse(text));
  assert.deepEqual(spool.map(item => item.sessionId), ['cold-session']);
  assert.equal(f.spooled().includes(f.transcript), false, 'the transcript locator is never stored');
  // The next session's first tool call starts a worker, which writes the waiting receipt from the ledger alone.
  f.startWorker('next-session');
  assert.ok(f.waitFor(() => f.receiptRows('cold-session').length === 1), 'the waiting receipt is written');
  const receipt = f.receiptRows('cold-session')[0].decision.plugin.receipt;
  assert.deepEqual(receipt, {version: 1, decisions: {allowed: 0, asked: 0, saidYes: 0, saidNo: 0, stopped: 0}, burnPolicyMode: 'enforce', pluginVersion: require('../package.json').version});
  assert.ok(f.waitFor(() => f.spooled() === ''), 'the spool is cleared');
});

test('SessionEnd stays quiet when its input is broken or its request cannot even be stored', t => {
  const f = fixture(t);
  for (const input of ['not json', '{}', JSON.stringify({session_id: 42}), JSON.stringify({session_id: 'x'.repeat(600)})]) {
    const result = f.hook('session-end.cjs', input);
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, '{}\n', ''], input.slice(0, 40));
  }
  assert.equal(f.spooled(), '');
  // No worker, and the spool cannot be written: still exit 0, "{}" and nothing on stderr.
  fs.mkdirSync(path.join(f.data, receipts.SPOOL));
  const lost = f.end('lost-session');
  assert.deepEqual([lost.status, lost.stdout, lost.stderr], [0, '{}\n', '']);
  // A worker that cannot write its ledger answers that the receipt failed; the hook keeps the request.
  fs.rmSync(path.join(f.data, receipts.SPOOL), {recursive: true});
  f.startWorker('warmup-session');
  fs.appendFileSync(path.join(f.data, 'ledger', 'decisions.ndjson'), crypto.randomBytes(4).toString('hex'));
  const failed = f.end('failing-session');
  assert.deepEqual([failed.status, failed.stdout, failed.stderr], [0, '{}\n', '']);
  assert.match(f.spooled(), /"sessionId":"failing-session"/);
});
