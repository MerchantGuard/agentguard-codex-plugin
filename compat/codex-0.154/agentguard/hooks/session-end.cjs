#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const {request} = require('../runtime/client.cjs');
const text = fs.readFileSync(0, 'utf8');
(async () => {
  // Benchmark mode handles the call only with the operator's signed consent.
  if (process.env.AGENTGUARD_BENCHMARK === '1' && await require('../runtime/benchmark.cjs').run('session-end', text)) return;
  try {
    const raw = JSON.parse(text);
    const sessionId = raw.session_id || raw.sessionId;
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new Error();
    // The tip for the next session: this hook records which session ended and
    // starts a detached process that reads its transcript. It reads nothing here.
    try { require('../runtime/session-tip.cjs').ended({sessionId, transcriptPath: raw.transcript_path}); } catch { /* No tip. */ }
    await request({control: 'session-end', sessionId}, {startWorker: false, timeoutMs: 250});
  } catch { /* Host liveness and the activity lease also stop renewal. */ }
  process.stdout.write('{}\n');
})();
