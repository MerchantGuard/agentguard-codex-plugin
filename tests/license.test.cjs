'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {resolveSessionLicense, readSessionLicense, licenseStatusPath, GRACE_MS, REFRESH_TIMEOUT_MS} = require('../runtime/license.cjs');

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const KEY = 'ag_SYNTHETIC_LICENSE_KEY_NEVER_IN_LEDGER';
const DAY = 86400000;
function status(tier = 'solo', expiresAt = new Date(NOW + DAY).toISOString()) {
  const seats = tier.startsWith('growth') ? 50 : tier.startsWith('startup') ? 5 : 1;
  return {valid: true, tier, seats, expiresAt, features: {maxActiveSeats: seats}};
}
function fixture(t, opts = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-license-test-'));
  const prior = Object.fromEntries(['AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_LICENSE_ENDPOINT'].map(name => [name, process.env[name]]));
  process.env.AGENTGUARD_HOME = path.join(data, 'sdk');
  delete process.env.AGENTGUARD_LICENSE_KEY;
  delete process.env.AGENTGUARD_LICENSE_ENDPOINT;
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) value === undefined ? delete process.env[name] : process.env[name] = value;
    fs.rmSync(data, {recursive: true, force: true});
  });
  const calls = [];
  const base = {data, sessionId: 'session-SYNTHETIC', policy: {licenseKey: KEY}, now: NOW};
  const options = {...base, ...opts, postJson: opts.postJson || (async (url, body) => {
    calls.push({url, body});
    return url.endsWith('/validate') ? status() : {ok: true, activeSeats: 1, maxActiveSeats: 1};
  })};
  const cache = value => {
    const hash = crypto.createHash('sha256').update(options.policy.licenseKey).digest('hex');
    fs.mkdirSync(process.env.AGENTGUARD_HOME, {recursive: true});
    fs.writeFileSync(path.join(process.env.AGENTGUARD_HOME, `license-${hash}.json`), JSON.stringify({fetchedAt: NOW - 10 * DAY, status: value}));
  };
  return {data, options, calls, cache};
}

test('each existing paid tier resolves through the SDK and registers one active seat', async t => {
  const f = fixture(t);
  for (const tier of ['solo', 'startup', 'growth', 'solo_pro', 'startup_pro', 'growth_pro']) {
    const calls = [];
    const value = await resolveSessionLicense({...f.options, sessionId: tier, postJson: async (url, body) => {
      calls.push({url, body});
      return url.endsWith('/validate') ? status(tier) : {ok: true, activeSeats: 1, maxActiveSeats: status(tier).seats};
    }});
    assert.equal(value.paid, true);
    assert.equal(value.mode, 'enforce');
    assert.equal(value.reason, null);
    assert.equal(value.tier, tier);
    assert.equal(value.seatsUsed, 1);
    assert.equal(value.seatLimit, status(tier).seats);
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/license/validate', '/api/license/seats']);
    assert.equal(calls[1].body.license_key, KEY);
    assert.match(calls[1].body.machine_fingerprint, /^[0-9a-f]{64}$/);
    assert.match(calls[1].body.process_id, /^[0-9a-f-]{36}$/);
  }
});

test('missing license forces shadow without anonymous seat registration or a network call', async t => {
  const f = fixture(t, {policy: {mode: 'enforce'}});
  const value = await resolveSessionLicense(f.options);
  assert.equal(value.mode, 'shadow');
  assert.equal(value.reason, 'license_required');
  assert.equal(value.tier, 'free');
  assert.equal(value.paid, false);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(process.env.AGENTGUARD_HOME), false);
});

test('offline cache keeps paid eligibility for seven days but refresh failure stays shadow', async t => {
  const f = fixture(t, {postJson: async () => { throw new Error('SYNTHETIC_NETWORK_FAILURE'); }});
  f.cache(status('startup', new Date(NOW - 6 * DAY).toISOString()));
  const value = await resolveSessionLicense(f.options);
  assert.equal(value.paid, true);
  assert.equal(value.mode, 'shadow');
  assert.equal(value.reason, 'license_unavailable');
  assert.equal(value.offlineGrace, true);
  assert.equal(value.source, 'offline_cache');
  assert.equal(value.tier, 'startup');
  assert.equal(value.seatStatus, 'unavailable');
  assert.equal(value.seatsUsed, null);
  assert.equal(value.graceUntil, new Date(NOW + DAY).toISOString());
});

test('an expired cache beyond the grace boundary forces shadow', async t => {
  const f = fixture(t, {postJson: async () => { throw new Error('offline'); }});
  f.cache(status('growth', new Date(NOW - GRACE_MS).toISOString()));
  const value = await resolveSessionLicense(f.options);
  assert.equal(value.paid, false);
  assert.equal(value.mode, 'shadow');
  assert.equal(value.reason, 'license_required');
});

test('explicit invalid or revoked server status cannot use an older paid cache', async t => {
  const f = fixture(t, {postJson: async () => ({valid: false, tier: 'free', seats: 1, expiresAt: new Date(NOW - DAY).toISOString()})});
  f.cache(status('growth'));
  const value = await resolveSessionLicense(f.options);
  assert.equal(value.paid, false);
  assert.equal(value.mode, 'shadow');
  assert.equal(value.reason, 'license_required');
  assert.equal(value.source, 'remote');
});

test('an online expired status does not acquire offline grace', async t => {
  const f = fixture(t, {postJson: async () => status('solo', new Date(NOW - DAY).toISOString())});
  const value = await resolveSessionLicense(f.options);
  assert.equal(value.paid, false);
  assert.equal(value.offlineGrace, false);
});

test('over the seat limit forces shadow with seat_limit and preserves seat counts', async t => {
  const f = fixture(t, {postJson: async url => url.endsWith('/validate') ? status('startup') : {ok: false, activeSeats: 6, maxActiveSeats: 5}});
  const value = await resolveSessionLicense(f.options);
  assert.equal(value.paid, false);
  assert.equal(value.mode, 'shadow');
  assert.equal(value.reason, 'seat_limit');
  assert.equal(value.seatsUsed, 6);
  assert.equal(value.seatLimit, 5);
  assert.equal(value.seatStatus, 'denied');
});

test('a seat endpoint reporting a removed license returns license_required', async t => {
  const f = fixture(t, {postJson: async url => url.endsWith('/validate') ? status() : {ok: false, activeSeats: 0, maxActiveSeats: 1, error: 'license_not_found'}});
  assert.equal((await resolveSessionLicense(f.options)).reason, 'license_required');
});

test('one validation and one registration run per session, including concurrent startup', async t => {
  const f = fixture(t);
  const values = await Promise.all(Array.from({length: 5}, () => resolveSessionLicense(f.options)));
  assert.equal(values.every(value => value.paid), true);
  await resolveSessionLicense(f.options);
  assert.equal(f.calls.length, 2);
  await resolveSessionLicense({...f.options, sessionId: 'another-session'});
  assert.equal(f.calls.length, 4);
});

test('the network timeout is bounded by one two-second total deadline with cached fallback', async t => {
  let aborted = false;
  const f = fixture(t, {postJson: async (url, body, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, {once: true});
  })});
  f.cache(status());
  const started = performance.now();
  const value = await resolveSessionLicense(f.options);
  const elapsed = performance.now() - started;
  assert.equal(REFRESH_TIMEOUT_MS, 2000);
  assert.ok(elapsed >= 1900 && elapsed < 2600, `elapsed ${elapsed}`);
  assert.equal(aborted, true);
  assert.equal(value.paid, true);
  assert.equal(value.source, 'offline_cache');
  assert.equal(value.seatStatus, 'unavailable');
});

test('validation and seat registration share the same deadline instead of two independent timeouts', async t => {
  const f = fixture(t, {postJson: async (url, body, {signal}) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1200);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, {once: true});
    });
    return url.endsWith('/validate') ? status() : {ok: true, activeSeats: 1, maxActiveSeats: 1};
  }});
  const started = performance.now();
  const value = await resolveSessionLicense(f.options);
  assert.ok(performance.now() - started < 2600);
  assert.equal(value.paid, true);
  assert.equal(value.source, 'remote');
  assert.equal(value.seatStatus, 'unavailable');
});

test('network failure without prior paid status stays shadow', async t => {
  const f = fixture(t, {postJson: async () => { throw new Error('network unavailable'); }});
  const value = await resolveSessionLicense(f.options);
  assert.equal(value.mode, 'shadow');
  assert.equal(value.reason, 'license_required');
});

test('a long running session loses paid eligibility after the offline grace deadline without networking', async t => {
  const f = fixture(t);
  await resolveSessionLicense(f.options);
  assert.equal(readSessionLicense({...f.options, now: NOW + 2 * DAY}).offlineGrace, true);
  const expired = readSessionLicense({...f.options, now: NOW + DAY + GRACE_MS});
  assert.equal(expired.paid, false);
  assert.equal(expired.reason, 'license_required');
  assert.equal(f.calls.length, 2);
});

test('environment key takes precedence and key changes resolve separately from the old session snapshot', async t => {
  const f = fixture(t);
  process.env.AGENTGUARD_LICENSE_KEY = 'ag_ENVIRONMENT_SYNTHETIC';
  await resolveSessionLicense(f.options);
  assert.equal(f.calls[0].body.license_key, 'ag_ENVIRONMENT_SYNTHETIC');
  delete process.env.AGENTGUARD_LICENSE_KEY;
  assert.equal(readSessionLicense(f.options).reason, 'license_required');
  await resolveSessionLicense(f.options);
  assert.equal(f.calls[2].body.license_key, KEY);
});

test('session snapshots never persist a license key or host session identifier', async t => {
  const f = fixture(t);
  await resolveSessionLicense(f.options);
  const file = licenseStatusPath(f.options);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes(f.options.sessionId), false);
  assert.equal(file.includes(KEY), false);
  assert.equal(file.includes(f.options.sessionId), false);
  assert.match(JSON.parse(text).keyFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('explicit activation can re-resolve while normal reads retain the session snapshot', async t => {
  const f = fixture(t);
  await resolveSessionLicense(f.options);
  await resolveSessionLicense({...f.options, forceActivation: true});
  assert.equal(f.calls.length, 4);
  assert.equal(readSessionLicense(f.options).paid, true);
});

test('the hook-side license reader is synchronous, read-only and does not open a socket', async t => {
  const f = fixture(t);
  await resolveSessionLicense(f.options);
  const file = licenseStatusPath(f.options);
  const before = fs.readFileSync(file);
  const net = require('node:net');
  const original = net.Socket.prototype.connect;
  const originalFetch = global.fetch;
  let attempts = 0;
  net.Socket.prototype.connect = () => { attempts++; throw new Error('socket forbidden'); };
  global.fetch = () => { attempts++; throw new Error('fetch forbidden'); };
  try {
    assert.equal(readSessionLicense(f.options).paid, true);
    assert.equal(readSessionLicense({...f.options, sessionId: 'new'}).paid, true);
  } finally {
    net.Socket.prototype.connect = original;
    global.fetch = originalFetch;
  }
  assert.equal(attempts, 0);
  assert.deepEqual(fs.readFileSync(file), before);
});


test('a cached paid license is available offline before session startup without creating files', t => {
  const f = fixture(t);
  f.cache(status());
  const value = readSessionLicense(f.options);
  assert.equal(value.paid, true);
  assert.equal(value.source, 'offline_cache');
  assert.equal(value.seatStatus, 'unknown');
  assert.equal(fs.existsSync(path.join(f.data, 'license-status')), false);
  assert.equal(f.calls.length, 0);
});

test('cached status never replaces a persisted seat denial for the same session', async t => {
  const f = fixture(t, {postJson: async url => url.endsWith('/validate') ? status() : {ok: false, activeSeats: 2, maxActiveSeats: 1}});
  await resolveSessionLicense(f.options);
  f.cache(status());
  assert.equal(readSessionLicense(f.options).paid, false);
  assert.equal(readSessionLicense(f.options).reason, 'seat_limit');
});

test('latest session status is selected only for display and never grants a different session authorization', async t => {
  const f = fixture(t);
  const {readLatestLicenseStatus} = require('../runtime/license.cjs');
  await resolveSessionLicense({...f.options, sessionId: 'earlier', now: NOW - 100});
  await resolveSessionLicense({...f.options, sessionId: 'latest', now: NOW, postJson: async url => url.endsWith('/validate') ? status() : {ok: false, activeSeats: 2, maxActiveSeats: 1}});
  assert.equal(readLatestLicenseStatus({...f.options, sessionId: 'different'}).reason, 'seat_limit');
  assert.equal(readSessionLicense({...f.options, sessionId: 'earlier'}).paid, true);
});
