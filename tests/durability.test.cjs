'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const sdk = require('@agentguard-run/spend');
const {Engine} = require('../runtime/engine.cjs');
const {metadata} = require('../runtime/common.cjs');
const paid = () => ({paid: true, tier: 'solo', seatsUsed: 1, seatLimit: 1, expiresAt: null});
const tick = () => new Promise(resolve => setImmediate(resolve));
const sync = fd => new Promise((resolve, reject) => fs.fdatasync(fd, error => error ? reject(error) : resolve()));
let id = 0;
async function fixture(t, options = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-durability-'));
  const previous = {PLUGIN_DATA: process.env.PLUGIN_DATA, AGENTGUARD_PLUGIN_POLICY: process.env.AGENTGUARD_PLUGIN_POLICY};
  process.env.PLUGIN_DATA = data;
  delete process.env.AGENTGUARD_PLUGIN_POLICY;
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', deniedTools: ['^Write$']}));
  const engines = [];
  const start = async extra => {
    const engine = new Engine({licenseReader: paid, ...options, ...extra});
    await engine.init(); engines.push(engine); return engine;
  };
  const engine = await start();
  const file = engine.logStore.filePath;
  t.after(() => {
    // Closing descriptors without a flush simulates abandonment where needed.
    for (const value of engines) if (!value.logStore.closed) {
      value.logStore.closed = true;
      fs.closeSync(value.logStore.fd);
    }
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true});
  });
  const call = target => target.handle({meta: metadata({tool_name: 'Write', session_id: 'synthetic-durability', tool_use_id: `synthetic-${id++}`, tool_input: {file_path: '/synthetic/path'}}, 'spend')});
  const rows = () => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const verified = async () => assert.equal((await sdk.verifyChain(rows(), engine.publicKey)).ok, true);
  return {data, engine, start, file, call, rows, verified};
}

test('a signed denial is written before reply without starting a durability flush', async t => {
  let calls = 0, release;
  const f = await fixture(t, {logOptions: {syncFd: fd => { calls++; return new Promise(resolve => {release = () => sync(fd).then(resolve);}); }}});
  const result = await f.call(f.engine);
  assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(calls, 0);
  assert.equal(f.rows().length, 1);
  f.engine.afterReply();
  await tick();
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(f.engine.logStore.checkpointPath), false);
  release();
  assert.equal(await f.engine.flush(), true);
  assert.equal(JSON.parse(fs.readFileSync(f.engine.logStore.checkpointPath)).sequence, 0);
  await f.verified();
});

test('40 ms asynchronous ledger sync leaves the next decision responsive and checkpoints its own head', async t => {
  let flushes = 0;
  const f = await fixture(t, {logOptions: {syncFd: fd => new Promise((resolve, reject) => {
    flushes++;
    setTimeout(() => sync(fd).then(resolve, reject), 40);
  })}});
  await f.call(f.engine);
  f.engine.afterReply();
  await tick();
  const started = performance.now();
  const result = await f.call(f.engine);
  assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(performance.now() - started < 40, 'the second decision must not await the 40 ms sync');
  f.engine.afterReply();
  assert.equal(await f.engine.flush(), true);
  assert.ok(flushes >= 2);
  assert.equal(JSON.parse(fs.readFileSync(f.engine.logStore.checkpointPath)).sequence, 1);
  await f.verified();
});

test('a completed flush gives a clean restart without a spurious integrity event', async t => {
  const f = await fixture(t);
  await f.call(f.engine);
  assert.equal(await f.engine.flush(), true);
  const restarted = await f.start();
  assert.equal(f.rows().length, 1);
  await f.call(restarted);
  assert.equal(await restarted.flush(), true);
  await f.verified();
});

test('an unconfirmed valid tail is retained and gains a signed integrity event', async t => {
  const f = await fixture(t);
  await f.call(f.engine);
  await f.engine.flush();
  await f.call(f.engine);
  const original = fs.readFileSync(f.file, 'utf8');
  const restarted = await f.start();
  const rows = f.rows(), event = rows.at(-1).decision.plugin;
  assert.equal(rows.length, 3);
  assert.ok(fs.readFileSync(f.file, 'utf8').startsWith(original));
  assert.equal(event.event, 'integrity');
  assert.deepEqual(event.integrity, {reason: 'unconfirmed_tail_recovered', confirmedSequence: 0,
    confirmedHash: rows[0].entryHash, recoveredHeadHash: rows[1].entryHash,
    recoveredRows: 1, truncatedBytes: 0, checkpointMissing: false});
  await restarted.flush();
  await f.verified();
});

test('legacy signed chains without checkpoints are conservatively reconciled without rewriting rows', async t => {
  const f = await fixture(t);
  await f.call(f.engine);
  const original = fs.readFileSync(f.file, 'utf8');
  const restarted = await f.start();
  assert.ok(fs.readFileSync(f.file, 'utf8').startsWith(original));
  assert.equal(f.rows().at(-1).decision.plugin.integrity.checkpointMissing, true);
  assert.equal(f.rows().at(-1).decision.plugin.integrity.recoveredRows, 1);
  await restarted.flush();
  await f.verified();
});

test('only an incomplete final row beyond the checkpoint is truncated and its byte count is signed', async t => {
  const f = await fixture(t);
  await f.call(f.engine);
  await f.engine.flush();
  const partial = '{"sequence":1,"decision":';
  fs.appendFileSync(f.file, partial);
  const restarted = await f.start();
  const event = f.rows().at(-1).decision.plugin.integrity;
  assert.equal(event.reason, 'incomplete_tail_discarded');
  assert.equal(event.truncatedBytes, Buffer.byteLength(partial));
  assert.equal(event.recoveredRows, 0);
  await restarted.flush();
  await f.verified();
});

test('complete invalid rows and an altered confirmed prefix are never removed during startup', async t => {
  const f = await fixture(t);
  await f.call(f.engine);
  await f.engine.flush();
  const original = fs.readFileSync(f.file, 'utf8');
  for (const suffix of ['{"sequence":1}\n', '{"sequence":1}', '{broken}\n']) {
    fs.writeFileSync(f.file, original + suffix);
    await assert.rejects(f.start(), /invalid_existing_chain/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original + suffix);
  }
  const tampered = JSON.parse(original);
  tampered.decision.action = 'allow';
  const text = JSON.stringify(tampered) + '\n';
  fs.writeFileSync(f.file, text);
  await assert.rejects(f.start(), /invalid_existing_chain/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), text);
});

test('an inconsistent durable checkpoint refuses startup without changing the chain', async t => {
  const f = await fixture(t);
  await f.call(f.engine);
  await f.engine.flush();
  const original = fs.readFileSync(f.file, 'utf8');
  const checkpoint = JSON.parse(fs.readFileSync(f.engine.logStore.checkpointPath));
  checkpoint.entryHash = '0'.repeat(64);
  fs.writeFileSync(f.engine.logStore.checkpointPath, JSON.stringify(checkpoint));
  await assert.rejects(f.start(), /invalid_durable_checkpoint/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  for (const invalid of ['null', 'false', '[]', '{broken']) {
    fs.writeFileSync(f.engine.logStore.checkpointPath, invalid);
    await assert.rejects(f.start(), /invalid_durable_checkpoint/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  }
});

test('a failed sync leaves the checkpoint behind and is recorded on next startup', async t => {
  const f = await fixture(t);
  await f.call(f.engine);
  await f.engine.flush();
  const before = fs.readFileSync(f.engine.logStore.checkpointPath, 'utf8');
  f.engine.logStore.syncFd = async () => {throw new Error('synthetic fs failure');};
  await f.call(f.engine);
  assert.equal(await f.engine.flush(), false);
  assert.equal(fs.readFileSync(f.engine.logStore.checkpointPath, 'utf8'), before);
  const restarted = await f.start();
  assert.equal(f.rows().at(-1).decision.plugin.integrity.reason, 'durability_sync_failed');
  assert.equal(f.rows().at(-1).decision.plugin.integrity.recoveredRows, 1);
  assert.equal(await restarted.flush(), true);
  assert.equal(fs.existsSync(restarted.logStore.failurePath), false);
  await f.verified();
});

test('a concurrent append is not included in the earlier sync checkpoint', async t => {
  const releases = [], snapshots = [];
  const f = await fixture(t, {logOptions: {syncFd: fd => new Promise((resolve, reject) => {
    releases.push(() => sync(fd).then(resolve, reject));
  })}});
  const originalCheckpoint = f.engine.logStore.writeCheckpoint.bind(f.engine.logStore);
  f.engine.logStore.writeCheckpoint = async snapshot => {snapshots.push(snapshot.sequence); await originalCheckpoint(snapshot);};
  await f.call(f.engine);
  f.engine.afterReply();
  await tick();
  await f.call(f.engine);
  f.engine.afterReply();
  releases[0]();
  const deadline = Date.now() + 5000;
  while (releases.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(releases.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(f.engine.logStore.checkpointPath)).sequence, 0);
  releases[1]();
  assert.equal(await f.engine.flush(), true);
  assert.deepEqual(snapshots, [0, 1]);
  await f.verified();
});

test('a successful retry keeps a prior sync failure visible to the next worker', async t => {
  const f = await fixture(t);
  await f.call(f.engine);
  f.engine.logStore.syncFd = async () => {throw new Error('synthetic failure');};
  assert.equal(await f.engine.flush(), false);
  f.engine.logStore.syncFd = sync;
  assert.equal(await f.engine.flush(), true);
  assert.equal(fs.existsSync(f.engine.logStore.failurePath), true);
  const restarted = await f.start();
  const event = f.rows().at(-1).decision.plugin.integrity;
  assert.equal(event.reason, 'durability_sync_failed');
  assert.equal(event.recoveredRows, 0);
  assert.equal(event.confirmedSequence, 0);
  await restarted.flush();
  await f.verified();
});

test('outside writes remain detectable while an asynchronous tail is pending', async t => {
  let release;
  const f = await fixture(t, {logOptions: {syncFd: () => new Promise(resolve => {release = resolve;})}});
  await f.call(f.engine);
  f.engine.afterReply();
  await tick();
  fs.appendFileSync(f.file, '{}\n');
  release();
  assert.equal(await f.engine.flush(), false);
  assert.equal(fs.existsSync(f.engine.logStore.checkpointPath), false);
});

test('process death after the row write and before sync preserves a verifiable recovery event', async t => {
  const f = await fixture(t);
  await f.call(f.engine);
  await f.engine.flush();
  const source = `const {Engine}=require(${JSON.stringify(path.join(__dirname, '..', 'runtime', 'engine.cjs'))});
    (async()=>{const e=new Engine({licenseReader:()=>({paid:true,tier:'solo'}),logOptions:{syncFd:()=>new Promise(()=>{})}});
    await e.init(); await e.append(e.basic({toolName:'Read',toolUseId:'synthetic-crash',sessionId:'synthetic-crash',gate:'spend'},'allow','synthetic_allowed'));
    e.afterReply(); setImmediate(()=>process.kill(process.pid,'SIGKILL'));})().catch(()=>process.exit(2));`;
  const result = spawnSync(process.execPath, ['-e', source], {env: {...process.env}, encoding: 'utf8', timeout: 5000});
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  const restarted = await f.start();
  assert.equal(f.rows().at(-1).decision.plugin.integrity.recoveredRows, 1);
  assert.equal(f.rows().at(-1).decision.plugin.integrity.confirmedSequence, 0);
  await restarted.flush();
  await f.verified();
});
