'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { NdjsonDecisionLogStore, SequenceConflictError, GENESIS_PREVIOUS_HASH, computeSignerFingerprint, verifyChain } = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
const sameFile = (left, right) => ['ino', 'dev', 'size', 'mtimeNs'].every(field => left[field] === right[field]);
const syncFd = fd => new Promise((resolve, reject) => fs.fdatasync(fd, error => error ? reject(error) : resolve()));

// The worker lease provides one writer. A response acknowledges a complete
// write to the OS, while an asynchronous tail confirms a conservative head.
// The SDK's signed NDJSON format stays unchanged.
class OwnedLogStore extends NdjsonDecisionLogStore {
  constructor(name, options = {}) {
    super(name, options);
    this.syncFd = options.syncFd ?? syncFd;
    this.checkpointPath = this.filePath + '.durable-head.json';
    this.failurePath = this.filePath + '.sync-error.json';
    this.syncing = null;
    this.closed = false;
  }
  async recover(publicKeyHex) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let checkpoint, failure = false, bytes = Buffer.alloc(0);
    try {
      checkpoint = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw new Error('invalid_durable_checkpoint');
    }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_durable_checkpoint'); }
    try { failure = JSON.parse(fs.readFileSync(this.failurePath, 'utf8')).reason === 'durability_sync_failed'; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_sync_failure_marker'); }
    try { bytes = fs.readFileSync(this.filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entries = [], ends = [];
    let offset = 0, incomplete = 0, missingNewline = false;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
      const line = bytes.subarray(offset, end).toString('utf8');
      if (!line.trim()) throw new Error('invalid_existing_chain');
      let entry;
      try { entry = JSON.parse(line); }
      catch {
        if (newline >= 0) throw new Error('invalid_existing_chain');
        incomplete = bytes.length - offset;
        break;
      }
      entries.push(entry); ends.push(newline < 0 ? end : end + 1);
      if (newline < 0) missingNewline = true;
      offset = newline < 0 ? end : end + 1;
    }
    if (!(await verifyChain(entries, Buffer.from(publicKeyHex, 'hex'))).ok) throw new Error('invalid_existing_chain');
    const fingerprint = computeSignerFingerprint(Buffer.from(publicKeyHex, 'hex'));
    if (checkpoint) {
      const index = checkpoint.sequence;
      if (checkpoint.version !== 1 || !Number.isSafeInteger(index) || index < -1 || index >= entries.length ||
          checkpoint.signerFingerprint !== fingerprint ||
          checkpoint.entryHash !== (index < 0 ? GENESIS_PREVIOUS_HASH : entries[index]?.entryHash) ||
          checkpoint.byteLength !== (index < 0 ? 0 : ends[index])) throw new Error('invalid_durable_checkpoint');
    }
    const confirmedBytes = checkpoint?.byteLength ?? 0;
    if (incomplete && bytes.length - incomplete < confirmedBytes) throw new Error('confirmed_ledger_tail_incomplete');
    // No modification is permitted until both the complete signed chain and
    // the checkpoint have verified. Only the final incomplete row is removed.
    const fd = fs.openSync(this.filePath, 'a+', 0o600);
    try {
      if (incomplete) fs.ftruncateSync(fd, bytes.length - incomplete);
      if (missingNewline) fs.writeSync(fd, '\n');
    } finally { fs.closeSync(fd); }
    this.initializeHead(entries, publicKeyHex, checkpoint);
    const recoveredRows = entries.length - ((checkpoint?.sequence ?? -1) + 1);
    const integrity = recoveredRows || incomplete || failure ? {
      reason: failure ? 'durability_sync_failed' : incomplete ? 'incomplete_tail_discarded' : 'unconfirmed_tail_recovered',
      confirmedSequence: checkpoint?.sequence ?? -1,
      confirmedHash: checkpoint?.entryHash ?? GENESIS_PREVIOUS_HASH,
      recoveredHeadHash: entries.at(-1)?.entryHash ?? GENESIS_PREVIOUS_HASH,
      recoveredRows,
      truncatedBytes: incomplete,
      checkpointMissing: !checkpoint,
    } : null;
    return { entries, integrity };
  }
  initializeHead(entries, publicKeyHex, checkpoint = null) {
    this.head = entries.at(-1) ?? null;
    this.publicKeyHex = publicKeyHex;
    this.fingerprint = computeSignerFingerprint(Buffer.from(publicKeyHex, 'hex'));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(this.filePath, 'a', 0o600);
    this.observed = fs.fstatSync(this.fd, { bigint: true });
    this.confirmed = checkpoint;
  }
  async append(entry) {
    if (this.closed) throw new Error('ledger_closed');
    if (entry.sequence !== (this.head?.sequence ?? -1) + 1) throw new SequenceConflictError(entry.signerFingerprint, entry.sequence);
    if (entry.signerFingerprint !== this.fingerprint || (!this.head && entry.previousHash !== GENESIS_PREVIOUS_HASH)) throw new Error('invalid_chain_genesis');
    if (this.head && (entry.previousHash !== this.head.entryHash || entry.signerFingerprint !== this.head.signerFingerprint)) throw new Error('chain_head_changed');
    this.assertUnchanged();
    const row = Buffer.from(JSON.stringify({ ...entry, publicKeyHex: this.publicKeyHex }) + '\n');
    let offset = 0;
    while (offset < row.length) {
      const written = fs.writeSync(this.fd, row, offset, row.length - offset);
      if (!written) throw new Error('partial_ledger_write');
      offset += written;
    }
    this.observed = fs.fstatSync(this.fd, { bigint: true }); this.head = entry;
  }
  assertUnchanged() {
    if (!sameFile(fs.statSync(this.filePath, { bigint: true }), this.observed) ||
        !sameFile(fs.fstatSync(this.fd, { bigint: true }), this.observed)) throw new Error('ledger_changed_outside_worker');
  }
  snapshot() {
    return {version: 1, sequence: this.head?.sequence ?? -1, entryHash: this.head?.entryHash ?? GENESIS_PREVIOUS_HASH,
      byteLength: Number(this.observed.size), signerFingerprint: this.fingerprint};
  }
  dirty() {
    return !this.confirmed || this.confirmed.sequence !== (this.head?.sequence ?? -1);
  }
  afterReply() {
    if (this.closed || this.syncing || !this.dirty()) return;
    // Deferral makes the call safe directly after the response is published.
    // All expensive flush work uses asynchronous filesystem operations.
    let succeeded = false;
    this.syncing = new Promise(resolve => setImmediate(resolve)).then(async () => {
      this.assertUnchanged();
      const snapshot = this.snapshot();
      await this.syncFd(this.fd);
      this.assertUnchanged();
      await this.writeCheckpoint(snapshot);
      this.confirmed = snapshot;
      if (this.clearFailureAt !== undefined && snapshot.sequence >= this.clearFailureAt) {
        try { await fs.promises.unlink(this.failurePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.clearFailureAt = undefined;
      }
      // A previous failure remains visible until a new worker has recorded its
      // integrity event. Successful retries in this worker do not erase it.
      succeeded = true;
      return true;
    }).catch(() => {
      try { fs.writeFileSync(this.failurePath, JSON.stringify({reason: 'durability_sync_failed'}) + '\n', {mode: 0o600}); } catch {}
      return false;
    }).finally(() => {
      this.syncing = null;
      if (succeeded && this.dirty()) this.afterReply();
    });
  }
  async writeCheckpoint(snapshot) {
    const temporary = this.checkpointPath + `.${process.pid}.tmp`;
    const file = await fs.promises.open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(snapshot) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await fs.promises.rename(temporary, this.checkpointPath);
    const directory = await fs.promises.open(path.dirname(this.checkpointPath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async flush() {
    if (this.closed) return true;
    while (this.syncing || this.dirty()) {
      this.afterReply();
      if (!(await this.syncing)) return false;
    }
    return true;
  }
  async close() {
    const flushed = await this.flush();
    this.closed = true;
    fs.closeSync(this.fd);
    return flushed;
  }
  clearRecoveredFailureAfter(sequence) { this.clearFailureAt = sequence; }
}
module.exports = { OwnedLogStore };
