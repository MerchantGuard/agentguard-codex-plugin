'use strict';

// Operational counters contain request identifiers and reason codes only.
// They are unsigned observations, separate from the signed audit chain.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const HOUR_MS = 60 * 60 * 1000;
const MAX_RECORDS = 100000;
const MAX_BYTES = 32 * 1024 * 1024;
const GATES = new Set(['burn', 'spend', 'receipt']);
const CAUSES = new Set(['worker_timeout', 'worker_request', 'worker_response', 'worker_start', 'worker_unavailable', 'policy_or_runtime_error', 'hook_internal_error', 'invalid_payload', 'ipc_error', 'ipc_directory_not_private', 'ipc_file_not_private', 'storage_unavailable', 'burn_runtime_error', 'unknown']);
const cleanCause = value => CAUSES.has(value) ? value : 'unknown';
function empty() { return {failOpenCount: 0, total: 0, causeCounts: {}}; }
function metric(value = empty()) {
  const rate = value.total ? value.failOpenCount / value.total : 0;
  return {...value, causeCounts: {...value.causeCounts}, rate, ratePercent: rate * 100};
}
function validCount(value) { return Number.isSafeInteger(value) && value >= 0; }
function readObject(filename) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return null;
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch { return null; }
}
function restoreMetric(value) {
  if (!value || !validCount(value.total) || !validCount(value.failOpenCount) || value.failOpenCount > value.total) return empty();
  const result = {total: value.total, failOpenCount: value.failOpenCount, causeCounts: {}};
  for (const [cause, count] of Object.entries(value.causeCounts || {})) if (CAUSES.has(cause) && validCount(count)) result.causeCounts[cause] = count;
  return result;
}
function requestIdentity(meta) {
  // Legacy records have no requestId. The composite also includes invocation
  // start time so two invocations of the same tool use remain separate calls.
  const source = typeof meta.requestId === 'string' ? meta.requestId
    : JSON.stringify([meta.gate, meta.sessionId, meta.toolUseId, meta.startedAt]);
  return createHash('sha256').update(source).digest('hex');
}
function causeChange(counts, before, after) {
  if (before) { counts[before] = Math.max(0, (counts[before] || 0) - 1); if (!counts[before]) delete counts[before]; }
  if (after) counts[after] = (counts[after] || 0) + 1;
}
function warning(report) {
  const recent = report?.lastHour?.rate > 0.05;
  const value = recent ? report.lastHour : report?.sinceStart;
  if (!value || value.rate <= 0.05) return null;
  const window = recent ? 'in the last hour' : 'since worker start';
  const cause = Object.entries(value.causeCounts || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return `agentguard: fail-open rate ${value.ratePercent.toFixed(1)}% ${window} (${value.failOpenCount}/${value.total} gate calls); cause: ${cleanCause(cause)}.`;
}

class HealthTracker {
  constructor({data, now = Date.now, maxRecords = MAX_RECORDS, startNewWorker = true} = {}) {
    if (!data) throw new Error('Health data directory is required.');
    this.data = data; this.filename = path.join(data, 'health.json'); this.now = now;
    this.maxRecords = Math.max(1, Math.min(MAX_RECORDS, maxRecords));
    this.records = new Map(); this.revision = 0; this.persistedRevision = -1;
    const previous = readObject(this.filename);
    this.validSnapshot = previous?.version === 1 && typeof previous.workerId === 'string' && Number.isFinite(previous.workerStartedAt);
    this.workerStartedAt = startNewWorker ? now() : this.validSnapshot ? previous.workerStartedAt : null;
    this.workerId = startNewWorker ? randomUUID() : this.validSnapshot ? previous.workerId : null;
    this.updatedAt = this.validSnapshot ? previous.updatedAt : 0;
    this.since = startNewWorker || !this.validSnapshot ? {gates: empty(), receipts: empty()}
      : {gates: restoreMetric(previous.since?.gates), receipts: restoreMetric(previous.since?.receipts)};
    this.truncated = Boolean(previous?.truncated);
    if (this.validSnapshot && Array.isArray(previous.records)) for (const record of previous.records.slice(-MAX_RECORDS)) {
      if (record && /^[a-f0-9]{64}$/.test(record.id) && GATES.has(record.gate) && Number.isFinite(record.at) && typeof record.failOpen === 'boolean') {
        this.records.set(record.id, {id: record.id, gate: record.gate, at: record.at, failOpen: record.failOpen, cause: record.failOpen ? cleanCause(record.cause) : null, workerId: typeof record.workerId === 'string' ? record.workerId : null, pending: Boolean(record.pending)});
      }
    }
    this.prune();
  }
  prune() {
    const threshold = this.now() - HOUR_MS;
    for (const [id, record] of this.records) if (record.at <= threshold) this.records.delete(id);
    while (this.records.size > this.maxRecords) { this.records.delete(this.records.keys().next().value); this.truncated = true; }
  }
  record(meta = {}) {
    if (!GATES.has(meta.gate)) return this.snapshot();
    const at = typeof meta.startedAt === 'number' ? meta.startedAt : Date.parse(meta.startedAt || '');
    if (!Number.isFinite(at) || at > this.now() + 1000) return this.snapshot();
    const id = meta.id && /^[a-f0-9]{64}$/.test(meta.id) ? meta.id : requestIdentity(meta);
    const previous = this.records.get(id);
    if (!previous && at <= this.now() - HOUR_MS && ['pending', 'ledger'].includes(meta.source)) return this.snapshot();
    const failed = Boolean(previous?.failOpen || meta.failOpen);
    const incomingCause = cleanCause(meta.cause || meta.reasonCode);
    const cause = !failed ? null : previous?.failOpen && incomingCause === 'unknown' ? previous.cause : incomingCause;
    const workerId = previous?.workerId ?? (['pending', 'ledger'].includes(meta.source) && at < this.workerStartedAt ? null : this.workerId);
    const record = {id, gate: meta.gate, at: previous?.at ?? at, failOpen: failed, cause, workerId, pending: Boolean(previous?.pending || meta.source === 'pending')};
    if (record.workerId && record.workerId === this.workerId) {
      const total = record.gate === 'receipt' ? this.since.receipts : this.since.gates;
      if (!previous || previous.workerId !== this.workerId) { total.total += 1; if (failed) { total.failOpenCount += 1; causeChange(total.causeCounts, null, cause); } }
      else if (!previous.failOpen && failed) { total.failOpenCount += 1; causeChange(total.causeCounts, null, cause); }
      else if (failed && previous.cause !== cause) causeChange(total.causeCounts, previous.cause, cause);
    }
    // An old timeout queue can be recovered after more than an hour. It belongs
    // to the audit chain but not this rolling operational measurement.
    if (record.at > this.now() - HOUR_MS) this.records.set(id, record);
    this.updatedAt = this.now(); this.revision += 1; this.prune();
    return this.snapshot();
  }
  recordPending() {
    for (const record of this.records.values()) if (record.pending) { record.pending = false; this.revision += 1; }
    for (const suffix of ['', '.recovering']) {
      const filename = path.join(this.data, `fail-open-pending.ndjson${suffix}`);
      try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) continue;
        const lines = fs.readFileSync(filename, 'utf8').split('\n').filter(Boolean);
        for (const line of lines.slice(-MAX_RECORDS)) {
          let meta; try { meta = JSON.parse(line); } catch { continue; }
          this.record({...meta, failOpen: true, cause: meta.reasonCode, source: 'pending'});
        }
      } catch { /* A missing or unreadable recovery queue is not a zero claim. */ }
    }
    return this.snapshot();
  }
  snapshot() {
    this.prune();
    const gates = empty(), receipts = empty(); let pending = 0;
    for (const record of this.records.values()) {
      const total = record.gate === 'receipt' ? receipts : gates;
      total.total += 1;
      if (record.failOpen) { total.failOpenCount += 1; causeChange(total.causeCounts, null, record.cause); }
      if (record.pending) pending += 1;
    }
    const result = {workerStartedAt: this.workerStartedAt === null ? null : new Date(this.workerStartedAt).toISOString(), denominator: 'PreToolUse gate hook invocations, including pass-through calls', lastHour: metric(gates), sinceStart: this.workerStartedAt === null ? null : metric(this.since.gates), postToolUse: {lastHour: metric(receipts), sinceStart: this.workerStartedAt === null ? null : metric(this.since.receipts)}, pendingObservations: pending, observationsSigned: false, truncated: this.truncated};
    result.warning = warning(result);
    return result;
  }
  persist() {
    if (this.persisting) return this.persisting;
    this.persisting = (async () => {
      await fs.promises.mkdir(this.data, {recursive: true, mode: 0o700});
      while (this.persistedRevision !== this.revision) {
        const revision = this.revision;
        const serialized = JSON.stringify({version: 1, workerId: this.workerId, workerStartedAt: this.workerStartedAt, updatedAt: this.updatedAt, since: this.since, records: [...this.records.values()], truncated: this.truncated});
        const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.promises.writeFile(temporary, serialized + '\n', {flag: 'wx', mode: 0o600});
          await fs.promises.rename(temporary, this.filename);
          this.persistedRevision = revision;
        } finally { await fs.promises.unlink(temporary).catch(() => {}); }
      }
    })().finally(() => { this.persisting = null; });
    return this.persisting;
  }
}

function readHealth({data, entries = [], now = Date.now} = {}) {
  const tracker = new HealthTracker({data, now, startNewWorker: false});
  for (const entry of entries) {
    const decision = entry?.decision || {}, meta = decision.plugin || decision.outcomeReceipt?.plugin;
    if (!meta || meta.event === 'integrity' || !GATES.has(meta.gate)) continue;
    const startedAt = meta.startedAt || decision.timestamp;
    const at = Date.parse(startedAt || '');
    if (!Number.isFinite(at) || at <= now() - HOUR_MS) continue;
    const id = requestIdentity({...meta, startedAt});
    const existing = tracker.records.has(id);
    // New rows can repair a snapshot interrupted after ledger append. Legacy
    // rows lack invocation IDs and cannot augment a worker denominator safely.
    if (tracker.validSnapshot && !existing && (!meta.requestId || tracker.truncated)) continue;
    tracker.record({...meta, startedAt, id, failOpen: ['fail_open', 'fail-open'].includes(meta.event), cause: meta.reasonCode, source: 'ledger'});
  }
  tracker.recordPending();
  return {...tracker.snapshot(), source: tracker.validSnapshot ? 'worker_snapshot' : 'ledger_fallback', denominatorComplete: tracker.validSnapshot && !tracker.truncated};
}
module.exports = {HealthTracker, readHealth, warning, requestIdentity, HOUR_MS};
