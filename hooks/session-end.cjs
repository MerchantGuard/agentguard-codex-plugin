#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const {request} = require('../runtime/client.cjs');
if (process.env.AGENTGUARD_BENCHMARK === '1') {
  require('../runtime/benchmark.cjs').run('session-end');
} else {
(async () => {
  try {
    const raw = JSON.parse(fs.readFileSync(0, 'utf8'));
    const sessionId = raw.session_id || raw.sessionId;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new Error();
    await request({control: 'session-end', sessionId}, {startWorker: false, timeoutMs: 250});
  } catch { /* Host liveness and the activity lease also stop renewal. */ }
  process.stdout.write('{}\n');
})();
}
