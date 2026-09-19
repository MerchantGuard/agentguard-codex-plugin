'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {LiveSessions, findHost, findHostPid, ACTIVITY_LEASE_MS} = require('../runtime/live-sessions.cjs');
const originalProcess = ' 100 Fri Sep 18 12:00:00 2026 /Applications/Codex.app/Contents/MacOS/codex\n';
const ownerIdentity = findHost(4242, () => originalProcess).ownerIdentity;
function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-session-life-'));
  t.after(() => fs.rmSync(data, {recursive:true, force:true}));
  return data;
}
test('identified host sessions survive idle time and stop renewing after host exit or SessionEnd', async t => {
  let now = 0, running = true;
  const live = new LiveSessions({data: fixture(t), now: () => now, isAlive: pid => pid === 4242 && running,
    readHost: async () => originalProcess});
  live.observe('hosted', 4242, ownerIdentity); now += ACTIVITY_LEASE_MS * 2;
  assert.equal(live.isLive('hosted'), true);
  assert.equal(await live.confirmHost('hosted'), true);
  running = false; assert.equal(live.isLive('hosted'), false);
  live.observe('ended', 4242, ownerIdentity); live.forget('ended'); assert.equal(live.isLive('ended'), false);
});
test('unidentified host sessions expire after fifteen minutes without tool activity', t => {
  let now = 0;
  const live = new LiveSessions({data: fixture(t), now: () => now});
  live.observe('session'); now += ACTIVITY_LEASE_MS - 1;
  assert.equal(live.isLive('session'), true);
  live.observe('session'); now += ACTIVITY_LEASE_MS - 1;
  assert.equal(live.isLive('session'), true);
  now += 1; assert.equal(live.isLive('session'), false);
});
test('worker restart restores only live leases and private registry contains no license key', async t => {
  const data = fixture(t); let now = 0;
  const live = new LiveSessions({data, now: () => now, isAlive: () => true});
  live.observe('hosted',4242,ownerIdentity); live.observe('activity'); await live.persist(); now += ACTIVITY_LEASE_MS;
  const restored = new LiveSessions({data, now: () => now, isAlive: () => true});
  assert.deepEqual(restored.ids(), ['hosted']);
  assert.equal(fs.statSync(path.join(data,'live-sessions.json')).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(data,'live-sessions.json')))[0]), ['sessionId','ownerPid','ownerIdentity','lastActivity']);
});
test('lifecycle discovery walks a transient shell to the host without treating a generic terminal as a session', () => {
  const responses = new Map([[10,' 20 Fri Sep 18 12:00:00 2026 /bin/sh\n'],[20,originalProcess]]);
  assert.equal(findHostPid(10, pid => responses.get(pid)),20);
  assert.deepEqual(findHost(10, pid => responses.get(pid)), {ownerPid: 20, ownerIdentity});
  assert.equal(findHostPid(10, () => '1 Fri Sep 18 12:00:00 2026 /bin/zsh\n'),null);
  assert.equal(findHostPid('invalid', () => {throw new Error();}),null);
});

test('a recycled live PID cannot renew a stale session even when the executable has the same name', async t => {
  const reused = originalProcess.replace('12:00:00', '13:00:00');
  const live = new LiveSessions({data: fixture(t), now: () => 0, isAlive: () => true, readHost: async () => reused});
  live.observe('old-session', 4242, ownerIdentity);
  assert.equal(live.isLive('old-session'), true);
  assert.equal(await live.confirmHost('old-session'), false);
  assert.deepEqual(live.ids(), []);
});

test('legacy PID-only rows use the activity lease and cannot stay live indefinitely', async t => {
  const data = fixture(t); let now = 0;
  fs.writeFileSync(path.join(data, 'live-sessions.json'), JSON.stringify([{sessionId: 'old', ownerPid: 4242, lastActivity: 0}]));
  const live = new LiveSessions({data, now: () => now, isAlive: () => true,
    readHost: async () => {throw new Error('PID-only row should not query ps');}});
  assert.equal(await live.confirmHost('old'), true);
  now += ACTIVITY_LEASE_MS;
  assert.equal(await live.confirmHost('old'), false);
});

test('process discovery failure stops renewal and synchronous liveness never queries ps', async t => {
  let calls = 0;
  const live = new LiveSessions({data: fixture(t), now: () => 0, isAlive: () => true,
    readHost: async () => {calls++; throw new Error('process unavailable');}});
  live.observe('session', 4242, ownerIdentity);
  assert.equal(live.isLive('session'), true);
  assert.deepEqual(live.ids(), ['session']);
  assert.equal(calls, 0);
  assert.equal(await live.confirmHost('session'), false);
  assert.equal(calls, 1);
});

test('SessionEnd during an asynchronous host check prevents renewal', async t => {
  let finish;
  const live = new LiveSessions({data: fixture(t), now: () => 0, isAlive: () => true,
    readHost: () => new Promise(resolve => {finish = resolve;})});
  live.observe('session', 4242, ownerIdentity);
  const check = live.confirmHost('session');
  live.forget('session'); finish(originalProcess);
  assert.equal(await check, false);
});

test('tool activity preserves the host identity while an asynchronous check completes', async t => {
  let now = 0, finish;
  const live = new LiveSessions({data: fixture(t), now: () => now, isAlive: () => true,
    readHost: () => new Promise(resolve => {finish = resolve;})});
  live.observe('session', 4242, ownerIdentity);
  const check = live.confirmHost('session');
  now = 500; live.observe('session'); finish(originalProcess);
  assert.equal(await check, true);
});
