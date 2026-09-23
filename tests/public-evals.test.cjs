'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const score = require('../scripts/score-public-evals.cjs');
const SET = 'results/claude-opus-5.5-high/2026-09-22T20-34-17.138Z';
const sdkAvailable = fs.existsSync(path.join(__dirname, '../scripts/public-evals-deps/node_modules/@agentguard-run/burn/package.json'));
const usageTest = {skip: sdkAvailable ? false : 'Run npm run setup:public-evals to install the pinned analysis SDK'};
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-evals-test-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
const assistant = (command, id = 'call-1', extra = {}) => ({type: 'assistant', uuid: id, timestamp: '2026-09-22T20:35:00Z', message: {id, model: 'claude-opus-5.5', content: [{type: 'tool_use', id, name: 'Bash', input: {command}}], ...extra}});
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('result-set paths accept pinned source locators and reject traversal or another host', () => {
  assert.equal(score.resultSet(SET.slice(8)), SET);
  assert.equal(score.resultSet('https://github.com/vercel/next-evals-oss/tree/main/' + SET), SET);
  for (const value of ['results/../x', 'https://example.invalid/' + SET, SET + '/../../outside', 'results/model/latest']) assert.throws(() => score.resultSet(value));
});
test('current inventory includes every timestamp and docs variant only for the requested harnesses', () => {
  const older = SET.replace('2026-09-22', '2026-09-21'), docs = SET.replace('high/', 'high--agents-md/'), grok = SET.replace('claude-opus-5.5-high', 'grok-4.7');
  const entries = new Map([SET, older, docs, grok].map(set => [set + '/agent-example/run-1/result.json', {}]));
  const metadata = {experiments: [{name: 'claude-opus-5.5-high', agentHarness: 'Claude Code'}, {name: 'grok-4.7', agentHarness: 'OpenCode'}]};
  assert.deepEqual(score.selectSets(entries, metadata, [], true), [docs, older, SET].sort());
  assert.equal(score.selectSets(entries, metadata, [grok], true).length, 4);
});
test('Claude tool_use parsing deduplicates provider rows and ignores tool results and prose', () => {
  const row = assistant('RAW_COMMAND_MARKER');
  const parsed = score.parseTranscript(lines([row, row, {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'call-1', content: 'not a call'}]}}]));
  assert.equal(parsed.format, 'claude-code'); assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].input.command, 'RAW_COMMAND_MARKER');
  assert.equal(score.parseTranscript(lines([row]) + '{broken\n').malformed, 1);
});
test('Codex exec lifecycle counts starts for commands and completions for changes exactly once', () => {
  const command = {id: 'command', type: 'command_execution', command: 'git status'};
  const edit = {id: 'edit', type: 'file_change', changes: [{path: '/workspace/.env', kind: 'update'}]};
  const events = [{type: 'thread.started'}, {type: 'item.started', item: command}, {type: 'item.completed', item: command}, {type: 'item.started', item: edit}, {type: 'item.completed', item: edit}, {type: 'item.completed', item: edit},
    {type: 'item.started', item: {id: 'web', type: 'web_search', query: '', action: {type: 'other'}}}, {type: 'item.completed', item: {id: 'web', type: 'web_search', query: 'Next.js', action: {type: 'search', query: 'Next.js'}, output: 'IGNORED_RESULT'}},
    {type: 'item.started', item: {id: 'todo', type: 'todo_list', items: []}}, {type: 'item.updated', item: {id: 'todo', type: 'todo_list', items: []}},
    {type: 'item.started', item: {id: 'collab', type: 'collab_tool_call', tool: 'wait'}}, {type: 'item.completed', item: {id: 'reason', type: 'reasoning', text: 'not a tool'}}];
  const parsed = score.parseTranscript(lines(events));
  assert.equal(parsed.format, 'codex-exec'); assert.deepEqual(parsed.actions.map(action => action.tool), ['Bash', 'apply_patch', 'WebSearch', 'TodoWrite', 'wait']);
  assert.equal(parsed.actions.filter(action => action.category === 'command_or_edit').length, 2);
  assert.deepEqual(parsed.actions[2].input, {query: 'Next.js', action: {type: 'search', query: 'Next.js'}});
});
test('OpenCode native tools are adapted without treating their outputs as input', () => {
  const parsed = score.parseTranscript(lines([{type: 'tool_use', part: {type: 'tool', callID: 'one', tool: 'bash', state: {input: {command: 'git status'}, output: 'rm -rf ~'}}}]));
  assert.equal(parsed.format, 'opencode'); assert.deepEqual(parsed.actions[0].input, {command: 'git status'}); assert.equal(parsed.actions[0].tool, 'Bash');
});
test('curl uses argument arrays, verifies blob hashes and reuses only matching cache files', async t => {
  const file = path.join(fixture(t), 'artifact.json'), data = Buffer.from('{"status":"passed"}'); let calls = 0;
  const runner = async (command, args) => { calls++; assert.equal(command, 'curl'); assert.ok(args.includes('--proto')); fs.writeFileSync(args[args.indexOf('--output') + 1], data); };
  await score.curlFile('https://raw.githubusercontent.com/vercel/next-evals-oss/main/LICENSE', file, score.blobHash(data), runner);
  await score.curlFile('https://raw.githubusercontent.com/vercel/next-evals-oss/main/LICENSE', file, score.blobHash(data), runner); assert.equal(calls, 1);
  fs.writeFileSync(file, 'corrupt'); await score.curlFile('https://raw.githubusercontent.com/vercel/next-evals-oss/main/LICENSE', file, score.blobHash(data), runner); assert.equal(calls, 2);
  await assert.rejects(score.curlFile('https://example.invalid/private', file, undefined, runner), /invalid_download_host/);
  await assert.rejects(score.curlFile('https://raw.githubusercontent.com/vercel/next-evals-oss/main/LICENSE', file, '0'.repeat(40), runner), /download_hash_mismatch/);
});
test('the actual Free Engine stops recovered matches, allows negatives, and suppresses notifications', async () => {
  await score.withEngine(async engine => {
    assert.equal(process.env.AGENTGUARD_NOTIFY_SUPPRESS, '1');
    const positive = await score.evaluateAction(engine, {id: 'positive', tool: 'Bash', input: {command: "rm -rf ~; cat <<'EOF'\nit's\nEOF"}}, 'run-test', 'claude-code');
    assert.deepEqual(positive.rules, ['GP002']); assert.equal(positive.stop, true); assert.equal(positive.failOpen, false);
    const fallback = await score.evaluateAction(engine, {id: 'fallback', tool: 'Bash', input: {command: "rm -rf ~; printf '"}}, 'run-test', 'codex-exec');
    assert.equal(fallback.stop, true); assert.equal(fallback.incomplete, true);
    const clean = await score.evaluateAction(engine, {id: 'negative', tool: 'Bash', input: {command: "cat <<'EOF'\nit's\nEOF"}}, 'run-test', 'codex-exec');
    assert.equal(clean.stop, false); assert.equal(clean.incomplete, false);
    const row = JSON.parse(fs.readFileSync(engine.logStore.filePath, 'utf8').split('\n')[0]); assert.equal(row.decision.enforcementMode, 'enforce'); assert.equal(row.decision.plugin.license.tier, 'free');
  });
});
test('Burn 0.3.5 prices explicit model aliases and deduplicates Claude usage', usageTest, t => {
  const file = path.join(fixture(t), 'transcript.jsonl');
  const row = assistant('git status', 'response', {usage: {input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 20}});
  fs.writeFileSync(file, lines([row, row]));
  const usage = score.usageFor(file, 'claude-code');
  assert.equal(usage.turns, 1); assert.equal(usage.total_tokens, 230); assert.equal(usage.cache_read_tokens, 200);
  assert.equal(usage.spawns, 0); assert.ok(Math.abs(usage.list_cost_usd.min - 0.00048) < 1e-12);
  row.message.model = 'claude-unknown'; fs.writeFileSync(file, lines([row]));
  assert.equal(score.usageFor(file, 'claude-code').list_cost_usd, null);
});
test('Codex usage and model identity use Burn pricing without charging cached input twice', usageTest, t => {
  const file = path.join(fixture(t), 'transcript.jsonl');
  fs.writeFileSync(file, lines([{type: 'thread.started'}, {type: 'turn.completed', usage: {input_tokens: 210, cached_input_tokens: 200, output_tokens: 20}}]));
  const usage = score.usageFor(file, 'codex-exec', 'openai/gpt-6-sol?reasoningEffort=high');
  assert.equal(usage.total_tokens, 230); assert.equal(usage.cache_read_tokens, 200); assert.ok(Math.abs(usage.list_cost_usd.min - 0.00026) < 1e-12);
  fs.writeFileSync(file, lines([{type: 'thread.started'}, {type: 'turn.completed', usage: {input_tokens: 300000, cached_input_tokens: 200000, output_tokens: 20000}}]));
  const aggregate = score.usageFor(file, 'codex-exec', 'openai/gpt-6-sol?reasoningEffort=high');
  assert.ok(Math.abs(aggregate.list_cost_usd.min - 0.44) < 1e-12); assert.ok(Math.abs(aggregate.list_cost_usd.max - 0.78) < 1e-12);
  assert.equal(aggregate.aggregate_context_ranges, 1);
});
test('OpenCode numeric usage includes separate reasoning, deduplicates steps, and leaves unknown prices unpriced', usageTest, t => {
  const file = path.join(fixture(t), 'transcript.jsonl');
  const row = {type: 'step_finish', timestamp: 1, part: {id: 'step-1', cost: 999, tokens: {input: 10, output: 20, reasoning: 5, cache: {read: 200, write: 0}}}};
  fs.writeFileSync(file, lines([row, row, {type: 'step_finish', part: {tokens: {input: -1}}}]));
  const usage = score.usageFor(file, 'opencode', 'xai/grok-4.7');
  assert.equal(usage.turns, 1); assert.equal(usage.total_tokens, 235); assert.equal(usage.cache_read_tokens, 200);
  assert.equal(usage.list_cost_usd, null); assert.deepEqual(usage.unpriced_models, ['grok-4.7']); assert.equal(usage.unpriced_turns, 1);
  assert.equal(usage.unsupported_usage_rows, 1); assert.equal(usage.spawns, null);
});
test('complete cached CLI replay reports status-based false positives without transcript content', usageTest, async t => {
  const directory = fixture(t), revision = 'a'.repeat(40), cache = path.join(directory, 'cache'), root = path.join(cache, revision), output = path.join(directory, 'reports');
  const files = new Map([
    ['LICENSE', 'MIT License\n\nCopyright (c) 2025 Vercel\n'],
    ['agent-results.json', JSON.stringify({metadata: {experiments: [{name: 'claude-opus-5.5-high', agentHarness: 'Claude Code'}]}})],
    [SET + '/agent-example/run-1/result.json', JSON.stringify({status: 'passed', model: 'anthropic/claude-opus-5.5', o11y: {shellCommands: ['RAW_RESULT_MARKER']}})],
    [SET + '/agent-example/run-1/transcript-raw.jsonl', lines([assistant('rm -rf ~; printf RAW_COMMAND_MARKER')])],
    [SET + '/agent-example/run-2/result.json', JSON.stringify({status: 'failed'})],
    [SET + '/agent-example/run-2/transcript-raw.jsonl', lines([assistant('rm -rf ~')])],
    [SET + '/agent-missing/run-1/result.json', JSON.stringify({status: 'passed'})],
  ]);
  const tree = [];
  for (const [name, data] of files) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, data); tree.push({path: name, type: 'blob', sha: score.blobHash(Buffer.from(data))}); }
  fs.writeFileSync(path.join(root, 'tree.json'), JSON.stringify({tree, truncated: false}));
  const reports = await score.main(['--cache', cache, '--output', output, '--revision', revision, '--all-current']);
  assert.equal(reports[0].counts.runs, 3); assert.equal(reports[0].counts.passed_runs, 2); assert.equal(reports[0].counts.missing_transcripts, 1);
  assert.equal(reports[0].counts.actions_scanned, 2); assert.equal(reports[0].counts.would_stop, 2); assert.equal(reports[0].counts.stops_on_passing_runs, 1); assert.equal(reports[0].counts.engine_fail_open, 0);
  assert.deepEqual(reports[0].false_positives[0].rule_ids, ['GP002']);
  for (const file of fs.readdirSync(output)) assert.doesNotMatch(fs.readFileSync(path.join(output, file), 'utf8'), /RAW_COMMAND_MARKER|RAW_RESULT_MARKER|rm -rf|shellCommands|tool_input/);
});
