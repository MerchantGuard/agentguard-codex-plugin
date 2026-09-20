'use strict';
const {heartbeatSessionSeat, readSessionLicense} = require('./license.cjs');
const HEARTBEAT_MS = 5 * 60 * 1000;

// Constructed only by the worker. Merely importing this module starts no timer
// or network operation, and hooks do not instantiate the scheduler.
class SeatHeartbeatScheduler {
  constructor({data, postJson, now = Date.now, isLive = () => false,
    heartbeat = heartbeatSessionSeat, refreshOrg = require('./org-policy-refresh.cjs').refreshOrgPolicy,
    getPolicy, onOrgRefresh = () => {}, onOrgFailure = () => {}, onSeatRefresh = () => {}, onSeatFailure = () => {}, orgPolicyDigest = () => null} = {}) {
    this.data = data;
    this.postJson = postJson;
    this.now = now;
    this.isLive = isLive;
    this.heartbeat = heartbeat; this.refreshOrg = refreshOrg; this.getPolicy = getPolicy;
    this.onOrgRefresh = onOrgRefresh; this.onOrgFailure = onOrgFailure; this.onSeatRefresh = onSeatRefresh; this.onSeatFailure = onSeatFailure; this.orgPolicyDigest = orgPolicyDigest;
    this.sessions = new Map();
    this.stopped = false;
    this.tickPromise = null;
  }
  observe(sessionId, policy) {
    if (this.stopped || typeof sessionId !== 'string' || !sessionId) return;
    const previous = this.sessions.get(sessionId);
    const now = this.now();
    let refreshedAt;
    try { refreshedAt = Date.parse(readSessionLicense({data: this.data, sessionId, policy, now}).seatRefreshedAt); } catch {}
    const baseline = Number.isFinite(refreshedAt) ? Math.min(refreshedAt, now) : previous?.lastAttempt ?? now;
    this.sessions.set(sessionId, {policy, lastAttempt: Math.max(previous?.lastAttempt ?? baseline, baseline), heartbeats: previous?.heartbeats ?? 0});
  }
  forget(sessionId) { this.sessions.delete(sessionId); }
  tick(at = this.now()) {
    if (this.stopped) return Promise.resolve([]);
    if (this.tickPromise) return this.tickPromise;
    const work = (async () => {
      const outcomes = [];
      for (const [sessionId, state] of this.sessions) {
        if (this.stopped) break;
        if (at - state.lastAttempt < HEARTBEAT_MS) continue;
        let live = false;
        try { live = await this.isLive(sessionId); } catch { /* Missing proof of liveness stops renewal. */ }
        if (this.stopped || !this.sessions.has(sessionId)) continue;
        if (!live) { this.sessions.delete(sessionId); continue; }
        state.lastAttempt = at;
        state.heartbeats += 1;
        if (state.heartbeats % 5 === 0) {
          try {
            await this.refreshOrg({data: this.data, sessionId, policy: state.policy, now: at, getPolicy: this.getPolicy});
            await this.onOrgRefresh(sessionId);
          } catch { this.onOrgFailure(sessionId, 'org_policy_unavailable'); }
        }
        try {
          const value = await this.heartbeat({data: this.data, sessionId, policy: state.policy,
            postJson: this.postJson, now: at, orgPolicySha256: this.orgPolicyDigest(sessionId)});
          this.onSeatRefresh(sessionId, value);
          outcomes.push({sessionId, status: value});
        } catch (error) {
          this.onSeatFailure(sessionId, error?.code === 'seat_revoked' ? 'seat_revoked' : 'seat_unavailable');
          // Heartbeat failures cannot interfere with a tool admission or with
          // other live sessions. A later interval can retry this seat.
          outcomes.push({sessionId, unavailable: true});
        }
      }
      return outcomes;
    })();
    this.tickPromise = work;
    work.finally(() => { if (this.tickPromise === work) this.tickPromise = null; }).catch(() => {});
    return work;
  }
  stop() {
    this.stopped = true;
    this.sessions.clear();
  }
}
module.exports = {SeatHeartbeatScheduler, HEARTBEAT_MS};
