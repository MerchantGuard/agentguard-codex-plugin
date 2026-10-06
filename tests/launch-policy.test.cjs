'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('./helper-test-env.cjs');
const sdk = require('@agentguard-run/spend');
const {Engine} = require('../runtime/engine.cjs');
const common = require('../runtime/common.cjs');
const launchPolicy = require('../runtime/launch-policy.cjs');
const {validatePolicy} = require('../runtime/policy-schema.cjs');
const root = path.resolve(__dirname, '..');
const routing = {enabled: true, token_budget: 100, helper_types: ['search', 'logs'], keep_types: ['logs'], model: 'haiku'};
const permission = result => result.output.hookSpecificOutput?.permissionDecision ?? 'allow';

async function fixture(t, policy = {}, host = 'claude-code', tokens = 101) {
  const env = {...process.env}, base = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-launch-'));
  const data = path.join(base, 'data'), transcript = path.join(base, 's.jsonl'); fs.mkdirSync(data);
  for (const k of ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'AGENTGUARD_PLUGIN_POLICY', 'CLAUDE_PROJECT_DIR']) delete process.env[k];
  Object.assign(process.env, host === 'claude-code' ? {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_CONFIG_DIR: path.join(base, 'claude')} : {PLUGIN_ROOT: root, PLUGIN_DATA: data},
    {AGENTGUARD_HOME: path.join(base, 'burn'), CODEX_HOME: path.join(base, 'codex'), AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NOTIFY_SUPPRESS: '1'});
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', ...policy}));
  fs.writeFileSync(transcript, JSON.stringify({type: 'assistant', uuid: 'u', timestamp: new Date().toISOString(), message: {id: 'm', model: 'haiku', usage: {input_tokens: tokens}, content: []}}) + '\n');
  const engine = new Engine({licenseReader: () => ({paid: false, tier: 'free', mode: 'enforce', reason: null})}); await engine.init();
  t.after(async () => {await engine.close(); for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); fs.rmSync(base, {recursive: true, force: true});});
  let n = 0;
  const raw = extra => ({session_id: 's', tool_use_id: `launch-${n++}`, tool_name: host === 'claude-code' ? 'Agent' : 'spawn_agent', tool_input: {subagent_type: 'search', model: 'sonnet', prompt: 'PRIVATE PROMPT'}, transcript_path: transcript, cwd: base, permission_mode: 'default', ...extra});
  const gate = input => engine.handle({meta: {...common.metadata(input, 'burn'), permissionMode: input.permission_mode}, transcriptPath: transcript, workingDirectory: base});
  const sidecar = (id, depth) => {const dir = path.join(base, 's/subagents'); fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({spawnDepth: depth, agentType: 'search', ...(depth > 1 ? {parentAgentId: 'parent'} : {})}));};
  const entries = () => fs.readFileSync(path.join(data, 'ledger/decisions.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  return {engine, raw, gate, sidecar, data, transcript, entries, base};
}

test('depth 1, 2 and 3 use host lineage and pause strictly past max_depth', async t => {
  const f = await fixture(t, {max_depth: 2}); f.sidecar('first', 1); f.sidecar('second', 2);
  for (const [agent, depth, expected] of [[null, 1, 'allow'], ['first', 2, 'allow'], ['second', 3, 'ask']]) {
    const result = await f.gate(f.raw(agent ? {agent_id: agent} : {}));
    assert.equal(permission(result), expected); assert.equal(f.entries().at(-1).decision.plugin.launch.depth, depth);
  }
  assert.match(f.entries().at(-1).decision.reasons.join(' '), /launch_depth_limit/);
  assert.equal((await sdk.verifyChain(f.entries(), f.engine.publicKey)).ok, true);
  const {createReader} = require('../runtime/mcp.cjs');
  assert.equal((await createReader({dataDir: f.data}).call('verify_chain', {})).ok, true);
});
test('depth 1 preset pauses a copy with its identity and preserves Claude prompts', async t => {
  const f = await fixture(t, {max_depth: 1}); f.sidecar('copy', 1);
  const result = await f.gate(f.raw({agent_id: 'copy'}));
  assert.equal(permission(result), 'ask'); assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /a search agent \(copy\).*depth 2.*limit is 1/);
});
test('missing or malformed lineage falls back to count limits without guessing depth', async t => {
  const f = await fixture(t, {max_depth: 1});
  for (const agent_id of ['missing', '../escape']) {
    const result = await f.gate(f.raw({agent_id})); assert.equal(permission(result), 'allow');
    assert.equal(f.entries().at(-1).decision.plugin.launch.depth, null);
    assert.match(result.output.systemMessage, /existing count limit/);
  }
});
test('Codex has no reliable caller lineage and receives no invented depth', async t => {
  const f = await fixture(t, {max_depth: 1}, 'codex');
  const result = await f.gate(f.raw()); assert.equal(permission(result), 'allow');
  assert.equal(f.entries().at(-1).decision.plugin.launch.depth, null);
});
test('nonprompting depth holds need operator approval bound to caller and exact input', async t => {
  const f = await fixture(t, {max_depth: 1}); f.sidecar('copy', 1);
  const raw = f.raw({agent_id: 'copy', permission_mode: 'dontAsk'});
  assert.equal(permission(await f.gate(raw)), 'deny');
  const approvals = require('../runtime/policy-approval.cjs'), ticket = approvals.pending(f.data)[0]; approvals.approve(f.data, ticket.token);
  assert.equal(permission(await f.gate(raw)), 'allow');
  assert.equal(permission(await f.gate({...raw, tool_use_id: 'new'})), 'deny');
});
test('budget crossing uses spend downgrade, signs a receipt, keeps input local and preserves every input field', async t => {
  const f = await fixture(t, {helper_models: routing}); const raw = f.raw(); const result = await f.gate(raw);
  assert.equal(result.modelPatch, 'haiku');
  const row = f.entries().at(-1).decision;
  assert.equal(row.action, 'downgrade'); assert.equal(row.modelRequested, 'sonnet'); assert.equal(row.modelResolved, 'haiku');
  assert.equal(row.plugin.launch.tokenBudget, 100); assert.equal(row.plugin.launch.sessionTokens, 101);
  assert.equal(JSON.stringify(f.entries()).includes('PRIVATE PROMPT'), false);
  assert.equal(JSON.stringify(common.metadata(raw, 'burn')).includes('PRIVATE PROMPT'), false);
  const output = common.normalizeHookOutput(launchPolicy.applyModel(result.output, result.modelPatch, raw, 'claude-code'));
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.deepEqual(output.hookSpecificOutput.updatedInput, {...raw.tool_input, model: 'haiku'});
  assert.equal((await sdk.verifyChain(f.entries(), f.engine.publicKey)).ok, true);
});
test('exact budget, keep list, unlisted types, resumes and default off preserve launch behavior', async t => {
  const f = await fixture(t, {helper_models: routing}, 'claude-code', 100);
  assert.equal((await f.gate(f.raw())).modelPatch, undefined);
  for (const [policy, input] of [[{helper_models: routing}, {subagent_type: 'logs'}], [{helper_models: routing}, {subagent_type: 'writer'}], [{helper_models: routing}, {subagent_type: 'search', resume: 'old'}], [{}, {subagent_type: 'search'}], [{helper_models: {enabled: false}}, {subagent_type: 'search'}]]) {
    const g = await fixture(t, policy);
    const result = await g.gate(g.raw({tool_input: input})); assert.equal(result.modelPatch, undefined); assert.equal(permission(result), 'allow');
  }
});
test('depth ask can carry a helper model rewrite without bypassing the prompt', async t => {
  const f = await fixture(t, {max_depth: 1, helper_models: routing}); f.sidecar('copy', 1);
  const result = await f.gate(f.raw({agent_id: 'copy'})); assert.equal(permission(result), 'ask'); assert.equal(result.modelPatch, 'haiku');
});
test('SDK or hook errors fail open and leave auditable recovery metadata', async t => {
  const f = await fixture(t, {helper_models: routing});
  const original = f.engine.launchAdmission; f.engine.launchAdmission = () => {throw new Error('injected');};
  const result = await f.gate(f.raw()); f.engine.launchAdmission = original;
  assert.equal(permission(result), 'allow'); assert.equal(result.warning, true);
  assert.equal(f.entries().at(-1).decision.plugin.event, 'fail_open');
  const hook = spawnSync(process.execPath, [path.join(root, 'hooks/burn-gate.cjs')], {input: '{broken', encoding: 'utf8', env: process.env});
  assert.equal(hook.status, 0); assert.deepEqual(JSON.parse(hook.stdout), {});
  assert.match(hook.stderr, /allowed tool call/);
});
test('policy schema rejects invalid depth and incomplete helper routing', () => {
  for (const value of [-1, 0, 1.5, '2']) assert.throws(() => validatePolicy({version: 1, max_depth: value}));
  assert.throws(() => validatePolicy({version: 1, helper_models: {enabled: true}}));
  for (const value of [undefined, null, 1, 2, 3]) assert.doesNotThrow(() => validatePolicy({version: 1, max_depth: value}));
});

test('observed Codex collaboration alias uses counts and supports full input model replacement', async t => {
  const f = await fixture(t, {max_depth: 1, helper_models: {...routing, helper_types: ['default'], model: 'gpt-6-luna'}}, 'codex');
  const raw = f.raw({tool_name: 'collaborationspawn_agent', tool_input: {model: 'gpt-6-sol', fork_turns: 'none', task_name: 'search', message: 'PRIVATE PROMPT'}, model: 'gpt-6-luna'});
  const result = await f.gate(raw);
  assert.equal(result.modelPatch, 'gpt-6-luna'); assert.equal(f.engine.gateway.peek('s').state.spawnCount, 1);
  const output = launchPolicy.applyModel(result.output, result.modelPatch, raw, 'codex');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(output.hookSpecificOutput.updatedInput, {...raw.tool_input, model: 'gpt-6-luna'});
  const row = f.entries().at(-1).decision;
  assert.equal(row.plugin.launch.depth, null); assert.equal(row.plugin.launch.agentType, 'default');
  assert.equal(row.action, 'downgrade'); assert.equal((await sdk.verifyChain(f.entries(), f.engine.publicKey)).ok, true);
});
test('Codex full-history and custom-role routing suggests a model and holds until operator approval', async t => {
  const f = await fixture(t, {helper_models: {...routing, helper_types: ['default'], model: 'gpt-6-luna'}}, 'codex');
  const raw = f.raw({tool_input: {fork_turns: 'all', message: 'PRIVATE PROMPT'}, model: 'gpt-6-sol'});
  const result = await f.gate(raw); assert.equal(permission(result), 'deny'); assert.equal(result.modelPatch, undefined);
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /Choose gpt-6-luna/);
  assert.equal(f.entries().at(-1).decision.plugin.launch.modelDecision, 'suggestion');
  const approvals = require('../runtime/policy-approval.cjs'); approvals.approve(f.data, approvals.pending(f.data)[0].token);
  assert.equal(permission(await f.gate(raw)), 'allow');
  const dir = path.join(f.base, '.codex'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'config.toml'), '[agents.explorer]\nmodel="gpt-6-sol"\n');
  const custom = f.raw({tool_input: {fork_turns: 'none', agent_type: 'explorer', model: 'gpt-6-sol'}});
  assert.equal(launchPolicy.metadata(custom, 'codex').launch.modelRewriteSupported, false);
});
test('Claude unsupported fork routing uses its native permission request', async t => {
  const f = await fixture(t, {helper_models: {...routing, helper_types: ['fork']}});
  const result = await f.gate(f.raw({tool_input: {subagent_type: 'fork', model: 'sonnet'}}));
  assert.equal(permission(result), 'ask'); assert.equal(result.modelPatch, undefined);
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /Choose haiku/);
});
test('Codex cumulative usage replaces prior totals, survives reopening and never adds cached tokens twice', async t => {
  const f = await fixture(t, {helper_models: {...routing, helper_types: ['default'], model: 'gpt-6-luna'}}, 'codex', 0);
  const write = tokens => fs.writeFileSync(f.transcript, JSON.stringify({type: 'event_msg', timestamp: new Date().toISOString(), payload: {type: 'token_count', info: {total_token_usage: {total_tokens: tokens, cached_input_tokens: 80}}}})+'\n');
  const raw = () => f.raw({tool_input: {fork_turns: 'none', model: 'gpt-6-sol'}});
  write(100); assert.equal((await f.gate(raw())).modelPatch, undefined);
  write(101); assert.equal((await f.gate(raw())).modelPatch, 'gpt-6-luna');
  await f.gate(raw()); assert.equal(f.engine.gateway.peek('s').state.totalTokens, 101);
  const burn = require('@agentguard-run/burn');
  const reopened = new burn.Gateway(process.env.AGENTGUARD_HOME);
  launchPolicy.observeCodexUsage(burn, reopened, {sessionId: 's'}, f.transcript);
  assert.equal(reopened.peek('s').state.totalTokens, 101);
  assert.equal(reopened.peek('s').state.totalCacheRead, 80);
  assert.equal(reopened.peek('s').usage.estimated > 0, true);
});
test('unknown usage, newer Burn ownership and disabled routing never invent usage', async t => {
  const f = await fixture(t, {helper_models: routing}, 'codex');
  fs.writeFileSync(f.transcript, '{"type":"unknown"}\n');
  const result = await f.gate(f.raw()); assert.equal(result.modelPatch, undefined);
  assert.equal(f.entries().at(-1).decision.plugin.launch.sessionTokens, null);
  assert.match(result.output.systemMessage, /cannot read session token usage/);
  fs.writeFileSync(f.transcript, JSON.stringify({type: 'event_msg', timestamp: new Date().toISOString(), payload: {type: 'token_count', info: {total_token_usage: {total_tokens: 101, cached_input_tokens: 80}}}})+'\n');
  let calls = 0;
  launchPolicy.observeCodexUsage({readCodexTranscriptUsage: () => []}, {observe: () => calls++}, {sessionId: 's'}, f.transcript);
  assert.equal(calls, 0);
  assert.equal(launchPolicy.observedTokens({state: {totalTokens: 0}, usage: {missing: 1}}), null);
});
test('session settings tighten depth and cannot route a globally kept type', async t => {
  const f = await fixture(t, {max_depth: 1, helper_models: {...routing, keep_types: ['search']}, sessions: {s: {max_depth: 3, helper_models: routing}}});
  f.sidecar('copy', 1);
  const result = await f.gate(f.raw({agent_id: 'copy'}));
  assert.equal(permission(result), 'ask'); assert.equal(result.modelPatch, undefined);
});
test('policy CLI names the preset, shows its diff and configures local opt-in routing', async t => {
  const f = await fixture(t), cli = require('../runtime/policy-cli.cjs');
  assert.match(await cli.run(['preset', 'copies-ask'], {data: f.data}), /After max_depth: 1/);
  await cli.run(['set-depth', '3'], {data: f.data});
  await cli.run(['helper-model', '100', 'haiku', 'search,logs', 'logs'], {data: f.data});
  let policy = JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json')));
  assert.equal(policy.max_depth, 3); assert.deepEqual(policy.helper_models, routing);
  await cli.run(['set-depth', 'off'], {data: f.data}); await cli.run(['helper-model', 'off'], {data: f.data});
  policy = JSON.parse(fs.readFileSync(path.join(f.data, 'policy.json')));
  assert.equal(policy.max_depth, null); assert.deepEqual(policy.helper_models, {enabled: false});
});
test('an agent cannot turn off depth or routing through the policy CLI', async t => {
  const f = await fixture(t, {max_depth: 1, helper_models: routing});
  for (const args of ['set-depth off', 'helper-model off', 'helper-model 999999 haiku search none']) {
    const raw = f.raw({tool_name: 'Bash', tool_input: {command: `node ${path.join(root, 'runtime/policy-cli.cjs')} ${args}`}, cwd: root});
    const result = await f.engine.handle({meta: common.metadata(raw, 'spend'), workingDirectory: root});
    assert.equal(permission(result), 'deny', args);
  }
});
test('shadow mode records depth and model proposals without applying either', async t => {
  const f = await fixture(t, {mode: 'shadow', max_depth: 1, helper_models: routing}); f.sidecar('copy', 1);
  const result = await f.gate(f.raw({agent_id: 'copy'}));
  assert.equal(permission(result), 'allow'); assert.equal(result.modelPatch, undefined);
  assert.equal(f.entries().at(-1).decision.plugin.launch.depthDecision, 'over_limit');
  assert.equal(f.entries().at(-1).decision.plugin.launch.modelDecision, 'shadow');
});
for (const host of ['claude-code', 'codex']) test(`${host}: missing lineage still enforces the existing count limit`, async t => {
  const f = await fixture(t, {max_depth: 1}, host);
  for (let i = 0; i < 15; i++) assert.equal(permission(await f.gate(f.raw({agent_id: 'no-sidecar'}))), 'allow');
  const result = await f.gate(f.raw({agent_id: 'no-sidecar'}));
  assert.equal(permission(result), host === 'claude-code' ? 'ask' : 'deny');
  assert.equal(f.entries().at(-1).decision.plugin.launch.depth, null);
  assert.equal(f.entries().at(-1).decision.action, 'block');
});
test('new launch messages obey product copy rules', async t => {
  const f = await fixture(t, {max_depth: 1, helper_models: routing}); f.sidecar('copy', 1);
  const results = [await f.gate(f.raw({agent_id: 'copy'})), await f.gate(f.raw({agent_id: 'missing'}))];
  for (const result of results) assert.doesNotMatch(JSON.stringify(result.output), /[\u2013\u2014\u00ae\u2122]|--|Agent Guard|Codex asks|\bsavings\b|\bsaved\b/i);
});
test('policy sync projects out local launch settings at both scopes without changing them', async t => {
  const source = {max_depth: 2, helper_models: routing, sessions: {s: {max_depth: 1, helper_models: routing, allowedTools: ['Read']}}};
  const f = await fixture(t, source), cli = require('../runtime/policy-cli.cjs');
  const local = cli.localPolicy(f.data), before = JSON.stringify(local), projected = cli.policyConfig(local);
  assert.equal(projected.max_depth, undefined); assert.equal(projected.helper_models, undefined);
  assert.deepEqual(projected.sessions, {s: {allowedTools: ['Read']}}); assert.equal(JSON.stringify(local), before);
  await cli.run(['set-depth', '3'], {data: f.data});
  assert.deepEqual(cli.localPolicy(f.data).sessions, source.sessions);
  const text = await cli.run(['show'], {data: f.data});
  assert.match(text, /Launch depth limit: 1; a stricter global depth still applies/);
});
