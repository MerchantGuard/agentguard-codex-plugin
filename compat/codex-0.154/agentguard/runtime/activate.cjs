#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {locations, hostContext} = require('./common.cjs');
const {readPolicy} = require('./policy-file.cjs');
const {readSessionLicense} = require('./license.cjs');
async function activate(key, options = {}) {
  if (typeof key !== 'string' || !/^ag_[A-Za-z0-9_-]{4,1000}$/.test(key.trim())) throw new Error('License key format is invalid.');
  const data = options.data || locations().data;
  const {personal} = readPolicy(data);
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const file = path.join(data, 'policy.json');
  const temporary = file + '.' + crypto.randomUUID();
  fs.writeFileSync(temporary, JSON.stringify({...personal, licenseKey: key.trim()}, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(temporary, file);
  const source = readPolicy(data);
  let policy = source.policy;
  const sessionId = options.sessionId || hostContext().sessionId || 'local';
  const host = require('./live-sessions.cjs').findHost(process.ppid);
  let status;
  try {
    const response = await (options.request || require('./client.cjs').request)({control: 'license-refresh', sessionId, ...host}, {data, timeoutMs: 5000});
    status = response.license || readSessionLicense({data, sessionId, policy});
  } catch { status = {...readSessionLicense({data, sessionId, policy}), mode: 'shadow', reason: 'license_unavailable'}; }
  if (require('./org-policy.cjs').orgEnabled(status)) {
    const org = require('./org-policy.cjs').readCachedOrgPolicy(data, {keyFingerprint: crypto.createHash('sha256').update(require('./license.cjs').configuredKey(policy)).digest('hex')});
    if (org.envelope) policy = require('./org-policy.cjs').mergeOrgPolicy(source.personal, source.shared, org.envelope.policy);
    if (org.reason) status = {...status, mode: 'shadow', reason: status.reason || org.reason};
  }
  try { require('./engine.cjs').validatePolicy(policy); } catch { status = {...status, mode: 'shadow', reason: status.reason || 'policy_invalid'}; }
  return {tier: status.tier, mode: status.paid && status.mode !== 'shadow' ? (policy.mode || 'enforce') : 'shadow', reason: status.reason, seatsUsed: status.seatsUsed,
    seatLimit: status.seatLimit, seatStorage: status.seatStorage ?? null, seatsVerified: status.seatsVerified === true, expiresAt: status.expiresAt, offlineGrace: status.offlineGrace};
}
module.exports = {activate};
if (require.main === module) activate(fs.readFileSync(0, 'utf8').trim(), {sessionId: process.argv[2]})
  .then(async status => { await require('./session-start.cjs').track(process.argv[2] || hostContext().sessionId || 'local', process.ppid).catch(() => {}); process.stdout.write(JSON.stringify(status) + '\n'); })
  .catch(() => {process.stderr.write('agentguard: activation could not complete; inspect local policy and license status.\n');process.exitCode = 1;});
