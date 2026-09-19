'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createReader, TOOLS} = require('../runtime/mcp.cjs');
const {licenseStatusPath} = require('../runtime/license.cjs');
const KEY = 'ag_SYNTHETIC_STATUS_LICENSE';
const SESSION = 'session-SYNTHETIC-status';
function fixture(t, changes = {}, policy = {version: 1, mode: 'enforce', licenseKey: KEY}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-seat-status-'));
  const prior = Object.fromEntries(['AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'CODEX_THREAD_ID'].map(name => [name, process.env[name]]));
  process.env.AGENTGUARD_HOME = path.join(data, 'sdk');
  delete process.env.AGENTGUARD_LICENSE_KEY;
  delete process.env.AGENTGUARD_PLUGIN_POLICY;
  delete process.env.CODEX_THREAD_ID;
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) value === undefined ? delete process.env[name] : process.env[name] = value;
    fs.rmSync(data, {recursive: true, force: true});
  });
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify(policy));
  if (changes !== null) {
    const file = licenseStatusPath({data, sessionId: SESSION, policy});
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({schema: 'agentguard.plugin.license.v1', sessionFingerprint: crypto.createHash('sha256').update(SESSION).digest('hex'), keyFingerprint: crypto.createHash('sha256').update(KEY).digest('hex'), paid: true, mode: 'enforce', reason: null, tier: 'startup', seatsUsed: 3, seatLimit: 5, seatStorage: 'kv', seatsVerified: true, expiresAt: new Date(Date.now() + 86400000).toISOString(), refreshedAt: new Date().toISOString(), seatRefreshedAt: new Date().toISOString(), source: 'remote', ...changes}));
  }
  const reader = createReader({dataDir: data});
  return {data, reader, status: async () => (await reader.call('get_status', {sessionId: SESSION})).license};
}

test('MCP status reports shared KV seat evidence without changing policy or writing a snapshot', async t => {
  const f = fixture(t);
  const before = fs.readdirSync(f.data, {recursive: true}).sort();
  const license = await f.status();
  assert.deepEqual({seatsUsed: license.seatsUsed, seatLimit: license.seatLimit, seatStorage: license.seatStorage, seatsVerified: license.seatsVerified}, {seatsUsed: 3, seatLimit: 5, seatStorage: 'kv', seatsVerified: true});
  assert.equal(license.mode, 'enforce');
  assert.equal(license.reason, null);
  assert.ok(license.seatRefreshedAt);
  assert.deepEqual(fs.readdirSync(f.data, {recursive: true}).sort(), before);
  assert.doesNotMatch(JSON.stringify(license), new RegExp(KEY));
  assert.match(TOOLS.find(tool => tool.name === 'get_status').description, /seat storage and verification status/);
});

test('MCP status preserves a verified over-limit startup count and its shadow reason', async t => {
  const f = fixture(t, {paid: false, mode: 'shadow', reason: 'seat_limit', seatsUsed: 6, seatStatus: 'denied'});
  const license = await f.status();
  assert.equal(license.seatsUsed, 6);
  assert.equal(license.seatLimit, 5);
  assert.equal(license.seatStorage, 'kv');
  assert.equal(license.seatsVerified, true);
  assert.equal(license.mode, 'shadow');
  assert.equal(license.reason, 'seat_limit');
});

test('MCP status marks memory counts unverified even if an old local snapshot claims verification', async t => {
  const f = fixture(t, {seatStorage: 'memory', seatsVerified: true, seatsUsed: 1});
  const license = await f.status();
  assert.equal(license.seatsUsed, 1);
  assert.equal(license.seatStorage, 'memory');
  assert.equal(license.seatsVerified, false);
  assert.equal(license.mode, 'enforce');
});

test('MCP status preserves last observed counts after heartbeat failure without presenting them as verified', async t => {
  const lastResponse = new Date(Date.now() - 360000).toISOString();
  const latestAttempt = new Date().toISOString();
  const f = fixture(t, {seatStorage: null, seatsVerified: false, seatStatus: 'unavailable', seatRefreshedAt: lastResponse, seatHeartbeatAt: latestAttempt, seatHeartbeatError: 'seat_request_failed'});
  const license = await f.status();
  assert.equal(license.seatsUsed, 3);
  assert.equal(license.seatLimit, 5);
  assert.equal(license.seatsVerified, false);
  assert.equal(license.seatStorage, null);
  assert.equal(license.seatRefreshedAt, lastResponse);
  assert.equal(license.seatHeartbeatAt, latestAttempt);
  assert.equal(license.seatHeartbeatError, 'seat_request_failed');
  assert.equal(license.mode, 'enforce');
  assert.equal(license.reason, null);
});

test('MCP status treats malformed or legacy seat evidence as unverified', async t => {
  const f = fixture(t, {seatsUsed: -1, seatLimit: '5', seatStorage: 'untrusted-source', seatsVerified: true});
  const license = await f.status();
  assert.equal(license.seatsUsed, null);
  assert.equal(license.seatLimit, null);
  assert.equal(license.seatStorage, null);
  assert.equal(license.seatsVerified, false);
});

test('MCP free and corrupt-policy status always supply unknown seat provenance', async t => {
  const f = fixture(t, null, {version: 1, mode: 'enforce'});
  let license = await f.status();
  assert.equal(license.mode, 'shadow');
  assert.equal(license.seatStorage, null);
  assert.equal(license.seatsVerified, false);
  fs.writeFileSync(path.join(f.data, 'policy.json'), '{');
  license = await f.status();
  assert.equal(license.source, 'policy_unavailable');
  assert.equal(license.seatsUsed, null);
  assert.equal(license.seatLimit, null);
  assert.equal(license.seatStorage, null);
  assert.equal(license.seatsVerified, false);
});

test('seat status reads do not open a network socket or trigger a heartbeat', async t => {
  const f = fixture(t);
  const net = require('node:net');
  const priorConnect = net.Socket.prototype.connect;
  const priorFetch = global.fetch;
  let attempts = 0;
  net.Socket.prototype.connect = () => { attempts += 1; throw new Error('socket forbidden'); };
  global.fetch = () => { attempts += 1; throw new Error('network forbidden'); };
  try {
    const license = await f.status();
    assert.equal(license.seatsVerified, true);
    assert.equal(attempts, 0);
  } finally { net.Socket.prototype.connect = priorConnect; global.fetch = priorFetch; }
});
