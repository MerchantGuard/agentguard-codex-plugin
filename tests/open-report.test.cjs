'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {openReport, openerFor, canOpen, acceptable} = require('../runtime/open-report.cjs');

const ORIGIN = 'https://agentguard.run';
const URL_OK = `${ORIGIN}/score/abc123`;

function spy() {
  const calls = [];
  const child = {unref: 0, on() {}};
  const spawnImpl = (command, args, options) => { calls.push({command, args, options}); return {unref() { child.unref += 1; }, on() {}}; };
  return {calls, child, spawnImpl};
}

test('each platform gets its own opener with the address as a single argument', () => {
  assert.deepEqual(openerFor('darwin')(URL_OK), ['open', [URL_OK]]);
  assert.deepEqual(openerFor('win32')(URL_OK), ['cmd', ['/c', 'start', '', URL_OK]]);
  assert.deepEqual(openerFor('linux')(URL_OK), ['xdg-open', [URL_OK]]);
});

test('only an https address on the consented origin is acceptable', () => {
  assert.equal(acceptable(URL_OK, ORIGIN), true);
  for (const bad of ['http://agentguard.run/score/abc', 'https://elsewhere.example/score/abc', 'https://user:pw@agentguard.run/score/abc', `${ORIGIN}`, 42, null]) {
    assert.equal(acceptable(bad, ORIGIN), false, String(bad));
  }
});

test('the opener is off with AGENTGUARD_NO_BROWSER=1 and on Linux without a display', () => {
  assert.equal(canOpen({AGENTGUARD_NO_BROWSER: '1'}, 'darwin'), false);
  assert.equal(canOpen({}, 'linux'), false);
  assert.equal(canOpen({DISPLAY: ':0'}, 'linux'), true);
  assert.equal(canOpen({}, 'darwin'), true);
  assert.equal(canOpen({}, 'win32'), true);
});

test('openReport spawns once, detached and unreferenced, and reports true', () => {
  const s = spy();
  assert.equal(openReport(URL_OK, {origin: ORIGIN, platform: 'darwin', env: {}, spawnImpl: s.spawnImpl}), true);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].args, [URL_OK]);
  assert.equal(s.calls[0].options.detached, true);
  assert.equal(s.calls[0].options.stdio, 'ignore');
});

test('openReport never spawns for a bad address, a disabled environment or a failing spawner', () => {
  const s = spy();
  assert.equal(openReport('https://elsewhere.example/score/abc', {origin: ORIGIN, platform: 'darwin', env: {}, spawnImpl: s.spawnImpl}), false);
  assert.equal(openReport(URL_OK, {origin: ORIGIN, platform: 'darwin', env: {AGENTGUARD_NO_BROWSER: '1'}, spawnImpl: s.spawnImpl}), false);
  assert.equal(s.calls.length, 0);
  assert.equal(openReport(URL_OK, {origin: ORIGIN, platform: 'darwin', env: {}, spawnImpl: () => { throw new Error('no opener'); }}), false);
});
