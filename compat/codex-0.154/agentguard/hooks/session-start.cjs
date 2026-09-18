#!/usr/bin/env node
'use strict';
// The hook only starts a separate lifecycle process. It never resolves a key,
// waits for a service, or opens a socket.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
try {
  const raw = JSON.parse(fs.readFileSync(0, 'utf8'));
  const sessionId = raw.session_id || raw.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length > 512 || !sessionId) throw new Error();
  const child = spawn(process.execPath, [path.join(__dirname, '../runtime/session-start.cjs'), sessionId],
    {detached: true, stdio: 'ignore', env: process.env});
  child.on('error', () => {});
  child.unref();
} catch { process.stderr.write('agentguard: session startup unavailable; cached license or shadow mode applies.\n'); }
process.stdout.write('{}\n');
