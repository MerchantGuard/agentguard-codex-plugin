'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {refreshOrgPolicy, ENDPOINT} = require('../runtime/org-policy-refresh.cjs');
const {hashPolicy} = require('../runtime/org-policy-contract.cjs');
const {readCachedOrgPolicy} = require('../runtime/org-policy.cjs');
const {SeatHeartbeatScheduler, HEARTBEAT_MS} = require('../runtime/seat-heartbeat.cjs');
const {resolveSessionLicense, heartbeatSessionSeat, readSessionLicense} = require('../runtime/license.cjs');
const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const KEY = 'ag_SYNTHETIC_ORG_WORKER_KEY';
const hash = value => createHash('sha256').update(value).digest('hex');
function envelope(policy = {version: 1, mode: 'enforce', deniedTools: ['^Write$']}) {
  return {version: 1, published_at: '2026-09-20T11:00:00.000Z', sha256: hashPolicy(policy), policy};
}
function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-org-worker-'));
  const before = {...process.env};
  process.env.AGENTGUARD_HOME = path.join(data, 'sdk');
  delete process.env.AGENTGUARD_LICENSE_KEY;
  t.after(() => { process.env = before; fs.rmSync(data, {recursive: true, force: true}); });
  return {data, sessionId: 'SYNTHETIC_SESSION', policy: {version: 1, mode: 'enforce', licenseKey: KEY}, now: NOW};
}
const paid = {valid: true, tier: 'startup', seats: 5, features: {maxActiveSeats: 5}, expiresAt: new Date(NOW + 86400000).toISOString()};
const seat = (value = {}) => ({ok: true, activeSeats: 1, maxActiveSeats: 5, storage: 'kv', revoked: false, ...value});
async function startup(f) { return resolveSessionLicense({...f, postJson: async url => url.endsWith('/validate') ? paid : seat()}); }

test('org worker uses the fixed bearer endpoint and atomically writes a license-bound verified envelope', async t => {
  const f = fixture(t), expected = envelope(); let calls = 0;
  const state = await refreshOrgPolicy({...f, getPolicy: async (url, context) => {
    calls++; assert.equal(url, ENDPOINT); assert.equal(context.key, KEY); assert.ok(context.signal); return {status: 200, body: expected};
  }});
  assert.equal(calls, 1); assert.equal(state.status, 'ready');
  const file = path.join(f.data, 'org-policy.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {...expected, license_fingerprint: hash(KEY)});
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes(KEY), false);
  assert.equal(readCachedOrgPolicy(f.data, {keyFingerprint: hash(KEY)}).envelope.sha256, expected.sha256);
});

test('the production org transport is a bodyless bearer GET with redirects refused', async t => {
  const f = fixture(t), original = global.fetch; let request;
  global.fetch = async (url, options) => { request = {url, options}; return {status: 200, json: async () => envelope()}; };
  try { await refreshOrgPolicy(f); } finally { global.fetch = original; }
  assert.equal(request.url, ENDPOINT); assert.equal(request.options.method, 'GET');
  assert.deepEqual(request.options.headers, {authorization: `Bearer ${KEY}`});
  assert.equal(request.options.body, undefined); assert.equal(request.options.redirect, 'error');
});

test('last good org cache survives failed, malformed, tampered and expired-grace refresh attempts', async t => {
  const f = fixture(t), expected = envelope();
  await refreshOrgPolicy({...f, getPolicy: async () => ({status: 200, body: expected})});
  const file = path.join(f.data, 'org-policy.json'), before = fs.readFileSync(file);
  for (const getPolicy of [async () => { throw new Error('offline'); }, async () => ({status: 503}),
    async () => ({status: 200, body: {...expected, sha256: '0'.repeat(64)}}),
    async () => ({status: 200, body: envelope({...expected.policy, prompt: 'PRIVATE_NEVER_ACCEPTED'})})]) {
    const state = await refreshOrgPolicy({...f, now: NOW + 8 * 86400000, getPolicy});
    assert.equal(state.status, 'shadow'); assert.equal(state.reason, 'org_policy_unavailable');
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(readCachedOrgPolicy(f.data, {keyFingerprint: hash(KEY)}).envelope.sha256, expected.sha256);
  }
});

test('a transport ignoring abort still returns within the org deadline and leaves the last good cache intact', async t => {
  const f = fixture(t);
  await refreshOrgPolicy({...f, getPolicy: async () => ({status: 200, body: envelope()})});
  const file = path.join(f.data, 'org-policy.json'), before = fs.readFileSync(file); let signal;
  const start = performance.now();
  const result = await refreshOrgPolicy({...f, getPolicy: (_, options) => { signal = options.signal; return new Promise(() => {}); }});
  assert.ok(performance.now() - start >= 1900 && performance.now() - start < 3000);
  assert.equal(signal.aborted, true); assert.equal(result.reason, 'org_policy_unavailable');
  assert.deepEqual(fs.readFileSync(file), before);
});

test('204 deactivates the previous binding and a different license never sees the cached org', async t => {
  const f = fixture(t);
  await refreshOrgPolicy({...f, getPolicy: async () => ({status: 200, body: envelope()})});
  assert.equal(readCachedOrgPolicy(f.data, {keyFingerprint: hash('ag_OTHER_ORG')}).envelope, null);
  const before = fs.readFileSync(path.join(f.data, 'org-policy.json'));
  await refreshOrgPolicy({...f, getPolicy: async () => ({status: 204})});
  assert.equal(readCachedOrgPolicy(f.data, {keyFingerprint: hash(KEY)}).envelope, null);
  assert.equal(readCachedOrgPolicy(f.data, {keyFingerprint: hash(KEY)}).reason, null);
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'org-policy.json')), before);
});

test('startup and heartbeat transmit exactly license identity, registration identity and the loaded policy hash', async t => {
  const f = fixture(t), calls = [];
  const postJson = async (url, payload) => { calls.push({url, payload}); return url.endsWith('/validate') ? paid : seat(); };
  await resolveSessionLicense({...f, postJson, orgPolicySha256: 'a'.repeat(64)});
  await heartbeatSessionSeat({...f, orgPolicySha256: 'a'.repeat(64), postJson});
  const requests = calls.filter(call => call.url.endsWith('/seats'));
  assert.equal(requests.length, 2);
  for (const {payload} of requests) {
    assert.deepEqual(Object.keys(payload).sort(), ['license_key', 'machine_fingerprint', 'org_policy_sha256', 'process_id']);
    assert.equal(payload.license_key, KEY); assert.equal(payload.org_policy_sha256, 'a'.repeat(64));
    assert.match(payload.machine_fingerprint, /^[a-f0-9]{64}$/); assert.match(payload.process_id, /^[a-f0-9-]{36}$/);
  }
});

test('license registration and heartbeat never read local decisions, receipts, health or fail-open queues', async t => {
  const f = fixture(t), originalRead = fs.readFileSync, originalStream = fs.createReadStream;
  fs.mkdirSync(path.join(f.data, 'ledger'));
  fs.writeFileSync(path.join(f.data, 'ledger/decisions.ndjson'), JSON.stringify({decision: {
    timestamp: new Date(NOW).toISOString(), action: 'block', privateText: 'SYNTHETIC_PRIVATE_CONTENT',
    plugin: {event: 'decision', gate: 'spend', sessionId: f.sessionId, toolUseId: 'private-call'},
  }}) + '\n');
  fs.writeFileSync(path.join(f.data, 'health.json'), JSON.stringify({total: 100, failOpenCount: 20}));
  fs.writeFileSync(path.join(f.data, 'fail-open-pending.ndjson'), JSON.stringify({sessionId: f.sessionId, toolUseId: 'private-call', gate: 'spend', startedAt: new Date(NOW).toISOString()}) + '\n');
  const privateFile = file => typeof file === 'string' && (/[/\\]ledger[/\\]/.test(file) || /(?:health\.json|fail-open-pending\.ndjson)(?:\.recovering)?$/.test(file));
  let reads = 0;
  fs.readFileSync = function(file, ...args) { if (privateFile(file)) { reads++; throw new Error('Private activity is unavailable.'); } return originalRead.call(this, file, ...args); };
  fs.createReadStream = function(file, ...args) { if (privateFile(file)) { reads++; throw new Error('Private activity is unavailable.'); } return originalStream.call(this, file, ...args); };
  try {
    assert.equal((await startup(f)).mode, 'enforce');
    assert.equal((await heartbeatSessionSeat({...f, postJson: async () => seat()})).mode, 'enforce');
    assert.equal(reads, 0);
  } finally { fs.readFileSync = originalRead; fs.createReadStream = originalStream; }
});

test('revocation stays shadow through failure and malformed restore, then explicit successful restore clears it', async t => {
  const f = fixture(t); await startup(f);
  const revoked = await heartbeatSessionSeat({...f, postJson: async () => ({revoked: true})});
  assert.equal(revoked.mode, 'shadow'); assert.equal(revoked.reason, 'seat_revoked');
  for (const postJson of [async () => { throw new Error('offline'); }, async () => ({revoked: false}), async () => seat({revoked: undefined})]) {
    await heartbeatSessionSeat({...f, postJson});
    assert.equal(readSessionLicense(f).reason, 'seat_revoked');
  }
  await heartbeatSessionSeat({...f, postJson: async () => seat({revoked: false})});
  assert.equal(readSessionLicense(f).mode, 'enforce'); assert.equal(readSessionLicense(f).reason, null);
});

test('activation cannot temporarily erase a known revocation while validation is pending', async t => {
  const f = fixture(t); await startup(f);
  await heartbeatSessionSeat({...f, postJson: async () => ({revoked: true})});
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const refresh = resolveSessionLicense({...f, forceActivation: true, now: NOW + 1, postJson: async url => {
    if (url.endsWith('/validate')) { entered(); await new Promise(resolve => { release = resolve; }); return paid; }
    return seat({revoked: undefined});
  }});
  await started;
  assert.equal(readSessionLicense(f).mode, 'shadow'); assert.equal(readSessionLicense(f).reason, 'seat_revoked');
  release(); await refresh;
  assert.equal(readSessionLicense(f).reason, 'seat_revoked');
});

test('org refresh runs every fifth actual heartbeat and repeated observations do not reset the count', async t => {
  const f = fixture(t); let now = NOW, renewals = 0, orgFetches = 0, loaded = 0;
  const scheduler = new SeatHeartbeatScheduler({data: f.data, now: () => now, isLive: () => true,
    heartbeat: async () => { renewals++; }, refreshOrg: async () => { orgFetches++; }, onOrgRefresh: () => { loaded++; }});
  for (let n = 0; n < 11; n++) { scheduler.observe(f.sessionId, f.policy); await scheduler.tick(now); now += HEARTBEAT_MS; }
  assert.equal(renewals, 10); assert.equal(orgFetches, 2); assert.equal(loaded, 2); scheduler.stop();
});

test('org persistence rejection reaches worker failure latch and does not stop seat heartbeat scheduling', async t => {
  const f = fixture(t); let now = NOW, reason, calls = 0;
  const scheduler = new SeatHeartbeatScheduler({data: f.data, now: () => now, isLive: () => true,
    heartbeat: async () => { calls++; }, refreshOrg: async () => { throw new Error('disk unavailable'); },
    onOrgFailure: (_, value) => { reason = value; }});
  scheduler.observe(f.sessionId, f.policy);
  for (let n = 0; n < 5; n++) { now += HEARTBEAT_MS; await scheduler.tick(now); }
  assert.equal(reason, 'org_policy_unavailable'); assert.equal(calls, 5); scheduler.stop();
});

test('a seat state write failure preserves its known revoked reason in the worker latch callback', async t => {
  const f = fixture(t); let now = NOW, reason;
  const scheduler = new SeatHeartbeatScheduler({data: f.data, now: () => now, isLive: () => true,
    heartbeat: async () => { const error = new Error('state cannot be stored'); error.code = 'seat_revoked'; throw error; },
    onSeatFailure: (_, value) => { reason = value; }});
  scheduler.observe(f.sessionId, f.policy); now += HEARTBEAT_MS; await scheduler.tick(now);
  assert.equal(reason, 'seat_revoked'); scheduler.stop();
});

test('memory-only revocation requires explicit restore and seat recovery never clears an org failure', () => {
  const {recoverSeatState, recoverSessionState} = require('../runtime/worker-session.cjs');
  const state = new Map([['seat', 'seat_revoked'], ['startup', 'seat_revoked'], ['org', 'org_policy_unavailable']]);
  const engine = {sessionFailures: new Map([['session', state]]), clearSessionFailure: (_, source) => state.delete(source)};
  const legacy = {seatStatus: 'registered', seatRevoked: false, seatRevocationConfirmed: null};
  recoverSeatState(engine, 'session', legacy); recoverSessionState(engine, 'session', legacy);
  assert.equal(state.get('seat'), 'seat_revoked'); assert.equal(state.get('startup'), 'seat_revoked');
  recoverSeatState(engine, 'session', {...legacy, seatRevocationConfirmed: false});
  assert.equal(state.has('seat'), false); assert.equal(state.has('startup'), false);
  assert.equal(state.get('org'), 'org_policy_unavailable');
});

test('without a running worker MCP reports cached facts in shadow and does not start a worker or open sockets', async t => {
  const f = fixture(t); await startup(f);
  fs.writeFileSync(path.join(f.data, 'policy.json'), JSON.stringify(f.policy));
  await refreshOrgPolicy({...f, getPolicy: async () => ({status: 204})});
  const originalFetch = global.fetch, originalSocket = require('node:net').Socket.prototype.connect; let attempts = 0;
  global.fetch = require('node:net').Socket.prototype.connect = () => { attempts++; throw new Error('forbidden'); };
  try {
    const reader = require('../runtime/mcp.cjs').createReader({dataDir: f.data});
    const value = await reader.call('get_status', {sessionId: f.sessionId});
    assert.equal(value.license.mode, 'shadow'); assert.equal(value.license.statusError, 'status_unavailable');
    assert.equal(value.license.statusSource, 'cached_unverified'); assert.equal(attempts, 0);
    assert.equal(fs.existsSync(require('../runtime/common.cjs').locations(f.data).lock), false);
  } finally { global.fetch = originalFetch; require('node:net').Socket.prototype.connect = originalSocket; }
});

test('MCP reads a current revoked reason through existing worker file IPC without any socket', async t => {
  const f = fixture(t), {locations} = require('../runtime/common.cjs');
  const {ensurePrivateIpc, writeMessage, readPrivate} = require('../runtime/client.cjs');
  const loc = locations(f.data); ensurePrivateIpc(loc);
  fs.writeFileSync(loc.lock, String(process.pid), {mode: 0o600}); writeMessage(loc.ready, {pid: process.pid});
  const originalFetch = global.fetch, originalSocket = require('node:net').Socket.prototype.connect;
  let attempts = 0, controls = [];
  global.fetch = require('node:net').Socket.prototype.connect = () => { attempts++; throw new Error('forbidden'); };
  const timer = setInterval(() => {
    for (const name of fs.readdirSync(loc.ipc).filter(name => name.endsWith('.request'))) {
      const file = path.join(loc.ipc, name), request = JSON.parse(readPrivate(file));
      controls.push(request.control); fs.unlinkSync(file);
      writeMessage(file.replace(/\.request$/, '.response'), {license: {paid: true, tier: 'startup', mode: 'shadow', reason: 'seat_revoked', seatRevoked: true, seatIdentity: {machineFingerprint: 'PRIVATE_IDENTITY'}}});
    }
  }, 2);
  try {
    const result = await require('../runtime/mcp.cjs').createReader({dataDir: f.data}).call('get_status', {sessionId: f.sessionId});
    assert.equal(result.license.mode, 'shadow'); assert.equal(result.license.reason, 'seat_revoked');
    assert.equal(result.license.statusSource, 'worker'); assert.equal(result.license.statusError, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_IDENTITY|machineFingerprint/);
    assert.deepEqual(controls, ['effective-license']); assert.equal(attempts, 0);
  } finally {
    clearInterval(timer); global.fetch = originalFetch; require('node:net').Socket.prototype.connect = originalSocket;
    fs.rmSync(loc.ipc, {recursive: true, force: true});
  }
});

test('lifecycle and activation use file IPC while network APIs are forbidden in the caller', async t => {
  const f = fixture(t), oldFetch = global.fetch, socket = require('node:net').Socket.prototype.connect;
  let attempts = 0, message;
  global.fetch = require('node:net').Socket.prototype.connect = () => { attempts++; throw new Error('forbidden'); };
  try {
    const status = await require('../runtime/activate.cjs').activate(KEY, {...f, request: async value => {
      message = value; return {license: {paid: true, mode: 'shadow', reason: 'seat_revoked', tier: 'solo'}};
    }});
    assert.equal(message.control, 'license-refresh'); assert.equal(status.reason, 'seat_revoked'); assert.equal(status.mode, 'shadow');
    assert.equal(attempts, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../runtime/session-start.cjs'), 'utf8'), /resolveSessionLicense|fetch\(/);
  } finally { global.fetch = oldFetch; require('node:net').Socket.prototype.connect = socket; }
});
