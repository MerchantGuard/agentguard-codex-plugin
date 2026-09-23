'use strict';
// This coordinator is called only by daemon.cjs in production. Tests inject
// transports here rather than giving lifecycle helpers a network code path.
async function refreshWorkerSession(options) {
  const [{resolveSessionLicense}, {refreshOrgPolicy}] = [require('./license.cjs'), require('./org-policy-refresh.cjs')];
  const [licenseResult, policyResult] = await Promise.allSettled([resolveSessionLicense(options), refreshOrgPolicy(options)]);
  if (licenseResult.status === 'rejected') throw licenseResult.reason;
  const license = licenseResult.value;
  if (policyResult.status === 'rejected') {
    if (require('./org-policy.cjs').soloEnabled(license)) return {...license, policySyncFailed: true};
    policyResult.reason.source = 'org'; throw policyResult.reason;
  }
  return license;
}
function failure(engine, sessionId, source) {
  const value = engine.sessionFailures.get(sessionId);
  return value instanceof Map ? value.get(source) : value;
}
function recoverSeatState(engine, sessionId, status) {
  if (status?.seatStatus !== 'registered' || status.seatRevoked) return;
  // A memory-only revocation is just as sticky as a persisted one. Legacy
  // success without an explicit revoked:false response cannot restore it.
  if (failure(engine, sessionId, 'seat') !== 'seat_revoked' || status.seatRevocationConfirmed === false)
    engine.clearSessionFailure(sessionId, 'seat');
  if (failure(engine, sessionId, 'startup') === 'seat_revoked' && status.seatRevocationConfirmed === false)
    engine.clearSessionFailure(sessionId, 'startup');
}
function recoverSessionState(engine, sessionId, status) {
  if (failure(engine, sessionId, 'startup') !== 'seat_revoked' || status?.seatRevocationConfirmed === false)
    engine.clearSessionFailure(sessionId, 'startup');
  recoverSeatState(engine, sessionId, status);
}
// A push result touches live sessions only when an upload was attempted and
// failed for a Solo key. A refusal (Free, Team, shadow license) changes nothing.
function recordPushResult(engine, sessionIds, result, reload = () => {}) {
  for (const id of sessionIds) {
    if (result.syncFailed) engine.recordOrgFailure(id, 'org_policy_unavailable');
    else if (!result.error) { engine.clearSessionFailure(id, 'org'); reload(id); }
  }
}
module.exports = {refreshWorkerSession, recoverSeatState, recoverSessionState, recordPushResult};
