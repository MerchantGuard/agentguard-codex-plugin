#!/usr/bin/env node
'use strict';
const { request } = require('./client.cjs');
if (process.argv[2] !== 'stop') { process.stderr.write('Usage: node runtime/control.cjs stop\n'); process.exitCode = 1; }
else {
  // An owner-checked private mailbox request cannot kill an unrelated stale PID.
  request({ control: 'stop' }, { startWorker: false, timeoutMs: 1800 }).catch(() => { process.exitCode = 1; });
}
