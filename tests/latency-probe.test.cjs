'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {runProbe, formatReport} = require('../scripts/probe-hooks.cjs');

test('warm hooks survive lost filesystem watcher events without extending their deadline', async () => {
  const report = await runProbe({callsPerGate: 3, diskDelayMs: 40, watchEvents: false});
  assert.equal(report.signedEntries, 8);
  assert.equal(report.signedFailOpenEvents, 0);
  assert.equal(report.chainVerified, true);
  assert.equal(report.burnChainVerified, true);
  assert.equal(report.socketAttempts, 0);
});

test('twenty warm calls per gate survive 40ms disk delays with every decision signed and no fail-open', async t => {
  const report = await runProbe({callsPerGate: 20, diskDelayMs: 40});
  for (const gate of ['spend', 'burn']) {
    assert.equal(report.gates[gate].count, 20);
    assert.equal(report.gates[gate].signedDecisions, 20);
    assert.equal(report.gates[gate].failOpen, 0);
  }
  assert.equal(report.warmupsExcluded, 2);
  assert.equal(report.signedEntries, 42);
  assert.equal(report.signedFailOpenEvents, 0);
  assert.equal(report.pendingFailOpenEvents, 0);
  assert.equal(report.chainVerified, true);
  assert.equal(report.burnReceipts, 21);
  assert.equal(report.burnChainVerified, true);
  assert.equal(report.socketAttempts, 0);
  assert.ok(report.diskOperations.fdatasync > 0);
  assert.equal(report.diskOperations['receipts.ndjson'], 21);
  assert.equal(report.diskOperations['decisions.ndjson'], 21);
  for (const line of formatReport(report).split('\n')) t.diagnostic(line);
});
