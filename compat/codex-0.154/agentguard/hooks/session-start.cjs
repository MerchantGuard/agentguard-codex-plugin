#!/usr/bin/env node
'use strict';
// The hook only starts a separate lifecycle process. It never resolves a key,
// waits for a service, or opens a socket.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const text = fs.readFileSync(0, 'utf8');
function normal() {
try {
  const raw = JSON.parse(text);
  const sessionId = raw.session_id || raw.sessionId;
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
  output = {systemMessage: 'AgentGuard presets: solo-dev, careful and strict. Apply one with node runtime/policy-cli.cjs preset careful from the plugin directory. No key or network is needed.'};
} catch { /* A missing hint must never affect session startup. */ }
try {
  const data = require('../runtime/common.cjs').locations().data;
  const policy = require('../runtime/policy-cli.cjs').localPolicy(data);
  if (!require('../runtime/license.cjs').configuredKey(policy)) {
    const message = moments.whatsNew(require('../package.json').version);
    if (message) output.systemMessage = [output.systemMessage, message].filter(Boolean).join('\n');
  }
} catch { /* Version copy never affects startup. */ }
process.stdout.write(JSON.stringify(output) + '\n');
}
// Benchmark mode handles the call only with the operator's signed consent for
// this run; otherwise the normal lifecycle path runs.
if (process.env.AGENTGUARD_BENCHMARK === '1') require('../runtime/benchmark.cjs').run('session-start', text).then(handled => { if (!handled) normal(); });
else normal();
