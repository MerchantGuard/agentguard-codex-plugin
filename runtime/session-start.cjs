#!/usr/bin/env node
'use strict';
const {locations} = require('./common.cjs');
const {readPolicy} = require('./policy-file.cjs');
const {readSessionLicense} = require('./license.cjs');
const {findHost} = require('./live-sessions.cjs');
async function track(sessionId, parentPid, captured) {
  const host = captured ?? findHost(parentPid);
  await require('./client.cjs').request({control: 'session-start', sessionId, ...host});
}
async function start(sessionId, parentPid) {
  const host = findHost(parentPid);
  const {data} = locations();
  const {policy} = readPolicy(data);
  // Lifecycle helpers use private file IPC only. The worker owns every fetch.
  await track(sessionId, parentPid, host).catch(() => {});
  return readSessionLicense({data, sessionId, policy});
}
module.exports = {start, track};
if (require.main === module) start(process.argv[2] || 'local', process.argv[3]).catch(() => { process.exitCode = 1; });
