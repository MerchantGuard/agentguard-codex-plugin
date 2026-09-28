'use strict';
// A Burn policy file that exists but that Burn ignores (bad JSON, no "mode", no
// "thresholds") leaves Burn's defaults, which only watch, so enforcement is off.
// With Burn 0.3.21 SessionStart shows Burn's own line about it first, even with
// quiet on, and holds the first-run line unclaimed. With Burn 0.3.20, which the
// lockfile installs until 0.3.21 is published, there is no check and nothing
// changes. Temporary directories only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixture} = require('./helper-session-start.cjs');
const moments = require('../runtime/upgrade-moments.cjs');
const burn = require('@agentguard-run/burn');
const hasCheck = typeof burn.checkPolicyFile === 'function';
const TIP = "Next: sub-agents used 48.9% of this session's tokens. Give related work to one sub-agent instead of several.";
const TIP_LINE = "AgentGuard tip from your last session: sub-agents used 48.9% of this session's tokens. Give related work to one sub-agent instead of several.";

test('Burn 0.3.21 and later give the plugin checkPolicyFile; 0.3.20 does not', () => {
  const [major, minor, patch] = require('@agentguard-run/burn/package.json').version.split('.').map(Number);
  assert.equal(hasCheck, major > 0 || minor > 3 || patch >= 21);
});

const put = (f, text) => { fs.mkdirSync(f.agentguard, {recursive: true}); fs.writeFileSync(path.join(f.agentguard, 'burn-policy.json'), text); };
const firstRunUsed = f => fs.existsSync(path.join(f.agentguard, 'upgrade-moments', 'first-run'));

test('bad JSON, a missing mode and missing thresholds: Burn\'s line comes first and the first-run line waits; a valid partial file shows nothing', t => {
  const f = fixture(t, {fresh: true});
  const cases = [
    ['{"mode": "enforce", "thresholds": {', 'it is not valid JSON. Using the defaults, which only watch. Fix the JSON to turn limits back on.'],
    [JSON.stringify({thresholds: {spawnRate: {stop: 20}}}), 'it has no "mode". Using the defaults, which only watch. Add "mode": "enforce" to turn limits back on.'],
    [JSON.stringify({mode: 'enforce'}), 'it has no "thresholds". Using the defaults, which only watch. Add "thresholds": {} to turn limits back on.'],
  ];
  for (const [text, reason] of cases) {
    put(f, text);
    const lines = (f.start('session-a').systemMessage ?? '').split('\n');
    if (hasCheck) assert.equal(lines[0], `AgentGuard ignored ~/.agentguard/burn-policy.json: ${reason}`, text);
    else assert.ok(!lines.some(line => line.startsWith('AgentGuard ignored')), text);
    assert.ok(!lines.some(line => line.startsWith('AgentGuard is on')), 'limits are not on, so the first-run line waits');
    assert.equal(firstRunUsed(f), false, 'and is not used up');
  }
  // Mode plus some thresholds loads: no line, and the first-run line shows at last.
  put(f, JSON.stringify({mode: 'enforce', thresholds: {spawnRate: {stop: 20}}}));
  const lines = f.start('session-b').systemMessage.split('\n');
  assert.match(lines[0], /^AgentGuard is on\. /);
  assert.ok(!lines.some(line => line.startsWith('AgentGuard ignored')));
  assert.equal(firstRunUsed(f), true);
});

test('the line shows even with quiet on, every session until the file is fixed, and comes ahead of the tip', t => {
  const f = fixture(t);
  put(f, JSON.stringify({thresholds: {}}));
  const line = 'AgentGuard ignored ~/.agentguard/burn-policy.json: it has no "mode". Using the defaults, which only watch. Add "mode": "enforce" to turn limits back on.';
  moments.dismiss(f.agentguard);
  assert.deepEqual(f.start('session-a'), hasCheck ? {systemMessage: line} : {}, 'quiet hides tips, not errors');
  assert.deepEqual(f.start('session-b'), hasCheck ? {systemMessage: line} : {});
  fs.rmSync(path.join(f.agentguard, 'upgrade-moments', 'quiet'));
  f.stored('session-b', TIP);
  assert.deepEqual(f.start('session-c'), {systemMessage: hasCheck ? `${line}\n${TIP_LINE}` : TIP_LINE});
  put(f, JSON.stringify({mode: 'enforce', thresholds: {}}));
  assert.deepEqual(f.start('session-d'), {});
});
