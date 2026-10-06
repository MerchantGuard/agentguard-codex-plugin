'use strict';
// Work receipts: at the end of a session the worker appends one signed row of
// counts, and every read-only path reads it. The builder takes counts only, so
// nothing a prompt, path, command or transcript holds can reach the row; the
// reader holds receipt rows to the same schema the worker signs with (the
// 0.3.15 class of failure). Temporary directories only: HOME, AGENTGUARD_HOME,
// the plugin data folder and the Claude config folder are all under one.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('./helper-test-env.cjs');
const burn = require('@agentguard-run/burn');
const sdk = require('@agentguard-run/spend');
const {LICENSE_KEY, seedPaidLicense} = require('./helper-paid-license.cjs');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const {createReader, handleRpc} = require('../runtime/mcp.cjs');
const receipts = require('../runtime/work-receipt.cjs');
const root = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
const ORIGINAL_ENV = {...process.env};
const ENV_KEYS = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'AGENTGUARD_PLUGIN_POLICY'];
const SESSION = 'receipt-session';
const T0 = Date.now() - 20 * 60_000;
const iso = at => new Date(at).toISOString();
const line = record => JSON.stringify(record) + '\n';
// Everything a session holds that a receipt must never carry.
const SENTINELS = ['SYNTHETIC_PROMPT_MUST_NOT_APPEAR', 'SYNTHETIC_COMMAND_MUST_NOT_APPEAR', 'SYNTHETIC_TRANSCRIPT_MUST_NOT_APPEAR',
  'SYNTHETIC_OUTPUT_MUST_NOT_APPEAR', 'secret-repo', 'notes-file.txt'];
const free = {paid: false, tier: 'free', mode: 'enforce', reason: null};
const paid = {paid: true, tier: 'growth', mode: 'enforce', reason: null};
let uuid = 0;
const response = (at, tokens, extra = {}) => ({type: 'assistant', uuid: `synthetic-uuid-${++uuid}`, timestamp: iso(at), ...extra,
  message: {id: `synthetic-msg-${uuid}`, model: 'claude-opus-5-5', role: 'assistant', content: [{type: 'text', text: 'SYNTHETIC_TRANSCRIPT_MUST_NOT_APPEAR'}],
    usage: {input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}}});
const notification = (id, status, at) => ({type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), sessionId: SESSION,
  content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>SYNTHETIC_TRANSCRIPT_MUST_NOT_APPEAR</summary>\n</task-notification>`});

function environment(t, {host = 'claude-code', license = false} = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-work-receipt-')));
  const data = path.join(base, 'data'), home = path.join(base, 'agentguard'), cwd = path.join(base, 'secret-repo');
  for (const dir of [data, home, cwd]) fs.mkdirSync(dir, {recursive: true});
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, host === 'claude-code' ? {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data} : {PLUGIN_ROOT: root, PLUGIN_DATA: data},
    {HOME: base, CLAUDE_CONFIG_DIR: path.join(base, 'claude'), AGENTGUARD_HOME: home, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1'});
  if (license) seedPaidLicense(home, LICENSE_KEY, data);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', deniedTools: ['^mcp__synthetic__erase_everything$'], ...(license ? {licenseKey: LICENSE_KEY} : {})}));
  // Burn enforces; a launch past 80 tokens in the session waits for the person's answer.
  const policy = structuredClone(burn.DEFAULT_POLICY);
  policy.mode = 'enforce';
  policy.thresholds.sustained = {warnTokens: 70, stopTokens: 80};
  fs.writeFileSync(path.join(home, 'burn-policy.json'), JSON.stringify(policy));
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
    Object.assign(process.env, ORIGINAL_ENV);
    fs.rmSync(base, {recursive: true, force: true});
  });
  return {base, data, home, cwd};
}

// A Claude Code session: tool calls through the real gates (allowed, stopped,
// asked and answered, asked and never run), sub-agent transcripts beside the
// session's own (two finished, one failed, one still running), and content in
// every input that a receipt must never carry.
async function session(t, {host = 'claude-code', license = false} = {}) {
  const env = environment(t, {host, license});
  const transcript = path.join(env.base, 'claude', 'projects', '-secret-repo', `${SESSION}.jsonl`);
  const subagents = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(subagents, {recursive: true});
  fs.writeFileSync(transcript, line({type: 'user', uuid: 'synthetic-user', timestamp: iso(T0), message: {role: 'user', content: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'}})
    + line(response(T0 + 1_000, 40)));
  let engine = new Engine({licenseReader: () => (license ? paid : free)});
  await engine.init();
  t.after(async () => { await engine.close(); });
  let count = 0;
  const raw = (tool, input = {}, extra = {}) => ({session_id: SESSION, tool_use_id: `toolu_receipt_${count++}`, cwd: env.cwd, transcript_path: transcript,
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, permission_mode: 'default', ...extra});
  const spend = input => engine.handle({meta: metadata(input, 'spend')});
  const launch = input => { const meta = metadata(input, 'burn'); meta.permissionMode = 'default'; return engine.handle({meta, transcriptPath: transcript, workingDirectory: env.cwd}); };
  const ran = input => engine.handle({meta: metadata({...input, hook_event_name: 'PostToolUse', tool_response: {status: 'completed', content: 'SYNTHETIC_OUTPUT_MUST_NOT_APPEAR'}, duration_ms: 5}, 'receipt')});
  const restart = async () => { await engine.close(); engine = new Engine({licenseReader: () => (license ? paid : free)}); await engine.init(); return engine; };
  return {...env, transcript, subagents, raw, spend, launch, ran, restart, engine: () => engine};
}

async function decidedSession(t, options) {
  const s = await session(t, options);
  const read = s.raw('Read', {file_path: path.join(s.cwd, 'notes-file.txt')});
  assert.equal((await s.spend(read)).output.hookSpecificOutput?.permissionDecision ?? 'allow', 'allow');
  await s.ran(read);
  const bash = s.raw('Bash', {command: 'echo SYNTHETIC_COMMAND_MUST_NOT_APPEAR', description: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'});
  await s.spend(bash); await s.ran(bash);
  const erase = s.raw('mcp__synthetic__erase_everything', {target: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'});
  assert.equal((await s.spend(erase)).output.hookSpecificOutput.permissionDecision, 'deny');
  const tool = host => host === 'codex' ? 'spawn_agent' : 'Agent';
  const first = s.raw(tool(options?.host), {description: 'x', prompt: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'});
  await s.launch(first); await s.ran(first);
  return {s, launches: [first]};
}

test('a Claude Code session ends with one signed receipt of counts only, and a second end adds nothing', async t => {
  const {s} = await decidedSession(t);
  // Past the limit: two launches wait for the person. One ran (said yes), one never did.
  fs.appendFileSync(s.transcript, line(response(T0 + 60_000, 100)));
  const yes = s.raw('Agent', {prompt: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'}), no = s.raw('Agent', {prompt: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'});
  assert.equal((await s.launch(yes)).output.hookSpecificOutput?.permissionDecision, 'ask');
  await s.ran(yes);
  assert.equal((await s.launch(no)).output.hookSpecificOutput?.permissionDecision, 'ask');
  // After the last tool call: four sub-agent transcripts and how they ended.
  for (const id of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(s.subagents, `agent-${id}.jsonl`), line(response(T0 + 120_000, 1_000, {isSidechain: true})));
  fs.appendFileSync(s.transcript, line(notification('a', 'completed', T0 + 130_000))
    + line({type: 'user', uuid: 'synthetic-result', timestamp: iso(T0 + 131_000), toolUseResult: {status: 'completed', agentId: 'b', content: 'SYNTHETIC_OUTPUT_MUST_NOT_APPEAR'}})
    + line(notification('c', 'failed', T0 + 132_000)) + line(response(T0 + 140_000, 7)));
  const engine = s.engine();
  const result = await engine.sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript});
  assert.equal(result.receipt, 'appended');
  const rows = fs.readFileSync(path.join(s.data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').map(text => JSON.parse(text));
  const row = rows.find(entry => entry.decision.plugin.event === 'session_receipt');
  assert.equal(row.sequence, result.sequence);
  assert.equal(row.entryHash, result.entryHash);
  const gateway = engine.gateway.peek(SESSION);
  assert.deepEqual(row.decision.plugin.receipt, {
    version: 1,
    firstActivityAt: iso(T0 + 1_000),
    lastActivityAt: row.decision.plugin.receipt.lastActivityAt,
    tokens: 40 + 100 + 4 * 1_000 + 7,
    subagents: {started: 4, finished: 2, endedWithoutFinishing: 1},
    decisions: {allowed: 3, asked: 2, saidYes: 1, stopped: 1},
    burnPolicyMode: 'enforce',
    pluginVersion: VERSION,
  });
  assert.equal(row.decision.plugin.receipt.tokens, gateway.state.totalTokens, 'the tokens Burn recorded for the session');
  assert.ok(Date.parse(row.decision.plugin.receipt.lastActivityAt) >= T0 + 140_000);
  assert.deepEqual({event: row.decision.plugin.event, gate: row.decision.plugin.gate, sessionId: row.decision.plugin.sessionId, host: row.decision.plugin.host,
    actor: row.decision.actor.sessionId, action: row.decision.action}, {event: 'session_receipt', gate: 'control', sessionId: SESSION, host: 'claude-code', actor: SESSION, action: 'allow'});
  // Signed and chained with every other row.
  assert.equal((await sdk.verifyChain(rows, engine.publicKey)).ok, true);
  // Counts only: nothing of the prompts, paths, commands, output or transcript, anywhere in the ledger.
  const ledger = fs.readFileSync(path.join(s.data, 'ledger', 'decisions.ndjson'), 'utf8');
  for (const sentinel of [...SENTINELS, s.transcript, s.base]) assert.equal(ledger.includes(sentinel), false, sentinel);
  const receiptText = JSON.stringify(row);
  for (const name of ['Read', 'Bash', 'Agent', 'mcp__synthetic__erase_everything', 'agent-a']) assert.equal(receiptText.includes(`"${name}"`), false, name);
  // A second end of the same session, before or after a restart, adds nothing.
  assert.deepEqual(await engine.sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript}), {receipt: 'duplicate'});
  const restarted = await s.restart();
  assert.deepEqual(await restarted.sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript}), {receipt: 'duplicate'});
  const after = fs.readFileSync(path.join(s.data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').map(text => JSON.parse(text));
  assert.equal(after.filter(entry => entry.decision.plugin.event === 'session_receipt').length, 1);
});

test('said no is left out while an ask is unaccounted for, and is 0 once every ask ran', async t => {
  const {s} = await decidedSession(t);
  fs.appendFileSync(s.transcript, line(response(T0 + 60_000, 100)));
  const asked = s.raw('Agent', {prompt: 'p'});
  assert.equal((await s.launch(asked)).output.hookSpecificOutput?.permissionDecision, 'ask');
  // The same held call is decided again; it is still one call.
  assert.equal((await s.launch(asked)).output.hookSpecificOutput?.permissionDecision, 'ask');
  assert.deepEqual(s.engine().tally.counts(SESSION).decisions, {allowed: 3, asked: 1, saidYes: 0, stopped: 1});
  await s.ran(asked);
  assert.deepEqual(s.engine().tally.counts(SESSION).decisions, {allowed: 3, asked: 1, saidYes: 1, saidNo: 0, stopped: 1});
  await s.engine().sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript});
  const row = (await createReader({dataDir: s.data}).call('get_work_receipt', {sessionId: SESSION})).receipt;
  assert.deepEqual(row.decisions, {allowed: 3, asked: 1, saidYes: 1, saidNo: 0, stopped: 1});
});

test('Codex recorded usage is numeric with estimated coverage and unknown sub-agent counts', async t => {
  const {s} = await decidedSession(t, {host: 'codex'});
  const result = await s.engine().sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript});
  assert.equal(result.receipt, 'appended');
  const view = (await createReader({dataDir: s.data}).call('get_work_receipt', {})).receipt;
  assert.equal(view.host, 'codex');
  assert.equal(view.tokens, 40);
  assert.equal(view.tokenCoverage, 'estimated');
  assert.equal(view.subagents, undefined);
  assert.deepEqual(view.decisions, {allowed: 3, asked: 0, saidYes: 0, saidNo: 0, stopped: 1});
  assert.equal(view.burnPolicyMode, 'enforce');
  assert.match(view.firstActivityAt, /Z$/);
});

test('without a readable transcript, the receipt keeps the counts the ledger proves and leaves Burn\'s out', async t => {
  const {s} = await decidedSession(t);
  for (const transcriptPath of [undefined, path.join(s.base, 'missing.jsonl'), 'relative/path.jsonl', s.transcript.replace(/\.jsonl$/, '.txt')]) {
    assert.deepEqual(s.engine().burnFacts(SESSION, transcriptPath), {}, String(transcriptPath));
  }
  await s.engine().sessionReceipt({sessionId: SESSION});
  const view = (await createReader({dataDir: s.data}).call('get_work_receipt', {})).receipt;
  assert.equal(view.tokens, undefined);
  assert.equal(view.subagents, undefined);
  assert.deepEqual(view.decisions, {allowed: 3, asked: 0, saidYes: 0, saidNo: 0, stopped: 1});
  // A session this plugin never read is read at its end only when it is small enough.
  const big = path.join(s.base, 'claude', 'projects', '-secret-repo', 'big-session.jsonl');
  fs.writeFileSync(big, 'x'.repeat(receipts.UNREAD_LIMIT_BYTES + 1));
  assert.deepEqual(s.engine().burnFacts('big-session', big), {});
});

test('the builder copies counts by name, so content-shaped input never reaches the row', () => {
  const cursor = {depthByUuid: new Map([['u', 0]]), completed: new Set(['a', 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR']), ended: new Set(['b']), resumed: new Set(),
    children: new Map([['agent-a.jsonl', {}], ['agent-b.jsonl', {}], ['notes-file.txt', {}], ['agent-SYNTHETIC_PROMPT_MUST_NOT_APPEAR.jsonl', {}]])};
  const receipt = receipts.buildReceipt({
    counts: {first: T0, last: T0 + 5_000, decisions: {allowed: 2, asked: 0, saidYes: 0, saidNo: 0, stopped: 0, prompt: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR', command: 'rm -rf secret-repo'}, path: '/secret-repo/notes-file.txt'},
    cursor, view: {usage: {authoritative: 3, estimated: 0, missing: 0}, state: {totalTokens: 1234, startedAt: T0 - 1_000, lastEventAt: T0 + 9_000, sessionId: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'}, text: 'SYNTHETIC_TRANSCRIPT_MUST_NOT_APPEAR'},
    burnPolicyMode: 'enforce', pluginVersion: VERSION, transcriptPath: '/secret-repo/session.jsonl', prompt: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'});
  assert.deepEqual(receipt, {version: 1, firstActivityAt: iso(T0 - 1_000), lastActivityAt: iso(T0 + 9_000), tokens: 1234,
    subagents: {started: 3, finished: 2, endedWithoutFinishing: 1}, decisions: {allowed: 2, asked: 0, saidYes: 0, saidNo: 0, stopped: 0}, burnPolicyMode: 'enforce', pluginVersion: VERSION});
  const text = JSON.stringify(receipt);
  for (const sentinel of SENTINELS) assert.equal(text.includes(sentinel), false, sentinel);
  // Text where a count belongs is left out, never turned into a number.
  const unknown = receipts.buildReceipt({counts: {first: 'yesterday', last: null, decisions: {allowed: '3', asked: 0, saidYes: 0, stopped: 0}},
    view: {usage: {authoritative: 1}, state: {totalTokens: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'}}, burnPolicyMode: 'rm -rf /', pluginVersion: VERSION});
  assert.deepEqual(unknown, {version: 1, pluginVersion: VERSION});
  // Codex recorded totals retain estimated coverage; missing usage stays unknown.
  assert.equal(receipts.recordedTokens({usage: {authoritative: 2, estimated: 1, missing: 0}, state: {totalTokens: 10}}), 10);
  assert.equal(receipts.subagentCounts({...cursor, depthByUuid: new Map([['u', 1]])}), undefined);
  assert.equal(receipts.subagentCounts(null), undefined);
});

test('the receipt schema refuses anything but its own counts', () => {
  const good = {version: 1, firstActivityAt: iso(T0), lastActivityAt: iso(T0 + 1), tokens: 5, subagents: {started: 2, finished: 1, endedWithoutFinishing: 1},
    decisions: {allowed: 1, asked: 2, saidYes: 1, saidNo: 1, stopped: 0}, burnPolicyMode: 'shadow', pluginVersion: '0.3.17'};
  assert.equal(receipts.validateReceipt(structuredClone(good)).tokens, 5);
  assert.equal(receipts.validateReceipt({version: 1, pluginVersion: '1.2.3-beta.1'}).version, 1);
  const bad = [
    {...good, prompt: 'x'}, {...good, version: 2}, {...good, pluginVersion: 'latest'}, {...good, pluginVersion: undefined},
    {...good, tokens: -1}, {...good, tokens: 1.5}, {...good, tokens: '5'}, {...good, firstActivityAt: 'yesterday'},
    {...good, firstActivityAt: iso(T0 + 2)}, {...good, lastActivityAt: undefined}, {...good, burnPolicyMode: 'off'},
    {...good, subagents: {started: 1, finished: 1, endedWithoutFinishing: 1}}, {...good, subagents: {started: 1}},
    {...good, subagents: {started: 1, finished: 0, endedWithoutFinishing: 0, names: ['agent-a']}},
    {...good, decisions: {allowed: 1, asked: 1, saidYes: 2, stopped: 0}}, {...good, decisions: {allowed: 1, asked: 1, saidYes: 1, saidNo: 1, stopped: 0}},
    {...good, decisions: {allowed: 1, asked: 0, saidYes: 0}}, {...good, decisions: {...good.decisions, commands: 1}}, {...good, decisions: []},
    [], null, 'receipt',
  ];
  for (const receipt of bad) assert.throws(() => receipts.validateReceipt(receipt), /Work receipt metadata is invalid/, JSON.stringify(receipt));
});

test('the tally counts each call once by its deciding gate and ignores what is not a decision', () => {
  const tally = new receipts.SessionTally();
  let n = 0;
  const row = (gate, event, toolName, toolUseId, extra = {}, action = 'allow') => ({decisionId: `d-${n++}`, timestamp: iso(T0 + n * 1_000), action,
    plugin: {sessionId: 's', gate, event, toolName, toolUseId, ...extra}});
  tally.observe(row('spend', 'decision', 'Read', 'r1'));
  tally.observe(row('burn', 'fail_open', 'Read', 'r1'));          // not the gate that decides Read
  tally.observe(row('spend', 'decision', 'Agent', 'a1'));         // not the gate that decides a launch
  tally.observe(row('burn', 'decision', 'Agent', 'a1'));
  tally.observe(row('burn', 'decision', 'Agent', 'a2', {asked: true}, 'block'));
  tally.observe(row('receipt', 'outcome', 'Agent', 'a2'));        // it ran: said yes
  tally.observe(row('burn', 'decision', 'Task', 'a3', {asked: true}, 'block'));
  tally.observe(row('spend', 'decision', 'Bash', 'b1', {approvalRuleId: 'ask-push'}));
  tally.observe(row('receipt', 'fail_open', 'Bash', 'b1'));       // its result was reported, though not linked
  tally.observe(row('spend', 'decision', 'Bash', 'b2', {}, 'block'));
  tally.observe(row('spend', 'fail_closed', 'Bash', 'b3'));
  tally.observe(row('spend', 'fail_open', 'Edit', 'e1'));
  tally.observe(row('spend', 'decision', 'Edit', 'e2', {}, 'shadow'));
  tally.observe(row('burn', 'decision', 'Agent', 'x1', {reasonCode: 'license_required', policyReasonCode: 'burn_external_hook'}, 'shadow'));
  tally.observe(row('control', 'burn_policy_seeded', 'burn_policy', 'c1'));
  tally.observe({plugin: {sessionId: 'worker', gate: 'spend', event: 'integrity'}});
  tally.observe({timestamp: iso(T0)});
  assert.deepEqual(tally.counts('s'), {first: T0 + 1_000, last: T0 + 14_000, decisions: {allowed: 4, asked: 3, saidYes: 2, stopped: 2}});
  assert.deepEqual(tally.counts('never-seen'), {first: null, last: null, decisions: {allowed: 0, asked: 0, saidYes: 0, saidNo: 0, stopped: 0}});
  // Resumed activity invalidates the ending and retains cumulative decisions.
  tally.observe(row('control', 'session_receipt', 'session_receipt', 'z'));
  assert.equal(tally.receipted.has('s'), true);
  tally.observe(row('spend', 'decision', 'Read', 'r9'));
  assert.equal(tally.receipted.has('s'), false);
  assert.equal(tally.counts('s').decisions.allowed, 5);
});

test('the reader lists, verifies, exports and returns receipts, and still refuses anything off their schema', async t => {
  const {s} = await decidedSession(t, {license: true});
  await s.engine().sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript});
  await s.engine().flush();
  const reader = createReader({dataDir: s.data});
  const listed = await reader.call('list_decisions', {});
  const summary = listed.entries.find(entry => entry.event === 'session_receipt');
  assert.equal(summary.gate, 'control');
  assert.equal(summary.actor.sessionId, SESSION);
  assert.equal(summary.receipt.pluginVersion, VERSION);
  const verified = await reader.call('verify_chain', {});
  assert.equal(verified.ok, true);
  assert.equal(verified.entries, listed.totalEntries);
  // A receipt is not a decision in the day's totals.
  const status = await reader.call('get_status', {sessionId: SESSION});
  assert.equal(status.decisions, listed.entries.filter(entry => entry.entryType !== 'outcome' && !['integrity', 'session_receipt'].includes(entry.event)).length);
  const exported = await reader.call('export_receipts', {sessionId: SESSION});
  assert.equal(exported.verified, true);
  const row = exported.entries.find(entry => entry.decision.plugin.event === 'session_receipt');
  assert.deepEqual(row.decision.plugin.receipt, summary.receipt);
  // get_work_receipt: the latest, or one session's, with its signature and the chain status.
  const latest = await reader.call('get_work_receipt', {});
  assert.equal(latest.found, true);
  assert.deepEqual(latest.receipt, {sessionId: SESSION, host: 'claude-code', signedAt: row.decision.timestamp, ...summary.receipt});
  assert.deepEqual(latest.signature, {sequence: row.sequence, entryHash: row.entryHash, previousHash: row.previousHash, signature: row.signature,
    signerFingerprint: row.signerFingerprint, publicKeyHex: verified.publicKeyHex, valid: true});
  assert.deepEqual(latest.chain, {verified: true, entries: verified.entries, lastEntryHash: verified.lastEntryHash});
  assert.deepEqual(await reader.call('get_work_receipt', {sessionId: SESSION}), latest);
  assert.deepEqual(await reader.call('get_work_receipt', {sessionId: 'never-seen'}), {found: false, sessionId: 'never-seen'});
  await assert.rejects(reader.call('get_work_receipt', {path: 'outside.json'}), /Unexpected argument/);
  const rpc = await handleRpc({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'get_work_receipt', arguments: {}}}, reader);
  assert.deepEqual(rpc.result.structuredContent, latest);
  // A changed count no longer matches its signature: the receipt says so and the chain fails.
  const file = path.join(s.data, 'ledger', 'decisions.ndjson');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/"allowed":3/, '"allowed":30'));
  const tampered = await reader.call('get_work_receipt', {});
  assert.equal(tampered.receipt.decisions.allowed, 30);
  assert.equal(tampered.signature.valid, false);
  assert.deepEqual([tampered.chain.verified, tampered.chain.failedAtSequence], [false, row.sequence]);
  assert.equal((await reader.call('verify_chain', {})).ok, false);
  fs.writeFileSync(file, text);
});

// Rows signed by hand, to show the reader's schema: the 0.3.15 class of failure
// was a field the gates wrote that the reader did not allow; the reverse, a
// field the reader allows that does not belong, must still be refused.
async function signedLedger(t, plugins) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-work-receipt-reader-'));
  t.after(() => fs.rmSync(dataDir, {recursive: true, force: true}));
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({format: 'der', type: 'pkcs8'}).subarray(-32);
  const publicKey = keys.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
  fs.writeFileSync(path.join(dataDir, 'public-key.hex'), publicKey.toString('hex'));
  const store = new sdk.NdjsonDecisionLogStore('ledger', {home: dataDir, publicKeyHex: publicKey.toString('hex')});
  let previousHash = sdk.GENESIS_PREVIOUS_HASH;
  for (const [sequence, plugin] of plugins.entries()) {
    const decision = {decisionId: `d-${sequence}`, timestamp: iso(T0), action: 'allow', actor: {tenantId: 'local', sessionId: SESSION, agentId: SESSION},
      triggeredCap: null, triggeredScopeKey: null, projectedCents: 0, windowSpendBefore: 0, windowSpendAfter: 0, provider: 'claude-code',
      modelRequested: 'session_receipt', modelResolved: 'session_receipt', policyId: 'agentguard-codex', policyVersion: 1, enforcementMode: 'enforce',
      reasons: ['session_receipt'], plugin: {host: 'claude-code', toolName: 'session_receipt', sessionId: SESSION, toolUseId: `u-${sequence}`, gate: 'control', reasonCode: 'session_receipt', ...plugin}};
    const entry = await sdk.signDecision({sequence, decision, previousHash, privateKey, publicKey});
    await store.append(entry);
    previousHash = entry.entryHash;
  }
  return createReader({dataDir});
}

test('a hand-signed receipt row reads when it holds the schema and is refused when it does not', async t => {
  const receipt = {version: 1, decisions: {allowed: 0, asked: 0, saidYes: 0, saidNo: 0, stopped: 0}, pluginVersion: VERSION};
  const good = await signedLedger(t, [{event: 'session_receipt', receipt}]);
  assert.equal((await good.call('verify_chain', {})).ok, true);
  assert.equal((await good.call('get_work_receipt', {})).signature.valid, true);
  for (const plugin of [
    {event: 'session_receipt', receipt: {...receipt, files: 2}},
    {event: 'session_receipt', receipt: {...receipt, tokens: 'many'}},
    {event: 'session_receipt', receipt: {...receipt, subagents: {started: 1, finished: 0, endedWithoutFinishing: 0, names: 'agent-a'}}},
    {event: 'session_receipt'},
    {event: 'decision', receipt},
    {event: 'session_receipt', receipt, gate: 'spend'},
  ]) {
    const reader = await signedLedger(t, [plugin]);
    await assert.rejects(reader.call('list_decisions', {}), /Work receipt metadata is invalid/, JSON.stringify(plugin));
  }
  // Content under a receipt is refused before its schema is even read.
  const content = await signedLedger(t, [{event: 'session_receipt', receipt: {...receipt, prompt: 'SYNTHETIC_PROMPT_MUST_NOT_APPEAR'}}]);
  await assert.rejects(content.call('verify_chain', {}), /disallowed content/);
});

test('a request that waited for a worker gets its receipt when the worker starts, from the ledger alone, once', async t => {
  const {s} = await decidedSession(t);
  assert.equal(receipts.spoolRequest(s.data, SESSION, Date.now()), true);
  assert.equal(receipts.spoolRequest(s.data, SESSION, Date.now()), true);
  fs.appendFileSync(path.join(s.data, receipts.SPOOL), 'not json\n' + line({sessionId: 'bad id with spaces'}));
  const engine = await s.restart();
  for (const name of [receipts.SPOOL, receipts.SPOOL + '.recovering']) assert.equal(fs.existsSync(path.join(s.data, name)), false, name);
  const reader = createReader({dataDir: s.data});
  const listed = (await reader.call('list_decisions', {})).entries.filter(entry => entry.event === 'session_receipt');
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].receipt.decisions, {allowed: 3, asked: 0, saidYes: 0, saidNo: 0, stopped: 1});
  assert.equal(listed[0].receipt.tokens, undefined, 'no transcript is kept, so Burn\'s counts are left out');
  assert.equal(listed[0].receipt.subagents, undefined);
  assert.equal((await engine.sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript})).receipt, 'appended');
  const latest = (await reader.call('get_work_receipt', {})).receipt;
  assert.equal(latest.tokens, 40);
});

test('SessionEnd\'s request asks for a receipt, and keeps it for later when no worker answers', async t => {
  const env = environment(t);
  const calls = [];
  const answer = reply => async (message, options) => { calls.push({message, options}); if (reply instanceof Error) throw reply; return reply; };
  const spooled = () => { try { return fs.readFileSync(path.join(env.data, receipts.SPOOL), 'utf8').trim().split('\n').filter(Boolean).map(text => JSON.parse(text)); } catch { return []; } };
  const transcriptPath = path.join(env.base, 'session.jsonl');
  assert.equal(await receipts.sessionEnd({sessionId: 'a', transcriptPath, request: answer({receipt: 'appended'}), data: env.data, now: 5}), 'appended');
  assert.deepEqual(calls[0].message, {control: 'session-end', sessionId: 'a', receipt: {endedAt: 5, transcriptPath}});
  assert.deepEqual([calls[0].options.startWorker, calls[0].options.timeoutMs], [false, 500]);
  assert.equal(await receipts.sessionEnd({sessionId: 'b', transcriptPath: 'not/absolute.jsonl', request: answer({receipt: 'duplicate'}), data: env.data, now: 6}), 'duplicate');
  assert.deepEqual(calls[1].message.receipt, {endedAt: 6});
  assert.deepEqual(spooled(), []);
  // No worker running ({}), an older worker that ignores the request ({}), a timeout, a failed write.
  for (const [id, reply] of [['c', {}], ['d', new Error('worker_timeout')], ['e', {receipt: 'failed'}]]) {
    assert.equal(await receipts.sessionEnd({sessionId: id, transcriptPath, request: answer(reply), data: env.data, now: 7}), 'spooled');
  }
  assert.deepEqual(spooled(), [{sessionId: 'c', endedAt: 7}, {sessionId: 'd', endedAt: 7}, {sessionId: 'e', endedAt: 7}]);
  assert.equal(JSON.stringify(spooled()).includes(env.base), false, 'the transcript locator is never stored');
  // A session id the gates would not record gets the session-end cleanup and no receipt.
  assert.equal(await receipts.sessionEnd({sessionId: 'bad id with spaces', transcriptPath, request: answer({}), data: env.data}), 'invalid');
  assert.deepEqual(calls.at(-1).message, {control: 'session-end', sessionId: 'bad id with spaces'});
  assert.equal(spooled().length, 3);
  // Storage that cannot take the request fails open quietly.
  fs.rmSync(path.join(env.data, receipts.SPOOL));
  fs.mkdirSync(path.join(env.data, receipts.SPOOL));
  assert.equal(await receipts.sessionEnd({sessionId: 'f', transcriptPath, request: answer({}), data: env.data}), 'lost');
  // The wait follows the warm gate budget, between half a second and one.
  fs.writeFileSync(path.join(env.data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', hookBudgetMs: 1900}));
  assert.equal(receipts.receiptWaitMs(env.data), 1000);
});

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

test('the Live pane\'s status carries the last finished session\'s receipt, and reading it changes nothing', async t => {
  const {s} = await decidedSession(t);
  await s.engine().sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript});
  await s.engine().flush();
  const before = {data: tree(s.data), home: tree(s.home)};
  const run = args => JSON.parse(execFileSync(process.execPath, [path.join(root, 'runtime', 'mod-status.cjs'), ...args], {env: {...process.env, AGENTGUARD_MOD_STATUS_DEBUG: '1'}, encoding: 'utf8'}));
  const out = run(['--session', 'next-session']);
  const listed = (await createReader({dataDir: s.data}).call('list_decisions', {})).entries.find(entry => entry.event === 'session_receipt');
  assert.deepEqual(out.ledger.receipt, {sequence: listed.sequence, at: listed.timestamp, sessionId: SESSION, ...listed.receipt});
  assert.deepEqual({data: tree(s.data), home: tree(s.home)}, before);
  // A receipt older than the rows the pane scans is still found.
  const {ledgerStatus} = require('../runtime/mod-status.cjs');
  const engine = s.engine();
  for (let i = 0; i < 405; i++) await engine.handle({meta: metadata(s.raw('Read', {}, {session_id: 'busy-session'}), 'spend')});
  await engine.flush();
  const busy = await ledgerStatus('busy-session', s.data, false);
  assert.deepEqual(busy.receipt, out.ledger.receipt);
});


test('resumed activity signs linked cumulative summaries after restart on both hosts', async t => {
  for (const host of ['claude-code', 'codex']) await t.test(host, async t => {
    const s = await session(t, {host});
    const tool = host === 'codex' ? 'functions.collaboration.spawn_agent' : 'Agent';
    const first = s.raw(tool); await s.launch(first); await s.ran(first);
    await s.engine().sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript}); await s.engine().flush();
    const old = (await createReader({dataDir: s.data}).call('get_work_receipt', {})).signature;
    const engine = await s.restart();
    const second = s.raw(tool); await s.launch(second); await s.ran(second);
    assert.equal((await burn.sessionTally(SESSION, {data: s.data})).status, 'missing');
    assert.equal((await engine.sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript})).receipt, 'appended');
    await engine.flush();
    const rows = fs.readFileSync(path.join(s.data, 'ledger/decisions.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    const ends = rows.filter(row => row.decision.plugin.event === 'session_receipt');
    assert.equal(ends.length, 2); assert.equal(ends[1].decision.plugin.previousReceiptId, ends[0].decision.decisionId);
    assert.notEqual(ends[1].entryHash, old.entryHash); assert.equal(ends[1].decision.plugin.receipt.decisions.allowed, 2);
    assert.equal((await createReader({dataDir: s.data}).call('verify_chain', {})).ok, true);
    const tally = await burn.sessionTally(SESSION, {data: s.data});
    assert.equal(tally.status, 'verified'); assert.equal(tally.counts.launches, 2); assert.equal(tally.counts.allowed, 2);
    assert.equal((await engine.sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript})).receipt, 'duplicate');
  });
});

test('external standalone Burn owns admission while signed verdicts and host outcomes make a complete tally', async t => {
  const s = await session(t);
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, {recursive: true});
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({hooks: {PreToolUse: [{matcher: 'Agent', hooks: [{type: 'command', command: 'agentguard-burn hook'}]}]}}));
  const first = s.raw('Agent');
  await s.launch(first);
  assert.equal(s.engine().gateway, undefined, 'the plugin did not reserve the launch');
  assert.equal(burn.handlePreToolUse(first, s.home).hookSpecificOutput, undefined);
  await s.ran(first);
  fs.appendFileSync(s.transcript, line(response(T0 + 60000, 100)));
  const yes = s.raw('Agent'), no = s.raw('Agent');
  // Exercise both hook orders. Claude waits for both before invoking a tool.
  assert.equal(burn.handlePreToolUse(yes, s.home).hookSpecificOutput.permissionDecision, 'ask');
  await s.launch(yes); await s.ran(yes);
  await s.launch(no);
  assert.equal(burn.handlePreToolUse(no, s.home).hookSpecificOutput.permissionDecision, 'ask');
  await s.engine().sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript}); await s.engine().flush();
  const tally = await burn.sessionTally(SESSION, {data: s.data});
  assert.equal(tally.status, 'verified');
  assert.deepEqual(tally.counts, {launches: 3, allowed: 1, asked: 2, saidYes: 1, stopped: 0, shadow: 0, unrecorded: 0, unresolvedAsked: 1});
  const rows = fs.readFileSync(path.join(s.data, 'ledger/decisions.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  const imported = rows.filter(row => row.decision.plugin.externalReceiptHash);
  assert.equal(imported.length, 3);
  for (const row of imported) {
    const external = burn.readSpawnAdmission(s.home, SESSION, row.decision.plugin.toolUseId);
    assert.equal(row.decision.plugin.externalReceiptHash, burn.receiptDigest(external));
  }
  const outcome = rows.find(row => row.decision.plugin.event === 'outcome' && row.decision.plugin.toolUseId === yes.tool_use_id);
  assert.equal(outcome.decision.originalDecisionId, imported.find(row => row.decision.plugin.toolUseId === yes.tool_use_id).decision.decisionId);
  assert.equal((await createReader({dataDir: s.data}).call('verify_chain', {})).ok, true);
});

test('old, wrong-call, tampered and truncated external receipts stay missing instead of becoming an allow', async t => {
  const s = await session(t);
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, {recursive: true});
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({hooks: {PreToolUse: [{matcher: 'Agent', hooks: [{type: 'command', command: 'agentguard-burn hook'}]}]}}));
  const raw = s.raw('Agent'); await s.launch(raw);
  burn.handlePreToolUse({...raw, tool_use_id: 'different-call'}, s.home);
  const file = path.join(s.home, 'receipts.ndjson');
  const wrongCall = fs.readFileSync(file, 'utf8');
  const check = async () => {
    await s.engine().sessionReceipt({sessionId: SESSION, transcriptPath: s.transcript}); await s.engine().flush();
    assert.equal((await burn.sessionTally(SESSION, {data: s.data})).status, 'missing');
  };
  await check();
  const forged = JSON.parse(wrongCall.trim()); forged.payload.toolUseId = raw.tool_use_id;
  fs.writeFileSync(file, line(forged)); await check();
  fs.writeFileSync(file, wrongCall); burn.handlePreToolUse(raw, s.home);
  fs.writeFileSync(file, wrongCall); await check(); // durable head still names the removed last row
});
