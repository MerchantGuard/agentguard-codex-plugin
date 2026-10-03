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
    // One request to a running worker ends the session and asks for its work
    // receipt, which the worker signs before it answers. The wait is bounded;
    // a request it could not take is kept for its next start. Nothing prints.
    await require('../runtime/work-receipt.cjs').sessionEnd({sessionId, transcriptPath: raw.transcript_path, request,
      data: require('../runtime/common.cjs').locations().data});
  } catch { /* Host liveness and the activity lease also stop renewal. */ }
  process.stdout.write('{}\n');
})();
