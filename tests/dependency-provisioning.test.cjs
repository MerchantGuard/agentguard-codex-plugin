'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '..');
const inputSentinel = 'SYNTHETIC_DEPENDENCY_INPUT_MUST_NOT_APPEAR';
const outputSentinel = 'SYNTHETIC_DEPENDENCY_OUTPUT_MUST_NOT_APPEAR';
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-dependency-test-'));
  const root = path.join(temporary, 'plugins', 'cache', 'synthetic-market', 'agentguard', '0.1.0');
  const data = path.join(temporary, 'plugins', 'data', 'agentguard-synthetic-market');
  fs.mkdirSync(root, { recursive: true });
  for (const name of ['runtime', 'hooks', 'config', 'scripts', 'node_modules', 'package.json', 'package-lock.json']) {
    fs.cpSync(path.join(sourceRoot, name), path.join(root, name), { recursive: true, verbatimSymlinks: true });
  }
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({ version: 1, tenantId: 'synthetic-provisioning', mode: 'enforce', maxCapability: 'data_write', ethicalWall: ['^mcp__imanage__save_document$'], caps: [], toolRules: [], sessions: {} }));
  const env = { ...process.env, PLUGIN_DATA: data, AGENTGUARD_HOME: path.join(temporary, 'burn'), AGENTGUARD_LICENSE_KEY: '', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0' };
  delete env.NODE_PATH;
  delete env.AGENTGUARD_PLUGIN_POLICY;
  const execute = (script, input, extraEnv = {}) => spawnSync(process.execPath, [path.join(root, script)], { cwd: root, env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout: 10000 });
  const runNode = script => spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  const rows = () => fs.readFileSync(path.join(data, 'ledger', 'decisions.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const raw = (tool, id) => ({ hook_event_name: 'PreToolUse', session_id: 'synthetic-session', tool_use_id: id, tool_name: tool, tool_input: { content: inputSentinel } });
  const provision = () => {
    const withoutOverride = { ...env }; delete withoutOverride.PLUGIN_DATA;
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'provision-dependencies.cjs')], { cwd: root, env: withoutOverride, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const stop = () => {
    const result = spawnSync(process.execPath, [path.join(root, 'runtime', 'control.cjs'), 'stop'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  };
  t.after(() => {
    spawnSync(process.execPath, [path.join(root, 'runtime', 'control.cjs'), 'stop'], { env, timeout: 5000 });
    const tag = createHash('sha256').update(data).digest('hex').slice(0, 24);
    fs.rmSync(path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${tag}`), { recursive: true, force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  return { root, data, env, execute, runNode, rows, raw, provision, stop };
}

test('explicit provisioning keeps locked dependencies and signed hooks working after Codex replaces the cache', t => {
  const f = fixture(t);
  f.provision();
  const digest = createHash('sha256').update(fs.readFileSync(path.join(f.root, 'package-lock.json'))).digest('hex');
  const durable = path.join(f.data, 'dependencies', digest);
  assert.equal(fs.existsSync(path.join(durable, 'provision.json')), true);
  assert.equal(fs.readFileSync(path.join(durable, 'package-lock.json'), 'utf8'), fs.readFileSync(path.join(f.root, 'package-lock.json'), 'utf8'));
  fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true, force: true });
  const denied = f.execute('hooks/spend-gate.cjs', JSON.stringify(f.raw('mcp__imanage__save_document', 'synthetic-denied')));
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(denied.stderr, '');
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  // This regression checks dependency/cache survival and signed persistence.
  // Restart between semantic calls so each independently reloads the durable
  // SDK and ledger; the separate warm-hook tests cover the tight IPC deadline.
  f.stop();
  const raw = f.raw('mcp__imanage__get_document', 'synthetic-allowed');
  const allowed = f.execute('hooks/spend-gate.cjs', JSON.stringify(raw));
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stderr, '');
  assert.equal(JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision, 'allow');
  f.stop();
  const outcome = f.execute('hooks/receipt.cjs', JSON.stringify({ ...raw, hook_event_name: 'PostToolUse', tool_response: { text: outputSentinel, isError: false } }));
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(outcome.stderr, '');
  assert.deepEqual(JSON.parse(outcome.stdout), {});
  const rows = f.rows();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.decision.action), ['block', 'allow', 'allow']);
  assert.equal(rows[2].decision.originalDecisionId, rows[1].decision.decisionId);
  assert.equal(JSON.stringify(rows).includes(inputSentinel), false);
  assert.equal(JSON.stringify(rows).includes(outputSentinel), false);
  const mcp = f.execute('runtime/mcp-legacy.cjs', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'verify_chain', arguments: {} } }) + '\n');
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(mcp.stderr, '');
  const messages = mcp.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages[0].result.serverInfo.name, 'agentguard');
  assert.equal(messages[1].result.structuredContent.ok, true);
  assert.equal(messages[1].result.structuredContent.entries, 3);
});

test('missing durable dependencies fail open with an unsigned recovery record and no dependency directory', t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true, force: true });
  const result = f.execute('hooks/spend-gate.cjs', JSON.stringify(f.raw('mcp__imanage__save_document', 'synthetic-missing')));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'allow');
  assert.match(result.stderr, /internal error; allowed tool call/i);
  assert.equal(result.stderr.includes(inputSentinel), false);
  const pending = fs.readFileSync(path.join(f.data, 'fail-open-pending.ndjson'), 'utf8');
  assert.equal(JSON.parse(pending.trim()).event, 'fail_open');
  assert.equal(pending.includes(inputSentinel), false);
  assert.equal(fs.existsSync(path.join(f.data, 'dependencies')), false);
  assert.equal(fs.existsSync(path.join(f.data, 'ledger', 'decisions.ndjson')), false);
});

test('a changed lockfile refuses a previously provisioned dependency set and fails open', t => {
  const f = fixture(t);
  f.provision();
  fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true, force: true });
  fs.appendFileSync(path.join(f.root, 'package-lock.json'), '\n');
  const probe = f.runNode("try { require('./runtime/dependencies.cjs').loadDependency('@agentguard-run/spend'); process.exitCode = 10; } catch { process.stdout.write('stale dependency set rejected\\n'); }");
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, 'stale dependency set rejected\n');
  const result = f.execute('hooks/spend-gate.cjs', JSON.stringify(f.raw('mcp__imanage__save_document', 'synthetic-stale')));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'allow');
  assert.match(result.stderr, /internal error; allowed tool call/i);
  assert.equal(fs.existsSync(path.join(f.data, 'ledger', 'decisions.ndjson')), false);
});

test('a durable dependency version that disagrees with the lockfile is rejected', t => {
  const f = fixture(t);
  f.provision();
  const digest = createHash('sha256').update(fs.readFileSync(path.join(f.root, 'package-lock.json'))).digest('hex');
  const manifestPath = path.join(f.data, 'dependencies', digest, 'node_modules', '@agentguard-run', 'spend', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = '999.0.0';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true, force: true });
  const result = f.runNode("try { require('./runtime/dependencies.cjs').loadDependency('@agentguard-run/spend'); process.exitCode = 10; } catch { process.stdout.write('mismatched dependency version rejected\\n'); }");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'mismatched dependency version rejected\n');
});

test('MCP rejects an incomplete durable snapshot without recreating its readiness marker', t => {
  const f = fixture(t);
  f.provision();
  const digest = createHash('sha256').update(fs.readFileSync(path.join(f.root, 'package-lock.json'))).digest('hex');
  const durable = path.join(f.data, 'dependencies', digest);
  fs.unlinkSync(path.join(durable, 'provision.json'));
  fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true, force: true });
  const before = fs.readdirSync(durable).sort();
  const result = f.execute('runtime/mcp-legacy.cjs', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(fs.readdirSync(durable).sort(), before);
  assert.equal(fs.existsSync(path.join(durable, 'provision.json')), false);
  assert.equal(fs.existsSync(path.join(f.data, 'ledger', 'decisions.ndjson')), false);
});
