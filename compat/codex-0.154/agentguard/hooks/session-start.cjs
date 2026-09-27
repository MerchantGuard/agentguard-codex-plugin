#!/usr/bin/env node
'use strict';
// The hook only starts a separate lifecycle process. It never resolves a key,
// waits for a service, or opens a socket.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const text = fs.readFileSync(0, 'utf8');
// The first-run line describes enforcement, so it waits while this plugin's
// policy or license selects shadow, or while Burn's own policy chose shadow.
// With no Burn policy yet, the plugin writes one in enforce mode before the
// first spawn it gates.
function enforcing(sessionId) {
  const {locations} = require('../runtime/common.cjs');
  const state = require('../runtime/policy-state.cjs').policyState(locations().data, typeof sessionId === 'string' ? sessionId : 'unknown');
  if (state.license.mode === 'shadow' || (state.config.mode ?? 'enforce') !== 'enforce') return false;
  let burn;
  try { burn = JSON.parse(fs.readFileSync(path.join(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'), 'burn-policy.json'), 'utf8')); }
  catch (error) { return error.code === 'ENOENT'; }
  return burn?.mode === 'enforce' && Boolean(burn.thresholds);
}
function normal() {
let sessionId;
try {
  const raw = JSON.parse(text);
  sessionId = raw.session_id || raw.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length > 512 || !sessionId) throw new Error();
  const child = spawn(process.execPath, [path.join(__dirname, '../runtime/session-start.cjs'), sessionId, String(process.ppid)],
    {detached: true, stdio: 'ignore', env: process.env});
  child.on('error', () => {});
  child.unref();
} catch { process.stderr.write('agentguard: session startup unavailable; cached license or shadow mode applies.\n'); }
let output = {};
const moments = require('../runtime/upgrade-moments.cjs');
try {
  const data = require('../runtime/common.cjs').locations().data;
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  if (moments.quiet()) throw new Error('quiet');
  fs.writeFileSync(path.join(data, 'policy-preset-hint-seen'), '1\n', {flag: 'wx', mode: 0o600});
  // A command the person can paste, with this plugin's absolute paths.
  const host = require('../runtime/common.cjs').hostContext();
  output = {systemMessage: moments.presetHint({root: host.root || path.resolve(__dirname, '..'), data: host.data, host: host.host})};
} catch { /* A missing hint must never affect session startup. */ }
try {
  const data = require('../runtime/common.cjs').locations().data;
  const policy = require('../runtime/policy-cli.cjs').localPolicy(data);
  if (!require('../runtime/license.cjs').configuredKey(policy)) {
    const message = moments.whatsNew(require('../package.json').version);
    if (message) output.systemMessage = [output.systemMessage, message].filter(Boolean).join('\n');
  }
} catch { /* Version copy never affects startup. */ }
try {
  // Once per machine, after the lines above; its claim is taken only when shown.
  const line = moments.firstRun({host: require('../runtime/common.cjs').hostContext().host, enforcing: enforcing(sessionId)});
  if (line) output.systemMessage = [output.systemMessage, line].filter(Boolean).join('\n');
} catch { /* The first-run line never affects startup. */ }
try {
  // The invitation waits for a session with nothing else to say. Its claim is
  // only taken when it is shown, so a later quiet startup still carries it.
  if (!output.systemMessage) {
    const invite = moments.scoreInvite();
    if (invite) output.systemMessage = invite;
  }
} catch { /* The invitation never affects startup. */ }
process.stdout.write(JSON.stringify(output) + '\n');
}
// Benchmark mode handles the call only with the operator's signed consent for
// this run; otherwise the normal lifecycle path runs.
if (process.env.AGENTGUARD_BENCHMARK === '1') require('../runtime/benchmark.cjs').run('session-start', text).then(handled => { if (!handled) normal(); });
else normal();
