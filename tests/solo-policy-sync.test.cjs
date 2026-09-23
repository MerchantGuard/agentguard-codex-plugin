'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {refreshOrgPolicy, pushPersonalPolicy, ENDPOINT} = require('../runtime/org-policy-refresh.cjs');
const {policyState} = require('../runtime/policy-state.cjs');
const {hashPolicy} = require('../runtime/org-policy-contract.cjs');
const {run, UPSELL} = require('../runtime/policy-cli.cjs');
const {Engine} = require('../runtime/engine.cjs');
const {scanCommands} = require('../runtime/command-policy.cjs');
const matrix = require('./helper-host-matrix.cjs');
const key = 'synthetic-solo-policy-key';
const solo = {paid: true, tier: 'solo', mode: 'enforce', reason: null};
const envelope = policy => ({version: 3, published_at: '2026-09-22T00:00:00.000Z', sha256: hashPolicy(policy), policy});
function fixture(t, local = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-solo-sync-'));
  const names = [...matrix.envKeys, 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_HOME'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  matrix.environment(process.env, data); process.env.AGENTGUARD_LICENSE_KEY = ''; process.env.AGENTGUARD_PLUGIN_POLICY = ''; process.env.AGENTGUARD_HOME = path.join(data, 'burn');
  const policy = {version: 1, mode: 'enforce', licenseKey: key, ...local};
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify(policy));
  t.after(() => { for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value; fs.rmSync(data, {recursive: true, force: true}); });
  return {data, policy, sessionId: 'solo-session'};
}

test('push projects only policy configuration and pull uses the identical envelope and hash on another machine', async t => {
  const options = fixture(t, {caps: [{window: 'per_day', amountCents: 1500}], unrelated: {receipt: 'private'}, teamPolicyFile: '', notifyOnStop: false});
  let sent;
  const result = await pushPersonalPolicy({...options, resolveLicense: async () => solo, put: async (url, request) => {
    assert.equal(url, ENDPOINT); assert.equal(request.key, key); sent = request.policy;
    assert.deepEqual(Object.keys(sent).sort(), ['caps', 'mode', 'version']); return {status: 200, body: envelope(sent)};
  }});
  assert.equal(result.sha256, hashPolicy(sent)); assert.equal(policyState(options.data, options.sessionId, {licenseReader: () => solo}).orgPolicy.sha256, result.sha256);
  const other = path.join(options.data, 'other-machine'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', licenseKey: key, caps: [{window: 'per_day', amountCents: 500}]}));
  const pulled = await refreshOrgPolicy({data: other, policy: {licenseKey: key}, getPolicy: async () => ({status: 200, body: envelope(sent)})});
  assert.equal(pulled.org_policy_sha256, result.sha256);
  const effective = policyState(other, 'other', {licenseReader: () => solo});
  assert.deepEqual(effective.config.caps, sent.caps); assert.equal(effective.config.licenseKey, key);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'policy.json'))).caps[0].amountCents, 500);
});

test('production push transport is precisely a fixed bearer PUT and refuses redirects', async t => {
  const options = fixture(t), previous = global.fetch;
  global.fetch = async (url, request) => {
    assert.equal(url, 'https://agentguard.run/api/org/policy'); assert.equal(request.method, 'PUT'); assert.equal(request.redirect, 'error');
    assert.deepEqual(Object.keys(request.headers).sort(), ['authorization', 'content-type']); assert.equal(request.headers.authorization, `Bearer ${key}`);
    const body = JSON.parse(request.body); assert.deepEqual(Object.keys(body), ['policy']); assert.ok(request.signal instanceof AbortSignal);
    assert.ok(!request.body.includes(key)); return {status: 200, json: async () => envelope(body.policy)};
  };
  t.after(() => { global.fetch = previous; });
  assert.ok((await pushPersonalPolicy({...options, resolveLicense: async () => solo})).sha256);
});

test('push rejects Free, Team, failed licenses and invalid configuration before uploading', async t => {
  const options = fixture(t), put = () => { throw new Error('Must not upload'); };
  for (const license of [{paid: false, tier: 'free'}, {paid: true, tier: 'startup', mode: 'enforce'}, {...solo, mode: 'shadow', reason: 'seat_limit'}]) {
    const result = await pushPersonalPolicy({...options, resolveLicense: async () => license, put}); assert.ok(result.error);
  }
  fs.writeFileSync(path.join(options.data, 'policy.json'), '{"version":1,"commandRules":[{"id":"bad","pattern":"[","action":"block"}]}');
  assert.equal((await pushPersonalPolicy({...options, resolveLicense: async () => solo, put})).error, UPSELL);
  fs.writeFileSync(path.join(options.data, 'policy.json'), JSON.stringify({version: 1, licenseKey: key, commandRules: [{id: 'bad', pattern: '[', action: 'block'}]}));
  await assert.rejects(pushPersonalPolicy({...options, resolveLicense: async () => solo, put}), /regular expression/);
});

test('Solo failed and malformed refreshes use local policy, and a worker-side failure is written to disk', async t => {
  const options = fixture(t), remote = envelope({version: 1, mode: 'enforce', deniedTools: ['^Read$']});
  await refreshOrgPolicy({...options, getPolicy: async () => ({status: 200, body: remote})});
  const engine = new Engine({licenseReader: () => solo}); await engine.init();
  try {
    const meta = {gate: 'spend', toolName: 'Read', sessionId: options.sessionId, toolUseId: 'one', host: matrix.host};
    assert.equal((await engine.handle({meta})).output.hookSpecificOutput.permissionDecision, 'deny');
    // A failure held only in worker memory changes nothing for Solo: the hook
    // and the worker both read the status file, so the snapshot still applies.
    engine.setSessionFailure(options.sessionId, 'org', 'org_policy_unavailable');
    assert.equal((await engine.handle({meta: {...meta, toolUseId: 'two'}})).output.hookSpecificOutput.permissionDecision, 'deny');
    engine.clearSessionFailure(options.sessionId, 'org');
    engine.recordOrgFailure(options.sessionId, 'org_policy_unavailable');
    assert.equal(JSON.parse(fs.readFileSync(path.join(options.data, 'org-policy-status.json'), 'utf8')).status, 'shadow');
    assert.equal((await engine.handle({meta: {...meta, toolUseId: 'three'}})).output.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(engine.context(meta).license.mode, 'enforce'); assert.equal(engine.context(meta).orgPolicy, null);
    engine.clearSessionFailure(options.sessionId, 'org');
    for (const response of [{status: 503}, {status: 200, body: {...remote, sha256: '0'.repeat(64)}}, {status: 429}]) {
      await refreshOrgPolicy({...options, getPolicy: async () => response});
      const state = engine.context(meta); assert.equal(state.orgPolicy, null); assert.equal(state.config.deniedTools, undefined); assert.equal(state.license.mode, 'enforce');
      assert.equal((await engine.handle({meta: {...meta, toolUseId: String(response.status) + response.body?.sha256}})).output.hookSpecificOutput.permissionDecision, 'allow');
    }
  } finally { await engine.close(); }
});

test('failed push leaves local policy intact and disables a cached Solo policy', async t => {
  const options = fixture(t), file = path.join(options.data, 'policy.json'), before = fs.readFileSync(file, 'utf8');
  await refreshOrgPolicy({...options, getPolicy: async () => ({status: 200, body: envelope({version: 1, deniedTools: ['Read']})})});
  const result = await pushPersonalPolicy({...options, resolveLicense: async () => solo, put: async () => { throw new Error('offline'); }});
  assert.match(result.error, /Local policy is unchanged/); assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(policyState(options.data, options.sessionId, {licenseReader: () => solo}).orgPolicy, null);
});

test('a pending GET cannot overwrite the policy that an explicit push publishes', async t => {
  const options = fixture(t); let release;
  const get = refreshOrgPolicy({...options, getPolicy: () => new Promise(resolve => { release = resolve; })});
  await new Promise(resolve => setImmediate(resolve));
  const push = pushPersonalPolicy({...options, resolveLicense: async () => solo, put: async (url, request) => ({status: 200, body: envelope(request.policy)})});
  release({status: 200, body: envelope({version: 1, deniedTools: ['old']})});
  await get; const result = await push;
  assert.equal(policyState(options.data, options.sessionId, {licenseReader: () => solo}).orgPolicy.sha256, result.sha256);
});

test('the CLI uses worker IPC without putting keys or configuration in the message', async t => {
  const options = fixture(t);
  const result = await run(['push'], {...options, request: async (message, requestOptions) => {
    assert.deepEqual(message, {control: 'policy-push', sessionId: options.sessionId}); assert.equal(requestOptions.data, options.data);
    return {sha256: 'a'.repeat(64), version: 4};
  }});
  assert.match(result, /Policy synced. Version 4/); assert.ok(!result.includes(key));
});

test('a cached personal snapshot is license bound and never applied to Free', async t => {
  const options = fixture(t);
  await refreshOrgPolicy({...options, getPolicy: async () => ({status: 200, body: envelope({version: 1, deniedTools: ['Read']})})});
  const free = policyState(options.data, options.sessionId, {licenseReader: () => ({paid: false, tier: 'free', mode: 'enforce'})});
  assert.equal(free.orgPolicy, null);
  fs.writeFileSync(path.join(options.data, 'policy.json'), JSON.stringify({...options.policy, licenseKey: 'different-key'}));
  assert.equal(policyState(options.data, options.sessionId, {licenseReader: () => solo}).orgPolicy, null);
});
