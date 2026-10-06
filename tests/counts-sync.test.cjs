'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sync = require('../runtime/counts-sync.cjs');
const NOW = Date.parse('2026-10-05T12:00:00Z');
const counts = {launches: 4, allowed: 1, asked: 2, saidYes: 1, stopped: 1, shadow: 0, unrecorded: 0, unresolvedAsked: 1};
function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-count-sync-'));
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  const seed = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(data, 'signing-key.hex'), seed);
  const signed = sync.signPayload({}, seed);
  fs.writeFileSync(path.join(data, 'public-key.hex'), signed.publicKey);
  return {data, seed};
}
test('off by default and disabled feature flag make no license, receipt or network call', async t => {
  const {data} = fixture(t);
  const unexpected = () => assert.fail('Disabled sharing performed work');
  const args = {data, home: path.join(data, 'home'), featureEnabled: true, licenseReader: unexpected, transport: unexpected, burn: {readLedgerTallies: unexpected}};
  assert.deepEqual(await sync.syncDailyCounts(args), {status: 'off'});
  sync.setEnabled(data, true);
  assert.deepEqual(await sync.syncDailyCounts({...args, featureEnabled: false}), {status: 'off'});
  sync.setEnabled(data, false);
  assert.deepEqual(sync.settings(data), {enabled: false});
});
test('only a valid Team seat can upload an allowlisted count signed by its existing receipt key', async t => {
  const {data, seed} = fixture(t); sync.setEnabled(data, true);
  let calls = 0;
  const status = {paid: true, tier: 'startup', seatStatus: 'registered', expiresAt: '2026-11-01T00:00:00Z', seatIdentity: {machineFingerprint: '1'.repeat(64)}};
  const args = {data, home: path.join(data, 'home'), sessionId: 'local-only', now: NOW, featureEnabled: true, policy: {licenseKey: 'ag_synthetic_team'},
    licenseReader: () => status,
    burn: {readLedgerTallies: async () => [{status: 'verified', session: 'PRIVATE', date: '2026-10-04', counts, tokens: 1234, prompt: 'PRIVATE'}]},
    transport: async (url, options) => {
      calls++; assert.equal(url, sync.ENDPOINT || 'https://agentguard.run/api/team/counts');
      assert.equal(options.headers.Authorization, 'Bearer ag_synthetic_team');
      const envelope = JSON.parse(options.body);
      assert.equal(JSON.stringify(envelope).includes('PRIVATE'), false);
      assert.deepEqual(Object.keys(envelope.payload).sort(), ['counts', 'date', 'schema', 'seatId', 'tokens']);
      assert.deepEqual(Object.keys(envelope.payload.counts).sort(), [...sync.FIELDS].sort());
      assert.deepEqual(envelope, sync.signPayload(envelope.payload, seed));
      return {ok: true, status: 200};
    }};
  for (const patch of [{paid: false}, {tier: 'solo'}, {offlineGrace: true}, {seatRevoked: true}, {expiresAt: '2026-10-01T00:00:00Z'}, {seatStatus: 'unavailable'}]) {
    const original = {...status}; Object.assign(status, patch);
    assert.equal((await sync.syncDailyCounts(args)).status, 'license_required');
    for (const k of Object.keys(status)) delete status[k]; Object.assign(status, original);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await sync.syncDailyCounts(args), {status: 'synced', date: '2026-10-04'});
  assert.equal(calls, 1);
});
test('missing verification, missing tokens and mismatched arithmetic cannot become daily zeroes', () => {
  const good = {status: 'verified', date: '2026-10-04', counts, tokens: 0}, seat = '1'.repeat(64);
  for (const row of [{...good, status: 'verification_failed'}, {...good, tokens: null}, {...good, counts: {...counts, launches: 99}}]) assert.throws(() => sync.dailyPayload([row], good.date, seat));
  assert.equal(sync.dailyPayload([], good.date, seat), null);
});

test('two host directories share one signed daily payload, transport lock and receipt signer', async t => {
  const one = fixture(t), two = fixture(t), home = path.join(one.data, 'home');
  const burn = require('@agentguard-run/burn'), sdk = require('@agentguard-run/spend');
  const policy = {version: 1, mode: 'enforce', licenseKey: 'ag_synthetic_team'};
  const status = {paid: true, tier: 'startup', seatStatus: 'registered', expiresAt: '2026-11-01T00:00:00Z', seatIdentity: {machineFingerprint: '2'.repeat(64)}};
  fs.mkdirSync(path.join(home, 'plugin-ledgers'), {recursive: true});
  for (const [fixture, host, tokens] of [[one, 'claude-code', 120], [two, 'codex', 80]]) {
    const {data, seed} = fixture; sync.setEnabled(data, true);
    fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify(policy));
    fs.writeFileSync(path.join(home, 'plugin-ledgers', host + '.json'), JSON.stringify({data}));
    fs.mkdirSync(path.join(data, 'ledger'));
    const publicKey = Buffer.from(fs.readFileSync(path.join(data, 'public-key.hex'), 'utf8'), 'hex');
    const rows = [];
    for (let i = 0; i < 2; i++) {
      const decision = {decisionId: host + i, timestamp: '2026-10-04T12:00:00Z', action: 'allow', reasons: [],
        plugin: {host, sessionId: host + '-session', gate: i ? 'control' : 'burn', event: i ? 'session_receipt' : 'decision', toolName: i ? 'session_receipt' : host === 'codex' ? 'functions.collaboration.spawn_agent' : 'Agent', toolUseId: 'launch', ...(i ? {receipt: {version: 1, tokens}} : {})}};
      rows.push(await sdk.signDecision({decision, sequence: i, previousHash: rows.at(-1)?.entryHash ?? sdk.GENESIS_PREVIOUS_HASH, privateKey: Buffer.from(seed, 'hex'), publicKey}));
    }
    fs.writeFileSync(path.join(data, 'ledger/decisions.ndjson'), rows.map(JSON.stringify).join('\n') + '\n');
  }
  let release, calls = 0, envelope;
  const blocked = new Promise(resolve => {release = resolve;});
  const args = {data: one.data, home, now: NOW, featureEnabled: true, policy, burn, licenseReader: () => status,
    transport: async (_url, options) => {calls++; envelope = JSON.parse(options.body); await blocked; return {ok: true, status: 200};}};
  const first = sync.syncDailyCounts(args);
  // Await receipt verification until the transport is entered.
  for (let n = 0; !calls && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 1); assert.equal(envelope.payload.counts.launches, 2); assert.equal(envelope.payload.tokens, 200);
  assert.equal(envelope.publicKey, sync.signPayload({}, one.seed).publicKey);
  assert.deepEqual(await sync.syncDailyCounts({...args, data: two.data}), {status: 'busy'});
  release(); assert.equal((await first).status, 'synced');
  assert.equal((await sync.syncDailyCounts({...args, data: two.data})).status, 'already_synced');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(envelope).includes('-session'), false);
  // A later import changing a completed day cannot overwrite immutable counts.
  const reader = { ...burn, readLedgerDailyTallies: async data => (await burn.readLedgerDailyTallies(data)).map(row => row.status === 'verified' ? {...row, tokens: row.tokens + 1} : row)};
  assert.equal((await sync.syncDailyCounts({...args, data: two.data, burn: reader})).status, 'changed_after_sync');
  assert.equal(calls, 1);
});

test('detached counts scheduling waits for durable receipts, retries failures and stays outside the hook reply', async () => {
  let durable = false, released, now = 100, calls = 0;
  const blocked = new Promise(resolve => {released = resolve;});
  const worker = new sync.DailyCountsScheduler({data: '/unused', now: () => now,
    flush: async () => {await blocked; durable = true;}, sync: async () => {assert.equal(durable, true); calls++; return {status: 'off'};}});
  assert.equal(await worker.tick(), undefined); worker.completed('session');
  const running = worker.tick(); assert.equal(calls, 0);
  assert.equal(await worker.tick(), undefined, 'one background task at a time');
  released(); assert.deepEqual(await running, {status: 'off'}); assert.equal(calls, 1);
  assert.equal(await worker.tick(), undefined); now += 60000; await worker.tick(); assert.equal(calls, 2);
  const failed = new sync.DailyCountsScheduler({flush: async () => {throw new Error('disk full');}, sync: () => assert.fail('unsigned receipts reached sync')});
  failed.completed('session'); assert.deepEqual(await failed.tick(), {status: 'unavailable'});
});
