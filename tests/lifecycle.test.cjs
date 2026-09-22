'use strict';
const matrix = require('./helper-host-matrix.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {activate} = require('./helper-worker-license.cjs');
const {run} = require('../runtime/verify.cjs');
const {createReader, handleRpc} = require('../runtime/mcp.cjs');
const {licenseStatusPath} = require('../runtime/license.cjs');
const root = path.resolve(__dirname, '..');
function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-lifecycle-'));
  const before = {...process.env};
  matrix.environment(process.env, data); process.env.AGENTGUARD_HOME = path.join(data, 'sdk');
  delete process.env.AGENTGUARD_LICENSE_KEY; delete process.env.AGENTGUARD_PLUGIN_POLICY;
  t.after(() => {
    spawnSync(process.execPath, ['runtime/control.cjs', 'stop'], {cwd: root, env: process.env, timeout: 3000});
    process.env = before; fs.rmSync(data, {recursive: true, force: true});
  });
  return data;
}
const paid = {valid: true, tier: 'solo', seats: 1, expiresAt: new Date(Date.now()+86400000).toISOString(), features: {maxActiveSeats: 1}};
test('activation reads a key from stdin flow, writes private local policy and resolves seats once', async t => {
  const data = fixture(t), key = 'ag_synthetic_activation_key'; let calls = [];
  const status = await activate(key, {data, sessionId: 'synthetic-session', postJson: async (url, body) => {
    calls.push({url, body}); return url.endsWith('/validate') ? paid : {ok: true, activeSeats: 1, maxActiveSeats: 1};
  }});
  assert.equal(status.mode, 'enforce'); assert.equal(status.seatsUsed, 1);
  assert.equal(calls.length, 2); assert.equal(calls[0].body.license_key, key);
  const file = path.join(data, 'policy.json');
  assert.equal(JSON.parse(fs.readFileSync(file)).licenseKey, key);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(status).includes(key), false);
  assert.equal(fs.existsSync(path.join(data, 'ledger')), false);
});
test('SessionStart acknowledges without waiting for a network resolver and persists Free enforcement', async t => {
  const data = fixture(t);
  const child = spawnSync(process.execPath, ['hooks/session-start.cjs'], {cwd: root, env: process.env,
    input: JSON.stringify(matrix.payload({session_id: 'synthetic-start', hook_event_name: 'SessionStart'}, 'SessionStart')), encoding: 'utf8', timeout: 1000});
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), {});
  const filename = licenseStatusPath({data, sessionId: 'synthetic-start', policy: {}});
  for (let n=0; n<100 && !fs.existsSync(filename); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.parse(fs.readFileSync(filename)).reason, null);
});
test('free verification succeeds while both CLI export spellings refuse to create a file', async t => {
  const data = fixture(t); const reader = createReader({dataDir: data});
  assert.equal((await reader.call('verify_chain')).ok, true);
  const status = await reader.call('get_status');
  assert.equal(status.license.mode, 'shadow'); assert.equal(status.license.reason, 'status_unavailable');
  for (const flag of ['export', '--export']) {
    const output = path.join(data, flag.replace(/-/g, '') + '.json');
    await assert.rejects(run([flag, output], {reader}), {code: 'license_required'});
    assert.equal(fs.existsSync(output), false);
  }
  const response = await handleRpc({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'export_receipts'}}, reader);
  assert.match(response.result.content[0].text, /license_required/);
});
test('paid CLI export writes a verified private bundle without placing the key in it', async t => {
  const data = fixture(t); const key = 'ag_synthetic_export_key';
  await activate(key, {data, sessionId: 'local', postJson: async url => url.endsWith('/validate') ? paid : {ok:true, activeSeats:1, maxActiveSeats:1}});
  const output = path.join(data, 'bundle.json');
  assert.equal((await run(['--export', output], {dataDir: data})).ok, true);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(output, 'utf8').includes(key), false);
  await assert.rejects(run(['export', output], {dataDir: data}), {code: 'EEXIST'});
});
test('local activation identity overrides a team file key while team policy remains separate', t => {
  const data = fixture(t);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version:1,mode:'shadow',licenseKey:'ag_local_synthetic',teamPolicyFile:'team.json'}));
  fs.writeFileSync(path.join(data, 'team.json'), JSON.stringify({version:1,mode:'enforce',licenseKey:'ag_team_synthetic',ethicalWall:['save']}));
  const read = require('../runtime/policy-file.cjs').readPolicy(data);
  assert.equal(read.team, true); assert.equal(read.policy.licenseKey, 'ag_local_synthetic');
  assert.equal(read.policy.mode, 'enforce'); assert.equal(read.personal.mode, 'shadow');
});


test('paid activation preserves and reports an intentionally shadow policy', async t => {
  const data = fixture(t);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'shadow', tenantId: 'synthetic-shadow'}));
  const status = await activate('ag_synthetic_shadow_activation', {data, sessionId: 'shadow-session',
    postJson: async url => url.endsWith('/validate') ? paid : {ok: true, activeSeats: 1, maxActiveSeats: 1}});
  assert.equal(status.tier, 'solo');
  assert.equal(status.reason, null);
  assert.equal(status.mode, 'shadow');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'policy.json'), 'utf8')).mode, 'shadow');
  assert.equal((await createReader({dataDir: data}).call('get_status', {sessionId: 'shadow-session'})).license.mode, status.mode);
});
