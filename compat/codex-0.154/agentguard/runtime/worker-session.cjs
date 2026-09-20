'use strict';
// This coordinator is called only by daemon.cjs in production. Tests inject
// transports here rather than giving lifecycle helpers a network code path.
async function refreshWorkerSession(options) {
  const [{resolveSessionLicense}, {refreshOrgPolicy}] = [require('./license.cjs'), require('./org-policy-refresh.cjs')];
  const [license] = await Promise.all([resolveSessionLicense(options), refreshOrgPolicy(options).catch(error => { error.source = 'org'; throw error; })]);
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
module.exports = {refreshWorkerSession, recoverSeatState, recoverSessionState};
