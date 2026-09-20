'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {quantile, CALLS} = require('../scripts/measure-overhead.cjs');

test('overhead percentiles use nearest rank over actual wall-time samples', () => {
  assert.equal(quantile([4, 2, 1, 3], 0.5), 2);
  assert.equal(quantile([4, 2, 1, 3], 0.95), 4);
  assert.equal(CALLS.length, 6);
});

test('overhead CLI runs the real hook and writes verifiable measurement fields', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-overhead-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const output = path.join(directory, 'overhead.json');
  const child = spawnSync(process.execPath, [path.join(__dirname, '../scripts/measure-overhead.cjs'), '--iterations', '6', '--output', output], {
    encoding: 'utf8', timeout: 20000});
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.iterations, 6); assert.equal(report.warmups_excluded, 1);
  assert.equal(typeof report.machine.model, 'string'); assert.equal(report.node_version, process.version);
  assert.ok(Number.isFinite(Date.parse(report.date)));
  assert.ok(report.p50_ms > 0); assert.ok(report.p95_ms >= report.p50_ms);
  assert.equal(report.added_tokens, 0); assert.equal(report.network_attempts, 0);
  assert.equal(report.signed_decisions, 7); assert.equal(report.fail_open, 0);
  assert.equal(report.chain_verified, true); assert.deepEqual(report.outcomes, {clean: 5, stop: 1});
  assert.match(report.samples_sha256, /^[a-f0-9]{64}$/);
  for (const file of ['hooks/spend-gate.cjs', 'runtime/guard-pack.cjs', 'runtime/engine.cjs']) {
    assert.match(report.hook_source_sha256[file], /^[a-f0-9]{64}$/);
  }
  assert.equal(report.wall_ms_samples.length, 6);
  assert.equal(quantile(report.wall_ms_samples, 0.5), report.p50_ms);
  assert.equal(quantile(report.wall_ms_samples, 0.95), report.p95_ms);
  assert.equal(JSON.parse(child.stdout).samples_sha256, report.samples_sha256);
});
