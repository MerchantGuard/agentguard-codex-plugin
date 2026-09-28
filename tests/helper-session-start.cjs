'use strict';
// SessionStart and SessionEnd run as the host runs them, in temporary directories: HOME,
// AGENTGUARD_HOME and the plugin data directory are all under one temporary folder, so
// nothing reaches ~/.agentguard or ~/.claude. By default the machine has run the plugin
// before (the once-only lines are used up), so a start with nothing to say prints {}.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const matrix = require('./helper-host-matrix.cjs');
const tips = require('../runtime/session-tip.cjs');
const moments = require('../runtime/upgrade-moments.cjs');
const root = path.resolve(__dirname, '..');

function fixture(t, {fresh = false} = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-session-start-')));
  const data = path.join(base, 'data'), home = path.join(base, 'home'), agentguard = path.join(home, '.agentguard');
  fs.mkdirSync(data, {mode: 0o700}); fs.mkdirSync(home);
  const names = [...matrix.envKeys, 'HOME', 'AGENTGUARD_HOME', 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  matrix.environment(process.env, data);
  Object.assign(process.env, {HOME: home, AGENTGUARD_HOME: agentguard, AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_PLUGIN_POLICY: ''});
  fs.writeFileSync(path.join(data, 'policy.json'), '{"version":1,"mode":"enforce"}');
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; fs.rmSync(base, {recursive: true, force: true}); });
  if (!fresh) {
    for (const name of ['first-run', 'agent-score-invite']) assert.equal(moments.claim(name, {home: agentguard}), true);
    fs.writeFileSync(path.join(data, 'policy-preset-hint-seen'), '1\n');
  }
  // SessionStart's lifecycle helper would start the license worker, which plays no part here.
  const preload = path.join(base, 'no-child.cjs');
  fs.writeFileSync(preload, "require('node:child_process').spawn = () => ({on(){}, unref(){}});");
  const hook = (name, payload, stub) => {
    const child = spawnSync(process.execPath, [...(stub ? ['-r', preload] : []), path.join(root, 'hooks', name)], {env: process.env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 20000});
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    return JSON.parse(child.stdout);
  };
  const start = (sessionId, source = 'startup') => hook('session-start.cjs', matrix.payload({session_id: sessionId, source, cwd: home, hook_event_name: 'SessionStart'}, 'SessionStart'), true);
  const end = (sessionId, transcriptPath) => hook('session-end.cjs', matrix.payload({session_id: sessionId, transcript_path: transcriptPath, cwd: home, hook_event_name: 'SessionEnd', reason: 'other'}, 'SessionEnd'), false);
  // What SessionEnd and its detached step store, without starting a process.
  const stored = (sessionId, tip, now = Date.now()) => {
    const spawned = [], transcriptPath = path.join(base, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, '');
    assert.equal(tips.ended({sessionId, transcriptPath, now, spawnImpl: (...args) => { spawned.push(args); return {on() {}, unref() {}}; }}), true);
    assert.equal(spawned.length, 1);
    return tips.compute({sessionId, endedAt: now, now, transcriptPath, sessionTip: () => tip});
  };
  const record = () => tips.read(data).last;
  const waitFor = (predicate, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) { if (Date.now() > deadline) return false; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
    return true;
  };
  return {base, data, home, agentguard, start, end, stored, record, waitFor};
}
module.exports = {fixture, root};
