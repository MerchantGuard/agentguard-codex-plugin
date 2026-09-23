'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {normalizeBudget, warmBudget, COLD_MS, MAX_WARM_MS, HOST_TIMEOUT_MS} = require('../runtime/budget.cjs');
test('warm hook budget defaults to 250 ms, floors smaller values and leaves exit margin below the host ceiling', () => {
  for (const value of [undefined, null, '40', 0, -1, NaN, Infinity, 1.5]) assert.equal(normalizeBudget(value), 250);
  // A budget below 250 ms would time out on ordinary calls and fail open, so it is floored, never honoured.
  assert.equal(normalizeBudget(400), 400); assert.equal(normalizeBudget(40), 250); assert.equal(normalizeBudget(1), 250); assert.equal(normalizeBudget(249), 250); assert.equal(normalizeBudget(250), 250);
  assert.equal(normalizeBudget(2000), 1900); assert.equal(normalizeBudget(5000), 1900);
  assert.ok(MAX_WARM_MS < HOST_TIMEOUT_MS); assert.equal(COLD_MS, 1500);
});
test('hookBudgetMs follows policy changes while malformed policy uses the safe default deadline', t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-hook-budget-'));
  const previous = process.env.AGENTGUARD_PLUGIN_POLICY; delete process.env.AGENTGUARD_PLUGIN_POLICY;
  t.after(() => {if (previous !== undefined) process.env.AGENTGUARD_PLUGIN_POLICY=previous; fs.rmSync(data,{recursive:true,force:true});});
  const file = path.join(data, 'policy.json');
  assert.equal(warmBudget(data),250);
  fs.writeFileSync(file,JSON.stringify({version:1,mode:'enforce',hookBudgetMs:450}));assert.equal(warmBudget(data),450);
  fs.writeFileSync(file,JSON.stringify({version:1,mode:'shadow',hookBudgetMs:90}));assert.equal(warmBudget(data),250);
  fs.writeFileSync(file,JSON.stringify({version:1,mode:'enforce',hookBudgetMs:1}));assert.equal(warmBudget(data),250);
  fs.writeFileSync(file,'{corrupt');assert.equal(warmBudget(data),250);
});
