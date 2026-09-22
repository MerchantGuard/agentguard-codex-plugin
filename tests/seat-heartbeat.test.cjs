'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {resolveSessionLicense, heartbeatSessionSeat, readSessionLicense, licenseStatusPath,
  REFRESH_TIMEOUT_MS, SEAT_ENDPOINT} = require('../runtime/license.cjs');
const {SeatHeartbeatScheduler, HEARTBEAT_MS} = require('../runtime/seat-heartbeat.cjs');

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const KEY = 'ag_SYNTHETIC_SEAT_HEARTBEAT_KEY';
const INSTALL_ID = 'SYNTHETIC_INSTALLATION_NOT_A_CUSTOMER';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const paidStatus = () => ({valid: true, tier: 'startup', seats: 5,
  expiresAt: new Date(NOW + 86400000).toISOString(), features: {maxActiveSeats: 5}});
const seatResponse = (overrides = {}) => ({ok: true, activeSeats: 1, maxActiveSeats: 5, storage: 'kv', ...overrides});

function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-seat-heartbeat-'));
  const names = ['AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_LICENSE_ENDPOINT', 'AGENTGUARD_PLUGIN_POLICY'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.AGENTGUARD_HOME = path.join(data, 'sdk');
  fs.mkdirSync(process.env.AGENTGUARD_HOME);
  fs.writeFileSync(path.join(process.env.AGENTGUARD_HOME, 'install.json'), JSON.stringify({anonymous_install_id: INSTALL_ID}));
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(data, {recursive: true, force: true});
  });
  const calls = [];
  const options = {data, sessionId: 'session-SYNTHETIC-seat', policy: {mode: 'enforce', licenseKey: KEY}, now: NOW,
    postJson: async (url, body) => { calls.push({url, body}); return url.endsWith('/validate') ? paidStatus() : seatResponse(); }};
  return {data, options, calls, cachePath: path.join(process.env.AGENTGUARD_HOME, `license-${hash(KEY)}.json`)};
}
function entitlements(value) {
  return Object.fromEntries(['paid', 'mode', 'reason', 'tier', 'expiresAt', 'graceUntil', 'source', 'refreshedAt', 'offlineGrace']
    .map(key => [key, value[key]]));
}

test('startup captures the SDK machine fingerprint and uses stable distinct session seat identities', async t => {
  const f = fixture(t);
  const first = await resolveSessionLicense(f.options);
  assert.equal(first.seatStorage, 'kv');
  assert.equal(first.seatsVerified, true);
  assert.equal(first.seatRefreshedAt, new Date(NOW).toISOString());
  assert.equal(first.seatIdentity.machineFingerprint, hash(INSTALL_ID));
  assert.match(first.seatIdentity.processId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(f.calls[1].body.process_id, first.seatIdentity.processId);
  const restarted = await resolveSessionLicense({...f.options, forceActivation: true, now: NOW + 1});
  assert.deepEqual(restarted.seatIdentity, first.seatIdentity);
  const second = await resolveSessionLicense({...f.options, sessionId: 'second-SYNTHETIC-session'});
  assert.equal(second.seatIdentity.machineFingerprint, first.seatIdentity.machineFingerprint);
  assert.notEqual(second.seatIdentity.processId, first.seatIdentity.processId);
  const stored = fs.readFileSync(licenseStatusPath(f.options), 'utf8');
  for (const sensitive of [KEY, INSTALL_ID, f.options.sessionId]) assert.equal(stored.includes(sensitive), false);
});

test('memory and legacy seat responses retain paid access but never claim verified seat counts', async t => {
  const f = fixture(t);
  for (const storage of ['memory', undefined]) {
    const response = seatResponse({storage});
    const value = await resolveSessionLicense({...f.options, sessionId: `storage-${storage}`,
      postJson: async url => url.endsWith('/validate') ? paidStatus() : response});
    assert.equal(value.mode, 'enforce');
    assert.equal(value.paid, true);
    assert.equal(value.seatsUsed, 1);
    assert.equal(value.seatLimit, 5);
    assert.equal(value.seatStorage, storage || null);
    assert.equal(value.seatsVerified, false);
  }
});

test('a KV startup denial records verified counts and keeps the existing seat_limit shadow behavior', async t => {
  const f = fixture(t);
  const value = await resolveSessionLicense({...f.options,
    postJson: async url => url.endsWith('/validate') ? paidStatus() : seatResponse({ok: false, activeSeats: 6})});
  assert.equal(value.mode, 'shadow');
  assert.equal(value.paid, false);
  assert.equal(value.reason, 'seat_limit');
  assert.equal(value.seatStorage, 'kv');
  assert.equal(value.seatsVerified, true);
  assert.equal(value.seatsUsed, 6);
});

test('a heartbeat reuses the registered identity at the fixed endpoint without refreshing entitlement cache', async t => {
  const f = fixture(t);
  const before = await resolveSessionLicense(f.options);
  const cache = fs.readFileSync(f.cachePath);
  process.env.AGENTGUARD_LICENSE_ENDPOINT = 'https://invalid.example/never-used';
  const calls = [];
  const after = await heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS, postJson: async (url, body, context) => {
    calls.push({url, body, context}); return seatResponse({activeSeats: 3});
  }});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SEAT_ENDPOINT);
  assert.deepEqual(calls[0].body, f.calls[1].body);
  assert.equal(calls[0].context.signal.aborted, true);
  assert.deepEqual(entitlements(after), entitlements(before));
  assert.equal(after.seatsUsed, 3);
  assert.equal(after.seatsVerified, true);
  assert.equal(after.seatRefreshedAt, new Date(NOW + HEARTBEAT_MS).toISOString());
  assert.equal(after.seatHeartbeatAt, after.seatRefreshedAt);
  assert.equal(after.seatHeartbeatError, null);
  assert.deepEqual(fs.readFileSync(f.cachePath), cache);
});

test('a heartbeat denial retains paid eligibility but selects seat_limit shadow', async t => {
  const f = fixture(t);
  const before = await resolveSessionLicense(f.options);
  const after = await heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS,
    postJson: async () => seatResponse({ok: false, activeSeats: 6, error: 'seat_limit'})});
  assert.equal(after.paid, before.paid);
  assert.equal(after.mode, 'shadow');
  assert.equal(after.reason, 'seat_limit');
  assert.equal(after.seatsUsed, 6);
  assert.equal(after.seatsVerified, true);
  assert.equal(after.seatStatus, 'denied');
  assert.equal(after.seatHeartbeatError, 'seat_denied');
  assert.equal(readSessionLicense(f.options).mode, 'shadow');
});

test('a successful heartbeat cannot upgrade a session that entered shadow at startup', async t => {
  const f = fixture(t);
  const before = await resolveSessionLicense({...f.options,
    postJson: async url => url.endsWith('/validate') ? paidStatus() : seatResponse({ok: false, activeSeats: 6})});
  const after = await heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS, postJson: async () => seatResponse()});
  assert.deepEqual(entitlements(after), entitlements(before));
  assert.equal(after.reason, 'seat_limit');
  assert.equal(after.mode, 'shadow');
  assert.equal(after.seatsUsed, 1);
  assert.equal(after.seatStatus, 'registered');
});

test('failed and malformed heartbeat observations preserve the last valid counts and their timestamp', async t => {
  const f = fixture(t);
  const before = await resolveSessionLicense(f.options);
  const cases = [async () => { throw new Error('SYNTHETIC_FAILURE'); },
    async () => seatResponse({activeSeats: -1}), async () => seatResponse({ok: 'true'}),
    async () => seatResponse({maxActiveSeats: 1.5})];
  for (let index = 0; index < cases.length; index++) {
    const at = NOW + (index + 1) * HEARTBEAT_MS;
    const after = await heartbeatSessionSeat({...f.options, now: at, postJson: cases[index]});
    assert.equal(after.paid, before.paid);
    assert.equal(after.mode, 'shadow');
    assert.equal(after.reason, 'seat_unavailable');
    assert.equal(after.seatsUsed, before.seatsUsed);
    assert.equal(after.seatLimit, before.seatLimit);
    assert.equal(after.seatRefreshedAt, before.seatRefreshedAt);
    assert.equal(after.seatsVerified, false);
    assert.equal(after.seatHeartbeatAt, new Date(at).toISOString());
    assert.equal(after.seatHeartbeatError, 'unavailable');
  }
});

test('memory heartbeat counts remain explicitly unverified', async t => {
  const f = fixture(t);
  await resolveSessionLicense(f.options);
  const after = await heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS,
    postJson: async () => seatResponse({storage: 'memory', activeSeats: 2})});
  assert.equal(after.seatsUsed, 2);
  assert.equal(after.seatStorage, 'memory');
  assert.equal(after.seatsVerified, false);
  assert.equal(after.seatRefreshedAt, new Date(NOW + HEARTBEAT_MS).toISOString());
});

test('heartbeat transport has a two-second deadline even if the transport ignores cancellation', async t => {
  const f = fixture(t);
  const before = await resolveSessionLicense(f.options);
  let signal;
  const started = performance.now();
  const after = await heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS, postJson: (url, body, context) => {
    signal = context.signal; return new Promise(() => {});
  }});
  const duration = performance.now() - started;
  assert.equal(REFRESH_TIMEOUT_MS, 2000);
  assert.ok(duration >= 1900 && duration < 2800, `heartbeat took ${duration} ms`);
  assert.equal(signal.aborted, true);
  assert.equal(after.paid, before.paid);
    assert.equal(after.mode, 'shadow');
    assert.equal(after.reason, 'seat_unavailable');
  assert.equal(after.seatsVerified, false);
  assert.equal(after.seatHeartbeatError, 'unavailable');
});

test('free, unresolved and legacy sessions cannot cause a seat heartbeat request', async t => {
  const f = fixture(t);
  let calls = 0;
  const postJson = async () => { calls++; throw new Error('must not be reached'); };
  await heartbeatSessionSeat({...f.options, policy: {}, postJson});
  await heartbeatSessionSeat({...f.options, sessionId: 'unresolved', postJson});
  const status = await resolveSessionLicense(f.options);
  delete status.seatIdentity;
  fs.writeFileSync(licenseStatusPath(f.options), JSON.stringify(status));
  const value = await heartbeatSessionSeat({...f.options, postJson});
  assert.equal(value.paid, true);
  assert.equal(calls, 0);
});

test('concurrent heartbeat requests share one registration', async t => {
  const f = fixture(t);
  await resolveSessionLicense(f.options);
  let calls = 0;
  const options = {...f.options, now: NOW + HEARTBEAT_MS, postJson: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 10)); return seatResponse();
  }};
  const values = await Promise.all(Array.from({length: 4}, () => heartbeatSessionSeat(options)));
  assert.equal(calls, 1);
  assert.equal(values.every(value => value.seatsVerified), true);
});

test('a late heartbeat cannot overwrite a newer activation result', async t => {
  const f = fixture(t);
  await resolveSessionLicense(f.options);
  let finish, started;
  const requested = new Promise(resolve => { started = resolve; });
  const heartbeat = heartbeatSessionSeat({...f.options, now: NOW + HEARTBEAT_MS, postJson: async () => {
    started(); return new Promise(resolve => { finish = resolve; });
  }});
  await requested;
  const activated = await resolveSessionLicense({...f.options, now: NOW + HEARTBEAT_MS + 1, forceActivation: true,
    postJson: async url => url.endsWith('/validate') ? paidStatus() : seatResponse({ok: false, activeSeats: 6})});
  finish(seatResponse({activeSeats: 2}));
  const result = await heartbeat;
  assert.deepEqual(result, activated);
});

test('scheduler uses the startup timestamp and repeated observations do not postpone the heartbeat', async t => {
  const f = fixture(t);
  await resolveSessionLicense(f.options);
  let now = NOW + 100000;
  const calls = []; let livenessChecks = 0;
  const scheduler = new SeatHeartbeatScheduler({data: f.data, now: () => now, isLive: () => { livenessChecks++; return true; },
    heartbeat: async options => { calls.push(options); return {seatsVerified: true}; }});
  scheduler.observe(f.options.sessionId, f.options.policy);
  now = NOW + HEARTBEAT_MS - 1;
  scheduler.observe(f.options.sessionId, f.options.policy);
  await scheduler.tick(now);
  assert.equal(calls.length, 0);
  assert.equal(livenessChecks, 0);
  now++;
  await scheduler.tick(now);
  assert.equal(calls.length, 1);
  assert.equal(livenessChecks, 1);
  assert.equal(calls[0].sessionId, f.options.sessionId);
  assert.equal(calls[0].now, now);
  now += HEARTBEAT_MS - 1;
  scheduler.observe(f.options.sessionId, f.options.policy);
  await scheduler.tick(now);
  assert.equal(calls.length, 1);
  await scheduler.tick(++now);
  assert.equal(calls.length, 2);
  scheduler.stop();
});

test('scheduler stops ended sessions and spaces failed attempts by five minutes', async t => {
  const f = fixture(t);
  let now = NOW;
  const calls = [];
  const live = new Set(['live', 'ended', 'forgotten']);
  const scheduler = new SeatHeartbeatScheduler({data: f.data, now: () => now, isLive: id => live.has(id),
    heartbeat: async options => { calls.push(options.sessionId); throw new Error('offline'); }});
  for (const session of live) scheduler.observe(session, f.options.policy);
  live.delete('ended');
  scheduler.forget('forgotten');
  now += HEARTBEAT_MS;
  assert.deepEqual(await scheduler.tick(now), [{sessionId: 'live', unavailable: true}]);
  assert.deepEqual(calls, ['live']);
  await scheduler.tick(now + 1);
  assert.equal(calls.length, 1);
  await scheduler.tick(now + HEARTBEAT_MS);
  assert.equal(calls.length, 2);
  scheduler.stop();
  scheduler.observe('live', f.options.policy);
  await scheduler.tick(now + 2 * HEARTBEAT_MS);
  assert.equal(calls.length, 2);
});

test('concurrent scheduler ticks share one pass and stop honors a pending liveness check', async t => {
  const f = fixture(t);
  let now = NOW, liveCheck;
  const calls = [];
  const scheduler = new SeatHeartbeatScheduler({data: f.data, now: () => now,
    isLive: () => new Promise(resolve => { liveCheck = resolve; }),
    heartbeat: async options => { calls.push(options); }});
  scheduler.observe('live', f.options.policy);
  now += HEARTBEAT_MS;
  const first = scheduler.tick(now);
  assert.equal(scheduler.tick(now), first);
  scheduler.stop();
  liveCheck(true);
  assert.deepEqual(await first, []);
  assert.equal(calls.length, 0);
});

test('importing the heartbeat module and reading free hook state opens no sockets or timers', async t => {
  const f = fixture(t);
  const net = require('node:net');
  const originalConnect = net.Socket.prototype.connect;
  const originalFetch = global.fetch;
  const originalInterval = global.setInterval;
  let attempts = 0;
  const forbidden = () => { attempts++; throw new Error('network or timer forbidden'); };
  net.Socket.prototype.connect = forbidden;
  global.fetch = forbidden;
  global.setInterval = forbidden;
  try {
    delete require.cache[require.resolve('../runtime/seat-heartbeat.cjs')];
    const module = require('../runtime/seat-heartbeat.cjs');
    const scheduler = new module.SeatHeartbeatScheduler({data: f.data, now: () => NOW, isLive: () => true});
    scheduler.observe('free', {});
    await scheduler.tick(NOW + HEARTBEAT_MS);
    assert.equal(readSessionLicense({...f.options, policy: {}}).mode, 'enforce');
    scheduler.stop();
  } finally {
    net.Socket.prototype.connect = originalConnect;
    global.fetch = originalFetch;
    global.setInterval = originalInterval;
  }
  assert.equal(attempts, 0);
});
