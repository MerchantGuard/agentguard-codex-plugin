'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tips = require('../runtime/session-tip.cjs');
test('a verified tally appears once even when the last session has no coaching tip', t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tally-tip-')), home = path.join(data, 'burn');
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  const transcriptPath = path.join(data, 's.jsonl'); fs.writeFileSync(transcriptPath, '');
  tips.ended({data, home, sessionId: 's1', transcriptPath, now: 1, spawnImpl: () => ({on() {}, unref() {}})});
  tips.compute({data, home, sessionId: 's1', endedAt: 1, transcriptPath, sessionTip: () => null, tallyLine: '4 launches · 3 allowed · 1 refused', now: 2});
  assert.equal(tips.take({data, home, sessionId: 's2', now: 3}), 'AgentGuard tip from your last session: 4 launches · 3 allowed · 1 refused');
  assert.equal(tips.take({data, home, sessionId: 's3', now: 4}), null);
});
test('a receipt ledger allows a tally tip even when the host omits the transcript path', async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tally-no-transcript-')), home = path.join(data, 'burn');
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));
  fs.mkdirSync(path.join(data, 'ledger')); fs.writeFileSync(path.join(data, 'ledger', 'decisions.ndjson'), '');
  tips.ended({data, home, sessionId: 's1', now: 1, spawnImpl: () => ({on() {}, unref() {}})});
  await tips.computeWithTally({data, home, sessionId: 's1', endedAt: 1, now: 2, burn: {
    sessionTally: async (session, options) => {assert.equal(session, 's1'); assert.equal(options.data, data); return {status: 'verification_failed'};},
    renderSessionTally: () => 'Receipt signature or hash chain verification failed.'
  }});
  assert.equal(tips.take({data, home, sessionId: 's2', now: 3}), 'AgentGuard tip from your last session: Receipt signature or hash chain verification failed.');
});
