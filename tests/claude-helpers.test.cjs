'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash, generateKeyPairSync} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {LICENSE_KEY} = require('./helper-paid-license.cjs');
const sdk = require('@agentguard-run/spend');
const root = path.resolve(__dirname, '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function commandFor(file, heading, variables) {
  const section = read(file).split(`### ${heading}\n`)[1];
  assert.ok(section, `${heading} section exists`);
  const command = section.match(/```sh\n([^`]+)\n```/)[1];
  const expanded = command.replace(/\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_SESSION_ID)\}/g,
    (_, name) => variables[name]);
  assert.doesNotMatch(expanded, /\$\{/, 'the chosen Claude command has no unresolved host placeholders');
  return expanded;
}

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-claude-helpers-'));
  const plugin = path.join(temporary, 'plugin with spaces');
  const data = path.join(temporary, 'private plugin data');
  const home = path.join(temporary, 'synthetic home');
  fs.mkdirSync(plugin, {recursive: true});
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  for (const name of ['runtime', 'scripts', 'config', 'node_modules', 'package.json', 'package-lock.json']) {
    fs.cpSync(path.join(root, name), path.join(plugin, name), {recursive: true, verbatimSymlinks: true});
  }
  const variables = {CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_DATA: data, CLAUDE_SESSION_ID: 'synthetic-claude-helper-session'};
  // Model a Bash tool without plugin/Codex variables. Only the skill's exact
  // substitutions and explicit assignments can identify the runtime and data.
  const env = {PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin', HOME: home,
    AGENTGUARD_HOME: path.join(temporary, 'sdk'), AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0'};
  const preload = path.join(temporary, 'offline-preload.cjs');
  const attempts = path.join(temporary, 'network-attempts');
  const transport = path.join(temporary, 'transport-observations.json');
  const tracked = path.join(temporary, 'tracked-session.json');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const fail = () => { fs.appendFileSync(${JSON.stringify(attempts)}, 'socket attempt\\n'); throw new Error('Network disabled in helper regression.'); };
    require('node:net').Socket.prototype.connect = fail;
    require('node:dgram').createSocket = fail;
    require('node:tls').connect = fail;
    require('node:http').request = fail;
    require('node:https').request = fail;
    global.fetch = async (url, options) => {
      if (process.env.SYNTHETIC_ACTIVATION !== '1') return fail();
      const endpoint = new URL(url);
      if (endpoint.origin !== 'https://agentguard.run') return fail();
      const calls = fs.existsSync(${JSON.stringify(transport)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(transport)}, 'utf8')) : [];
      calls.push(endpoint.pathname);
      fs.writeFileSync(${JSON.stringify(transport)}, JSON.stringify(calls));
      if (endpoint.pathname === '/api/license/validate') return {ok: true, json: async () => ({valid: true, tier: 'solo', seats: 1, expiresAt: new Date(Date.now() + 86400000).toISOString(), features: {maxActiveSeats: 1}})};
      if (endpoint.pathname === '/api/license/seats') return {ok: true, json: async () => ({ok: true, activeSeats: 1, maxActiveSeats: 1, storage: 'kv'})};
      return fail();
    };
    require(${JSON.stringify(path.join(plugin, 'runtime/session-start.cjs'))}).track = async sessionId => {
      fs.writeFileSync(${JSON.stringify(tracked)}, JSON.stringify({sessionId}));
    };
  `);
  env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  const execute = (command, input, extraEnv = {}) => spawnSync('/bin/sh', ['-c', command], {
    cwd: plugin, env: {...env, ...extraEnv}, input, encoding: 'utf8', timeout: 10000});
  const node = (script, extraEnv = {}) => spawnSync(process.execPath, [path.join(plugin, script)], {
    cwd: plugin, env: {...env, ...variables, ...extraEnv}, encoding: 'utf8', timeout: 10000});
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  return {temporary, plugin, data, home, variables, env, execute, node, attempts, transport, tracked};
}

test('Claude-only provisioning survives cache dependency removal and keeps MCP on the same private data root', t => {
  const f = fixture(t);
  const result = f.node('scripts/provision-dependencies.cjs');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /durable dependencies provisioned/);
  const digest = hash(fs.readFileSync(path.join(f.plugin, 'package-lock.json')));
  assert.ok(fs.existsSync(path.join(f.data, 'dependencies', digest, 'provision.json')));
  fs.rmSync(path.join(f.plugin, 'node_modules'), {recursive: true, force: true});
  const request = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'verify_chain', arguments: {}}}) + '\n';
  const response = f.execute('node runtime/mcp.cjs', request, f.variables);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stderr, '');
  assert.equal(JSON.parse(response.stdout).result.structuredContent.ok, true);
  assert.equal(JSON.parse(response.stdout).result.structuredContent.entries, 0);
  assert.equal(fs.existsSync(path.join(f.home, '.agentguard')), false, 'no default Codex data directory');
  assert.equal(fs.existsSync(f.attempts), false, 'provisioning and verification opened no socket');
});

test('rendered Claude activation and verification commands preserve the session, policy and signed ledger without inherited host variables', async t => {
  const f = fixture(t);
  const policyFile = path.join(f.data, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({version: 1, mode: 'enforce', tenantId: 'synthetic-claude-tenant', ethicalWall: ['^synthetic_restricted_tool$']}));
  const activation = commandFor('skills/agentguard-policy/SKILL.md', 'Claude Code activation', f.variables);
  const result = f.execute(activation, LICENSE_KEY + '\n', {SYNTHETIC_ACTIVATION: '1'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const status = JSON.parse(result.stdout);
  assert.equal(status.mode, 'enforce');
  assert.equal(status.tier, 'solo');
  assert.equal(status.seatsVerified, true);
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  assert.equal(policy.licenseKey, LICENSE_KEY);
  assert.deepEqual(policy.ethicalWall, ['^synthetic_restricted_tool$']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.tracked, 'utf8')), {sessionId: f.variables.CLAUDE_SESSION_ID});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.transport, 'utf8')), ['/api/license/validate', '/api/license/seats']);
  assert.equal(result.stdout.includes(LICENSE_KEY), false);
  const statusDir = path.join(f.data, 'license-status', 'sessions');
  const statusFile = path.join(statusDir, `${hash(f.variables.CLAUDE_SESSION_ID)}-${hash(LICENSE_KEY)}.json`);
  const savedStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  assert.equal(savedStatus.paid, true);
  assert.equal(JSON.stringify(savedStatus).includes(LICENSE_KEY), false);

  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({format: 'der', type: 'pkcs8'}).subarray(-32);
  const publicKey = keys.publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
  fs.writeFileSync(path.join(f.data, 'public-key.hex'), publicKey.toString('hex'));
  const store = new sdk.NdjsonDecisionLogStore('ledger', {home: f.data, publicKeyHex: publicKey.toString('hex')});
  const decision = {decisionId: 'synthetic-claude-helper-decision', timestamp: new Date().toISOString(), action: 'allow',
    triggeredCap: null, triggeredScopeKey: null, projectedCents: 0, windowSpendBefore: 0, windowSpendAfter: 0,
    provider: 'synthetic', modelRequested: 'get_document', modelResolved: 'get_document', policyId: 'synthetic', policyVersion: 1,
    enforcementMode: 'enforce', reasons: [], actor: {sessionId: f.variables.CLAUDE_SESSION_ID},
    plugin: {schema: 'agentguard.codex.v1', host: 'claude-code', event: 'decision', toolName: 'mcp__synthetic__get_document', sessionId: f.variables.CLAUDE_SESSION_ID}};
  await store.append(await sdk.signDecision({sequence: 0, decision, previousHash: '0'.repeat(64), privateKey, publicKey}));
  const ledgerBefore = fs.readFileSync(store.filePath);
  const verification = commandFor('skills/agentguard-verify/SKILL.md', 'Claude Code verification', f.variables);
  const checked = f.execute(verification);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stderr, '');
  assert.equal(JSON.parse(checked.stdout).ok, true);
  assert.equal(JSON.parse(checked.stdout).entries, 1);
  const exported = f.execute(verification + ' export bundle.json');
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(exported.stderr, '');
  const bundle = JSON.parse(fs.readFileSync(path.join(f.plugin, 'bundle.json'), 'utf8'));
  assert.equal(bundle.entries.length, 1);
  assert.equal((await sdk.verifyChain(bundle.entries, publicKey)).ok, true);
  assert.equal(JSON.stringify(bundle).includes(LICENSE_KEY), false);

  // A different session's known seat denial must not inherit the latest
  // decision's paid entitlement just because both sessions share a data root.
  const deniedId = 'synthetic-claude-seat-limit';
  fs.writeFileSync(path.join(statusDir, `${hash(deniedId)}-${hash(LICENSE_KEY)}.json`), JSON.stringify({...savedStatus,
    sessionFingerprint: hash(deniedId), paid: false, mode: 'shadow', reason: 'seat_limit'}));
  const deniedCommand = commandFor('skills/agentguard-verify/SKILL.md', 'Claude Code verification', {...f.variables, CLAUDE_SESSION_ID: deniedId});
  const denied = f.execute(deniedCommand + ' export denied-bundle.json');
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /seat_limit/);
  assert.equal(fs.existsSync(path.join(f.plugin, 'denied-bundle.json')), false);
  const freeVerification = f.execute(deniedCommand);
  assert.equal(freeVerification.status, 0, freeVerification.stderr);
  assert.equal(JSON.parse(freeVerification.stdout).ok, true);
  assert.deepEqual(fs.readFileSync(store.filePath), ledgerBefore);
  assert.equal(fs.existsSync(path.join(f.home, '.agentguard')), false);
  assert.equal(fs.existsSync(f.attempts), false, 'all helpers used fixture transport or offline reads');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.transport, 'utf8')), ['/api/license/validate', '/api/license/seats'], 'verification did not refresh the license');
});

test('shared skills keep exact placeholders separate and scope host-specific coverage and controls', () => {
  for (const file of ['skills/agentguard-policy/SKILL.md', 'skills/agentguard-status/SKILL.md', 'skills/agentguard-verify/SKILL.md']) {
    const text = read(file);
    assert.doesNotMatch(text, /\$\{PLUGIN_(?:ROOT|DATA):-/);
    assert.match(text, /\$\{CLAUDE_PLUGIN_DATA\}/);
  }
  assert.match(read('skills/agentguard-policy/SKILL.md'), /excludes Codex hosted tools/);
  assert.match(read('README.md'), /In Codex, disable it while retaining the hooks/);
  assert.doesNotMatch(read('README.md'), /Do not point a free session/);
});
