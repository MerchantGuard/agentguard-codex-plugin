'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sdk = require('@agentguard-run/spend');
const burn = require('@agentguard-run/burn');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const paid = {paid: true, mode: 'enforce', reason: null, tier: 'solo', seatsUsed: 1, seatLimit: 1, expiresAt: '2030-01-01T00:00:00.000Z'};
const failed = {paid: false, mode: 'shadow', reason: 'license_required', tier: 'solo'};
const free = {paid: false, mode: 'enforce', reason: null, tier: 'free', seatLimit: 1};
const readRows = engine => fs.readFileSync(engine.logStore.filePath, 'utf8').trim().split('\n').map(JSON.parse);
function meta(toolName, id, gate = 'spend') {
  return metadata({tool_name: toolName, tool_use_id: id, session_id: 'synthetic-license-session',
    agent_id: 'synthetic-agent', tool_input: {}, tool_response: {ok: true}, duration_ms: 2}, gate);
}
function fixture(t, policy = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-engine-license-'));
  const env = {PLUGIN_DATA: data, AGENTGUARD_HOME: path.join(data, 'burn'), AGENTGUARD_PLUGIN_POLICY: '', AGENTGUARD_LICENSE_KEY: ''};
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  fs.mkdirSync(env.AGENTGUARD_HOME);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, tenantId: 'synthetic-tenant', mode: 'enforce',
    maxCapability: 'payment_execute', caps: [], ethicalWall: ['^mcp__imanage__save_document$'], ...policy}));
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(data, {recursive: true, force: true}); });
  return {data, home: env.AGENTGUARD_HOME};
}
async function start(status) { const engine = new Engine({licenseReader: typeof status === 'function' ? status : () => status}); await engine.init(); return engine; }
const permission = result => result.output.hookSpecificOutput.permissionDecision;
async function verify(engine) { assert.equal((await sdk.verifyChain(readRows(engine), engine.publicKey)).ok, true); }

for (const item of [
  {name: 'valid paid license', status: paid, mode: 'enforce', permission: 'deny', reason: 'ethical_wall'},
  {name: 'cached license inside expiry grace', status: {...paid, offlineGrace: true, expiresAt: '2026-01-01T00:00:00.000Z'}, mode: 'enforce', permission: 'deny', reason: 'ethical_wall'},
  {name: 'license past expiry grace', status: {...failed, tier: 'solo'}, mode: 'shadow', permission: 'allow', reason: 'license_required'},
  {name: 'missing license', status: free, mode: 'enforce', permission: 'deny', reason: 'ethical_wall'},
  {name: 'active seat limit exceeded', status: {...failed, tier: 'solo', reason: 'seat_limit', seatsUsed: 2, seatLimit: 1}, mode: 'shadow', permission: 'allow', reason: 'seat_limit'},
  {name: 'network timeout without cached paid status', status: {...failed, source: 'unavailable'}, mode: 'shadow', permission: 'allow', reason: 'license_required'},
  {name: 'network timeout with cached paid status', status: {...paid, source: 'offline_cache'}, mode: 'enforce', permission: 'deny', reason: 'ethical_wall'},
]) test(`Engine ${item.name} selects the expected mode and reason`, async t => {
  fixture(t); const engine = await start(item.status);
  const result = await engine.handle({meta: meta('mcp__imanage__save_document', item.name.replaceAll(' ', '-'))});
  assert.equal(permission(result), item.permission); assert.equal(result.warning, undefined);
  const decision = readRows(engine)[0].decision;
  assert.equal(decision.enforcementMode, item.mode);
  assert.equal(decision.plugin.reasonCode, item.reason);
  assert.equal(decision.actor.agentId, 'synthetic-agent');
  if (item.mode === 'shadow') assert.equal(decision.action, 'shadow');
  await verify(engine);
});

test('Failed-license fallback overrides allowlists, capability gates and spend caps while accounting for measured unit costs', async t => {
  fixture(t, {allowedTools: ['^Read$'], maxCapability: 'read_only',
    toolRules: [{pattern: '.*', unitCostCents: 6, requiredCapability: 'payment_execute'}],
    caps: [{window: 'per_day', amountCents: 10, action: 'block', selector: {agentId: 'synthetic-agent'}}]});
  const engine = await start(failed);
  for (const [index, tool] of ['Bash', 'Read', 'mcp__imanage__save_document'].entries()) {
    const result = await engine.handle({meta: meta(tool, `free-${index}`)});
    assert.equal(permission(result), 'allow'); assert.equal(result.warning, undefined);
  }
  const rows = readRows(engine);
  assert.equal(rows.every(row => row.decision.enforcementMode === 'shadow' && row.decision.reasons.includes('license_required')), true);
  assert.equal(rows.every(row => row.decision.plugin.chargedCents === 6), true);
  const scope = sdk.buildScopeKey({tenantId: 'synthetic-tenant', agentId: 'synthetic-agent'});
  assert.equal(await engine.spendStore.getWindowSpend(scope, 'per_day'), 18);
  await verify(engine);
});

test('Paid policy shadow mode also observes an explicit ethical wall without denying', async t => {
  fixture(t, {mode: 'shadow'}); const engine = await start(paid);
  assert.equal(permission(await engine.handle({meta: meta('mcp__imanage__save_document', 'paid-shadow')})), 'allow');
  const decision = readRows(engine)[0].decision;
  assert.equal(decision.enforcementMode, 'shadow'); assert.equal(decision.action, 'shadow');
  assert.equal(decision.reasons.includes('ethical_wall'), true);
  await verify(engine);
});

test('A prior paid denial becomes an allowed signed shadow decision after license loss', async t => {
  fixture(t); let status = paid; const engine = await start(() => status);
  const request = {meta: meta('mcp__imanage__save_document', 'same-call')};
  assert.equal(permission(await engine.handle(request)), 'deny');
  status = failed;
  assert.equal(permission(await engine.handle(request)), 'allow');
  assert.equal(readRows(engine).at(-1).decision.plugin.reasonCode, 'license_required');
  await verify(engine);
});

test('Free Burn enforces its policy and signs receipts without changing its policy file', async t => {
  const f = fixture(t);
  const policy = structuredClone(burn.DEFAULT_POLICY); policy.mode = 'enforce'; policy.thresholds.fanout.stop = 1; policy.thresholds.fanout.warn = 1;
  const filename = path.join(f.home, 'burn-policy.json'); const text = JSON.stringify(policy);
  fs.writeFileSync(filename, text);
  const priorLoad = burn.loadPolicy;
  const engine = await start(free);
  for (let index = 0; index < 3; index++) {
    const result = await engine.handle({meta: meta('spawn_agent', `free-spawn-${index}`, 'burn')});
    assert.equal(permission(result), index === 0 ? 'allow' : 'deny'); assert.equal(result.warning, undefined);
  }
  assert.equal(fs.readFileSync(filename, 'utf8'), text); assert.equal(burn.loadPolicy, priorLoad);
  const receipts = fs.readFileSync(path.join(f.home, 'receipts.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 3); assert.equal(receipts.every(burn.verifyReceipt), true);
  assert.equal(receipts.every(receipt => receipt.payload.policy.mode === 'enforce'), true);
  assert.equal(readRows(engine).some(row => row.decision.action === 'block' && row.decision.plugin.license.reason === null), true);
  await verify(engine);
});

test('Free ignores team policy enforcement but resolves the key from the combined policy', async t => {
  const f = fixture(t, {ethicalWall: [], toolRules: [{pattern: '^Read$', unitCostCents: 2}]});
  const team = path.join(f.data, 'team.json');
  fs.writeFileSync(team, JSON.stringify({version: 1, mode: 'enforce', licenseKey: 'synthetic-team-key', toolRules: [{pattern: '^Read$', unitCostCents: 9}]}));
  process.env.AGENTGUARD_PLUGIN_POLICY = team;
  let key;
  const engine = await start(options => { key = options.policy.licenseKey; return free; });
  await engine.handle({meta: meta('Read', 'free-team')});
  assert.equal(key, 'synthetic-team-key'); assert.equal(readRows(engine)[0].decision.plugin.unitCostCents, 2);
  assert.equal(JSON.stringify(readRows(engine)).includes(key), false);
  await verify(engine);
});

test('Failed-license outcomes and internal failures also carry the licensing reason without a key', async t => {
  const f = fixture(t, {licenseKey: 'synthetic-private-key'}); const engine = await start(failed);
  await engine.handle({meta: meta('Read', 'outcome')});
  await engine.handle({meta: meta('Read', 'outcome', 'receipt')});
  fs.writeFileSync(path.join(f.data, 'policy.json'), '{bad');
  assert.equal(permission(await engine.handle({meta: meta('Read', 'broken')})), 'allow');
  const rows = readRows(engine);
  assert.equal(rows.every(row => row.decision.reasons.includes('license_required')), true);
  assert.equal(rows.at(-1).decision.plugin.event, 'fail_open');
  assert.equal(JSON.stringify(rows).includes('synthetic-private-key'), false);
  await verify(engine);
});

for (const [name, policy, tool] of [
  ['allowlist', {allowedTools: ['^Read$']}, 'Bash'],
  ['capability', {maxCapability: 'read_only'}, 'mcp__payments__purchase'],
  ['budget', {caps: [{window: 'per_call', amountCents: 1}], toolRules: [{pattern: '^Read$', unitCostCents: 2}]}, 'Read'],
]) test(`Free enforces the local ${name} and signs the blocked decision`, async t => {
  fixture(t, policy); const engine = await start(free);
  assert.equal(permission(await engine.handle({meta: meta(tool, name)})), 'deny');
  assert.equal(readRows(engine)[0].decision.plugin.license.reason, null);
  await verify(engine);
});

test('Free respects an explicit shadow policy', async t => {
  fixture(t, {mode: 'shadow'}); const engine = await start({...free, mode: 'shadow'});
  assert.equal(permission(await engine.handle({meta: meta('mcp__imanage__save_document', 'free-shadow')})), 'allow');
  assert.equal(readRows(engine)[0].decision.plugin.license.reason, null);
  await verify(engine);
});
