'use strict';
const {LICENSE_KEY, seedPaidLicense} = require('./helper-paid-license.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {hookOutput} = require('../runtime/client.cjs');
const {allow, deny} = require('../runtime/common.cjs');
const {expectedFiles} = require('../scripts/build-compat.cjs');
const sdk = require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/spend');
const root = path.resolve(__dirname, '..');

test('legacy bare allow normalization preserves advisories, denials and supported updated input', () => {
  const portable = allow();
  assert.equal(hookOutput(portable), portable);
  assert.deepEqual(hookOutput(portable, {legacyAllow: true}), {});
  assert.equal(portable.hookSpecificOutput.permissionDecision, 'allow');
  const advisory = {...allow(), systemMessage: 'Synthetic Burn shadow warning'};
  advisory.hookSpecificOutput.additionalContext = 'Synthetic advisory context';
  assert.deepEqual(hookOutput(advisory, {legacyAllow: true}), {systemMessage: advisory.systemMessage,
    hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext: 'Synthetic advisory context'}});
  const denied = deny('synthetic_policy_block');
  assert.equal(hookOutput(denied, {legacyAllow: true}), denied);
  const updated = allow(); updated.hookSpecificOutput.updatedInput = {synthetic: true};
  assert.equal(hookOutput(updated, {legacyAllow: true}), updated);
  assert.deepEqual(hookOutput({}, {legacyAllow: true}), {});
});

test('only generated compatibility pre-tool wrappers opt into bare allow normalization', () => {
  const files = expectedFiles();
  for (const [name, gate] of [['spend-gate', 'spend'], ['burn-gate', 'burn']]) {
    const portable = fs.readFileSync(path.join(root, 'hooks', `${name}.cjs`), 'utf8');
    assert.match(portable, new RegExp(`run\\('${gate}'\\)`));
    assert.doesNotMatch(portable, /legacyAllow/);
    assert.match(files.get(`hooks/${name}.cjs`).toString(), new RegExp(`run\\('${gate}', \\{legacyAllow: true\\}\\)`));
  }
  assert.equal(files.get('hooks/receipt.cjs').toString(), fs.readFileSync(path.join(root, 'hooks/receipt.cjs'), 'utf8'));
});

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-compat-output-'));
  const legacy = path.join(temporary, 'legacy');
  const data = path.join(temporary, 'data');
  fs.mkdirSync(data, {recursive: true});
  fs.mkdirSync(path.join(legacy, 'hooks'), {recursive: true});
  fs.cpSync(path.join(root, 'runtime'), path.join(legacy, 'runtime'), {recursive: true});
  for (const [relative, bytes] of expectedFiles()) {
    if (relative.startsWith('hooks/')) fs.writeFileSync(path.join(legacy, relative), bytes);
  }
  const env = {...process.env, PLUGIN_DATA: data, AGENTGUARD_HOME: path.join(temporary, 'burn'), AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0'};
  seedPaidLicense(env.AGENTGUARD_HOME);
  delete env.NODE_PATH;
  delete env.AGENTGUARD_PLUGIN_POLICY;
  const invoke = (legacyHook, name, raw) => spawnSync(process.execPath, [path.join(legacyHook ? legacy : root, 'hooks', `${name}.cjs`)],
    {env, input: typeof raw === 'string' ? raw : JSON.stringify(raw), encoding: 'utf8', timeout: 10000});
  t.after(() => {
    spawnSync(process.execPath, [path.join(root, 'runtime/control.cjs'), 'stop'], {env, timeout: 5000});
    const tag = createHash('sha256').update(data).digest('hex').slice(0, 24);
    fs.rmSync(path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${tag}`), {recursive: true, force: true});
    fs.rmSync(temporary, {recursive: true, force: true});
  });
  const raw = id => ({hook_event_name: 'PreToolUse', session_id: 'synthetic-session', tool_use_id: id,
    tool_name: 'mcp__imanage__get_document', tool_input: {synthetic: true}});
  const rows = () => fs.readFileSync(path.join(data, 'ledger/decisions.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return {data, invoke, raw, rows};
}

test('portable and legacy subprocesses share one signed charge, retain deny and link outcomes', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.data, 'policy.json'), JSON.stringify({licenseKey: LICENSE_KEY, version: 1, tenantId: 'synthetic-compat', mode: 'enforce',
    maxCapability: 'data_write', caps: [{window: 'per_day', amountCents: 1}], toolRules: [{pattern: '.*', unitCostCents: 1}]}));
  const first = f.raw('synthetic-allowed');
  const portable = f.invoke(false, 'spend-gate', first);
  assert.equal(portable.status, 0, portable.stderr); assert.equal(portable.stderr, '');
  assert.deepEqual(JSON.parse(portable.stdout), allow());
  const legacyDuplicate = f.invoke(true, 'spend-gate', first);
  assert.equal(legacyDuplicate.status, 0, legacyDuplicate.stderr); assert.equal(legacyDuplicate.stderr, '');
  assert.deepEqual(JSON.parse(legacyDuplicate.stdout), {});
  assert.equal(f.rows().length, 1);
  const denied = f.invoke(true, 'spend-gate', f.raw('synthetic-capped'));
  assert.equal(denied.status, 0, denied.stderr); assert.equal(denied.stderr, '');
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const observation = f.invoke(true, 'burn-gate', first);
  assert.equal(observation.status, 0, observation.stderr); assert.equal(observation.stderr, '');
  assert.deepEqual(JSON.parse(observation.stdout), {});
  const outcome = f.invoke(true, 'receipt', {...first, hook_event_name: 'PostToolUse', duration_ms: 1, tool_response: {isError: false}});
  assert.equal(outcome.status, 0, outcome.stderr); assert.equal(outcome.stderr, '');
  assert.deepEqual(JSON.parse(outcome.stdout), {});
  const rows = f.rows();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.decision.action), ['allow', 'block', 'allow']);
  assert.equal(rows[0].decision.plugin.chargedCents, 1);
  assert.equal(rows[1].decision.plugin.chargedCents ?? 0, 0);
  assert.equal(rows[2].decision.originalDecisionId, rows[0].decision.decisionId);
  fs.writeFileSync(path.join(f.data, 'policy.json'), '{broken');
  for (const legacyHook of [true, false]) {
    const result = f.invoke(legacyHook, 'spend-gate', f.raw(`synthetic-policy-error-${legacyHook}`));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /fail-open event recorded/);
    assert.deepEqual(JSON.parse(result.stdout), legacyHook ? {} : allow());
  }
  assert.equal(f.rows().filter(row => row.decision.plugin.event === 'fail_open').length, 2);
  const publicKey = Buffer.from(fs.readFileSync(path.join(f.data, 'public-key.hex'), 'utf8').trim(), 'hex');
  assert.equal((await sdk.verifyChain(f.rows(), publicKey)).ok, true);
});

test('legacy and portable malformed-input fail-open responses keep their host format and queue recovery', t => {
  const f = fixture(t);
  for (const legacyHook of [true, false]) {
    const result = f.invoke(legacyHook, 'spend-gate', '{SYNTHETIC_INVALID_INPUT');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /internal error; allowed tool call; audit recovery queued/);
    assert.deepEqual(JSON.parse(result.stdout), legacyHook ? {} : allow());
  }
  const text = fs.readFileSync(path.join(f.data, 'fail-open-pending.ndjson'), 'utf8');
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.event === 'fail_open' && event.reasonCode === 'hook_internal_error'));
  assert.equal(text.includes('SYNTHETIC_INVALID_INPUT'), false);
});
