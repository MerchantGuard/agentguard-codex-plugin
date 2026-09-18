'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { NdjsonDecisionLogStore, SequenceConflictError, GENESIS_PREVIOUS_HASH, computeSignerFingerprint } = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');

// The private worker lease gives this adapter one writer. Read APIs and the
// physical format remain the SDK's NDJSON store. Its default append re-reads
// the entire log for duplicates; the verified startup head is our index instead.
class OwnedLogStore extends NdjsonDecisionLogStore {
  initializeHead(entries, publicKeyHex) {
    this.head = entries.at(-1) ?? null;
    this.publicKeyHex = publicKeyHex;
    this.fingerprint = computeSignerFingerprint(Buffer.from(publicKeyHex, 'hex'));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.filePath, 'a', 0o600);
    fs.closeSync(fd);
    this.observed = fs.statSync(this.filePath, { bigint: true });
  }
  async append(entry) {
    if (entry.sequence !== (this.head?.sequence ?? -1) + 1) throw new SequenceConflictError(entry.signerFingerprint, entry.sequence);
    if (entry.signerFingerprint !== this.fingerprint || (!this.head && entry.previousHash !== GENESIS_PREVIOUS_HASH)) throw new Error('invalid_chain_genesis');
    if (this.head && (entry.previousHash !== this.head.entryHash || entry.signerFingerprint !== this.head.signerFingerprint)) throw new Error('chain_head_changed');
    const stat = fs.statSync(this.filePath, { bigint: true });
    if (['ino', 'dev', 'size', 'mtimeNs'].some(field => stat[field] !== this.observed[field])) throw new Error('ledger_changed_outside_worker');
    const fd = fs.openSync(this.filePath, 'a');
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (['ino', 'dev', 'size', 'mtimeNs'].some(field => opened[field] !== stat[field])) throw new Error('ledger_changed_outside_worker');
      const row = Buffer.from(JSON.stringify({ ...entry, publicKeyHex: this.publicKeyHex }) + '\n');
      if (fs.writeSync(fd, row) !== row.length) throw new Error('partial_ledger_write');
      fs.fdatasyncSync(fd);
      this.observed = fs.fstatSync(fd, { bigint: true }); this.head = entry;
    } finally { fs.closeSync(fd); }
  }
}
module.exports = { OwnedLogStore };
