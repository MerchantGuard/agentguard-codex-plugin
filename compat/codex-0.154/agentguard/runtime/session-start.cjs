#!/usr/bin/env node
'use strict';
const {locations} = require('./common.cjs');
const {readPolicy} = require('./policy-file.cjs');
const {resolveSessionLicense} = require('./license.cjs');
async function start(sessionId) {
  const {data} = locations();
  const {policy} = readPolicy(data);
  return resolveSessionLicense({data, sessionId, policy});
}
module.exports = {start};
if (require.main === module) start(process.argv[2] || 'local').catch(() => { process.exitCode = 1; });
