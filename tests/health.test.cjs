'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {HealthTracker, readHealth, HOUR_MS} = require('../runtime/health.cjs');
function fixture(t, options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-health-'));
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  let time = Date.parse('2026-09-18T12:00:00Z');
  const now = () => time;
  const tracker = new HealthTracker({data, now, ...options});
  const call = (requestId, changes = {}) => tracker.record({requestId, gate: 'spend', startedAt: new Date(time).toISOString(), ...changes});
  return {data, tracker, call, now, advance: amount => { time += amount; }};
}

test('health counts both gate invocations, keeps receipts separate, and warns strictly above five percent', t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) f.call(`gate-${i}`, {gate: i % 2 ? 'burn' : 'spend', failOpen: i === 0, cause: 'worker_timeout'});
  f.call('receipt-1', {gate: 'receipt', failOpen: true, cause: 'hook_internal_error'});
  let status = f.tracker.snapshot();
  assert.equal(status.lastHour.total, 20);
  assert.equal(status.lastHour.failOpenCount, 1);
  assert.equal(status.lastHour.ratePercent, 5);
  assert.equal(status.warning, null);
  assert.equal(status.postToolUse.lastHour.total, 1);
  assert.equal(status.postToolUse.lastHour.failOpenCount, 1);
  f.call('gate-21', {failOpen: true, cause: 'worker_timeout'});
  status = f.tracker.snapshot();
  assert.equal(status.lastHour.total, 21);
  assert.equal(status.lastHour.failOpenCount, 2);
  assert.match(status.warning, /9\.5%.*2\/21.*worker_timeout/);
});

test('last hour expires observations while since-start counts persist', t => {
  const f = fixture(t);
  f.call('early', {failOpen: true, cause: 'worker_timeout'});
  f.advance(HOUR_MS);
  f.call('current');
  const status = f.tracker.snapshot();
  assert.equal(status.lastHour.total, 1);
  assert.equal(status.lastHour.failOpenCount, 0);
  assert.equal(status.sinceStart.total, 2);
  assert.equal(status.sinceStart.failOpenCount, 1);
  assert.match(status.warning, /50\.0% since worker start.*worker_timeout/);
});

test('worker restart retains last-hour history and resets since-start metrics', async t => {
  const f = fixture(t);
  f.call('first', {failOpen: true, cause: 'worker_timeout'});
  await f.tracker.persist();
  f.advance(1000);
  const second = new HealthTracker({data: f.data, now: f.now});
  assert.equal(second.snapshot().lastHour.failOpenCount, 1);
  assert.equal(second.snapshot().sinceStart.total, 0);
  second.record({requestId: 'second', gate: 'burn', startedAt: new Date(f.now()).toISOString()});
  assert.equal(second.snapshot().sinceStart.total, 1);
  await second.persist();
  const status = readHealth({data: f.data, now: f.now});
  assert.equal(status.source, 'worker_snapshot');
  assert.equal(status.denominatorComplete, true);
  assert.equal(status.lastHour.total, 2);
  assert.equal(status.sinceStart.total, 1);
});

test('timeout upgrades a completed request once and late success never erases it', async t => {
  const f = fixture(t);
  const startedAt = new Date(f.now()).toISOString();
  f.call('same');
  await f.tracker.persist();
  const pending = {requestId: 'same', gate: 'spend', startedAt, event: 'fail_open', reasonCode: 'worker_timeout'};
  fs.writeFileSync(path.join(f.data, 'fail-open-pending.ndjson'), JSON.stringify(pending) + '\n' + JSON.stringify(pending) + '\n');
  let status = readHealth({data: f.data, now: f.now});
  assert.equal(status.lastHour.total, 1);
  assert.equal(status.lastHour.failOpenCount, 1);
  assert.equal(status.sinceStart.total, 1);
  assert.equal(status.pendingObservations, 1);
  f.tracker.recordPending();
  f.call('same');
  status = f.tracker.snapshot();
  assert.equal(status.lastHour.total, 1);
  assert.equal(status.lastHour.failOpenCount, 1);
  assert.equal(status.sinceStart.failOpenCount, 1);
  assert.deepEqual(status.lastHour.causeCounts, {worker_timeout: 1});
});

test('busy worker status overlays pending failures before a signed recovery row exists', async t => {
  const f = fixture(t);
  f.call('success');
  await f.tracker.persist();
  f.advance(1);
  fs.writeFileSync(path.join(f.data, 'fail-open-pending.ndjson'), JSON.stringify({requestId: 'busy', gate: 'burn', startedAt: new Date(f.now()).toISOString(), reasonCode: 'worker_timeout'}) + '\n');
  const status = readHealth({data: f.data, now: f.now});
  assert.equal(status.lastHour.total, 2);
  assert.equal(status.lastHour.failOpenCount, 1);
  assert.equal(status.observationsSigned, false);
  assert.match(status.warning, /worker_timeout/);
});

test('missing health snapshot reports a partial ledger fallback and unknown worker start', t => {
  const f = fixture(t);
  const entries = [{decision: {timestamp: new Date(f.now()).toISOString(), plugin: {gate: 'spend', requestId: 'a', event: 'decision'}}}, {decision: {timestamp: new Date(f.now()).toISOString(), plugin: {gate: 'spend', requestId: 'a', event: 'fail_open', reasonCode: 'worker_timeout'}}}, {decision: {timestamp: new Date(f.now()).toISOString(), plugin: {event: 'integrity'}}}];
  const status = readHealth({data: f.data, entries, now: f.now});
  assert.equal(status.source, 'ledger_fallback');
  assert.equal(status.denominatorComplete, false);
  assert.equal(status.workerStartedAt, null);
  assert.equal(status.sinceStart, null);
  assert.equal(status.lastHour.total, 1);
  assert.equal(status.lastHour.failOpenCount, 1);
});

test('health persistence is content-free, bounded, and does not fdatasync a hook request', async t => {
  const f = fixture(t, {maxRecords: 2});
  let syncs = 0;
  const original = fs.fdatasyncSync;
  fs.fdatasyncSync = () => { syncs += 1; throw new Error('must not sync'); };
  try {
    for (let i = 0; i < 3; i++) f.call(`secret-id-${i}`, {failOpen: true, cause: 'secret-value', tool_input: {secret: 'request-content'}});
    const saving = f.tracker.persist();
    f.call('another');
    await saving;
    assert.equal(syncs, 0);
  } finally { fs.fdatasyncSync = original; }
  const saved = fs.readFileSync(path.join(f.data, 'health.json'), 'utf8');
  assert.doesNotMatch(saved, /secret-id|secret-value|request-content|tool_input/);
  const raw = JSON.parse(saved);
  assert.equal(raw.records.length, 2);
  assert.equal(raw.since.gates.total, 4);
  assert.equal(raw.truncated, true);
  assert.equal(fs.statSync(path.join(f.data, 'health.json')).mode & 0o777, 0o600);
});

test('recovered timeout leaves the pending queue without erasing the failure count', async t => {
  const f = fixture(t);
  f.call('timed-out');
  const filename = path.join(f.data, 'fail-open-pending.ndjson');
  fs.writeFileSync(filename, JSON.stringify({requestId: 'timed-out', gate: 'spend', startedAt: new Date(f.now()).toISOString(), reasonCode: 'worker_timeout'}) + '\n');
  f.tracker.recordPending();
  await f.tracker.persist();
  fs.unlinkSync(filename);
  const status = readHealth({data: f.data, now: f.now});
  assert.equal(status.pendingObservations, 0);
  assert.equal(status.lastHour.total, 1);
  assert.equal(status.lastHour.failOpenCount, 1);
});

test('MCP status exposes rolling counters and separates signed integrity rows from tool decisions', async t => {
  const f = fixture(t);
  // MCP's clock is real time; use real timestamps for this integration fixture.
  const tracker = new HealthTracker({data: f.data});
  tracker.record({requestId: 'normal', gate: 'burn', startedAt: new Date().toISOString()});
  tracker.record({requestId: 'timeout', gate: 'spend', startedAt: new Date().toISOString(), failOpen: true, cause: 'worker_timeout'});
  await tracker.persist();
  const sdk = require('@agentguard-run/spend');
  const keys = require('node:crypto').generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({format: 'der', type: 'pkcs8'}).subarray(-32);
  const publicKey = keys.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
  fs.writeFileSync(path.join(f.data, 'public-key.hex'), publicKey.toString('hex'));
  fs.mkdirSync(path.join(f.data, 'ledger'));
  const decision = {decisionId: 'synthetic-integrity', timestamp: new Date().toISOString(), action: 'allow', projectedCents: 0, entryType: 'decision', plugin: {event: 'integrity', gate: 'spend', integrity: {reason: 'unconfirmed_tail', confirmedSequence: -1, confirmedHash: '0'.repeat(64), recoveredHeadHash: '1'.repeat(64), recoveredRows: 1, truncatedBytes: 0, checkpointMissing: false}}};
  const entry = await sdk.signDecision({sequence: 0, decision, previousHash: '0'.repeat(64), privateKey, publicKey});
  fs.writeFileSync(path.join(f.data, 'ledger', 'decisions.ndjson'), JSON.stringify(entry) + '\n');
  const reader = require('../runtime/mcp.cjs').createReader({dataDir: f.data});
  const status = await reader.call('get_status');
  assert.equal(status.health.lastHour.total, 2);
  assert.equal(status.health.lastHour.failOpenCount, 1);
  assert.equal(status.health.sinceStart.total, 2);
  assert.match(status.health.warning, /50\.0%.*worker_timeout/);
  assert.equal(status.decisions, 0);
  assert.equal(status.spendCents, 0);
  assert.equal(status.integrityEvents, 1);
  assert.equal((await reader.call('verify_chain')).ok, true);
});

test('ledger repairs an observation lost between a signed append and health persistence', async t => {
  const f = fixture(t);
  const startedAt = new Date(f.now()).toISOString();
  // A request can start before another observation was persisted, then finish
  // after that snapshot. Its requestId is the deduplication key, not its time.
  f.advance(10);
  f.call('already-observed');
  await f.tracker.persist();
  const entries = [{decision: {timestamp: new Date(f.now()).toISOString(), plugin: {requestId: 'not-persisted', gate: 'spend', startedAt, event: 'decision'}}}];
  const status = readHealth({data: f.data, now: f.now, entries});
  assert.equal(status.lastHour.total, 2);
  assert.equal(status.sinceStart.total, 2);
});

test('a cold request timeout is counted since start when that worker later handles it', t => {
  const f = fixture(t);
  const startedAt = new Date(f.now() - 20).toISOString();
  f.tracker.record({requestId: 'cold', gate: 'spend', startedAt, failOpen: true, cause: 'worker_timeout', source: 'pending'});
  assert.equal(f.tracker.snapshot().sinceStart.total, 0);
  f.tracker.record({requestId: 'cold', gate: 'spend', startedAt});
  const status = f.tracker.snapshot();
  assert.equal(status.lastHour.total, 1);
  assert.equal(status.sinceStart.total, 1);
  assert.equal(status.sinceStart.failOpenCount, 1);
});

test('a signed row from an older worker never inflates the current worker total', async t => {
  const f = fixture(t);
  await f.tracker.persist();
  const entries = [{decision: {timestamp: new Date(f.now() - 1000).toISOString(), plugin: {requestId: 'previous-worker', gate: 'spend', event: 'fail_open', reasonCode: 'worker_timeout'}}}];
  const status = readHealth({data: f.data, now: f.now, entries});
  assert.equal(status.lastHour.total, 1);
  assert.equal(status.lastHour.failOpenCount, 1);
  assert.equal(status.sinceStart.total, 0);
  assert.equal(status.sinceStart.failOpenCount, 0);
});

test('a timeout recovered after its rolling record expired does not count twice since start', async t => {
  const f = fixture(t);
  const startedAt = new Date(f.now()).toISOString();
  f.call('old', {failOpen: true, cause: 'worker_timeout'});
  f.advance(HOUR_MS + 1);
  f.call('current');
  await f.tracker.persist();
  fs.writeFileSync(path.join(f.data, 'fail-open-pending.ndjson'), JSON.stringify({requestId: 'old', gate: 'spend', startedAt, reasonCode: 'worker_timeout'}) + '\n');
  f.tracker.recordPending();
  const status = readHealth({data: f.data, now: f.now});
  assert.equal(status.lastHour.total, 1);
  assert.equal(status.lastHour.failOpenCount, 0);
  assert.equal(status.sinceStart.total, 2);
  assert.equal(status.sinceStart.failOpenCount, 1);
  assert.equal(f.tracker.snapshot().sinceStart.total, 2);
});
