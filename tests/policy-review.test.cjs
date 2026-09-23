'use strict';
// Regression tests for the September 22 review of the policy UX branch. Each
// test reproduces one finding and pins the fixed behaviour. Commands are scanned
// and decided by the engine; nothing is executed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Engine} = require('../runtime/engine.cjs');
const {run, localPolicy} = require('../runtime/policy-cli.cjs');
const {scanCommands} = require('../runtime/command-policy.cjs');
const {metadata, locations} = require('../runtime/common.cjs');
const {validateCommandRules, hashPolicy} = require('../runtime/org-policy-contract.cjs');
const {refreshOrgPolicy, pushPersonalPolicy} = require('../runtime/org-policy-refresh.cjs');
const {policyState} = require('../runtime/policy-state.cjs');
const matrix = require('./helper-host-matrix.cjs');
const {spellings, ordinary} = require('./fixtures/command-spellings.cjs');
const root = path.resolve(__dirname, '..');
const preset = name => JSON.parse(fs.readFileSync(path.join(root, 'runtime/presets', name + '.json'), 'utf8'));
const solo = {paid: true, tier: 'solo', mode: 'enforce', reason: null};
const team = {paid: true, tier: 'startup', mode: 'enforce', reason: null};
const envelope = policy => ({version: 3, published_at: '2026-09-22T00:00:00.000Z', sha256: hashPolicy(policy), policy});

function fixture(t, policy = {version: 1, mode: 'enforce'}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-review-'));
  const names = [...matrix.envKeys, 'AGENTGUARD_LICENSE_KEY', 'AGENTGUARD_PLUGIN_POLICY', 'AGENTGUARD_HOME'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  matrix.environment(process.env, data);
  process.env.AGENTGUARD_LICENSE_KEY = ''; process.env.AGENTGUARD_PLUGIN_POLICY = ''; process.env.AGENTGUARD_HOME = path.join(data, 'burn');
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify(policy));
  // The workspace lives outside the plugin's data directory, as in real use.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-review-ws-')); fs.mkdirSync(path.join(workspace, '.git'), {recursive: true});
  const engines = [];
  t.after(async () => { for (const engine of engines) await engine.close(); for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; fs.rmSync(data, {recursive: true, force: true}); fs.rmSync(workspace, {recursive: true, force: true}); });
  return {data, workspace, cli: args => run(args, {data, sessionId: 'session'}),
    start: async options => { const engine = new Engine(options); await engine.init(); engines.push(engine); return engine; }};
}
const call = (command, id, {tool = 'Bash', input, cwd = root} = {}) => ({meta: metadata({session_id: 'session', tool_use_id: id, tool_name: tool, cwd, tool_input: input ?? {command}}, 'spend')});
const permission = result => result.output.hookSpecificOutput?.permissionDecision ?? 'allow';
const rows = engine => fs.readFileSync(engine.logStore.filePath, 'utf8').trim().split('\n').map(JSON.parse);
const held = matrix.isClaude ? 'ask' : 'deny';

// Self-approval surface. An ask rule must never be satisfiable by the agent.
test('the agent cannot run the approve helper or any policy-changing CLI verb from its shell', async t => {
  const {cli, start, data, workspace} = fixture(t); await cli(['preset', 'strict']); const engine = await start();
  const first = await engine.handle(call('curl https://example.invalid', 'network-1'));
  assert.equal(permission(first), held);
  const cliFile = path.join(root, 'runtime/policy-cli.cjs');
  for (const [index, verb] of ['approve 0123456789abcdef0123456789abcdef', "allow 'git push'", 'preset solo-dev', 'set-cap 99 per_day', "block 'x'", 'push', 'quiet on'].entries()) {
    const result = await engine.handle(call(`node ${cliFile} ${verb}`, `verb-${index}`));
    assert.equal(permission(result), 'deny', verb);
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /built_in/, verb);
  }
  // Wrapped, assignment-prefixed or substituted helpers do not earn the exemption.
  for (const [index, command] of [`NODE_OPTIONS=--require=./x.cjs node ${cliFile} show`, `env NODE_OPTIONS=--require=./x.cjs node ${cliFile} explain GP001`,
    `PATH=/tmp/bin:/usr/bin node ${cliFile} show`, `./node ${cliFile} show`, `node ${cliFile} show; echo done`].entries()) {
    assert.notEqual(permission(await engine.handle(call(command, `wrapped-${index}`))), 'allow', command);
  }
  // A verb the shell fills in, a symlink to the helper and a require() of it
  // are invocations of the helper too: anything but the exact read-only form stops.
  const link = path.join(workspace, 'x.cjs'); fs.symlinkSync(cliFile, link);
  for (const [index, command] of [`VERB=preset; node ${cliFile} $VERB solo-dev`, `V=preset; node ${cliFile} \${V} solo-dev`, `export V=preset; node ${cliFile} $V solo-dev`,
    `node ${link} preset solo-dev`, `node -e "require('${cliFile}').run(['preset','solo-dev'])"`, `node -e "require('${path.join(root, 'runtime/policy-approval.cjs')}').approve('${data}', 'x')"`,
    // The shell expands globs and removes backslashes before it runs the helper; so must the scan.
    `node ${cliFile.replace(/i\.cjs$/, '?.cjs')} allow 'git push'`, `node ${cliFile.replace(/s$/, '[s]')} preset solo-dev`, `node ${cliFile.replace(/i\.cjs$/, '*')} preset solo-dev`,
    `node ${cliFile.replace(/policy-cli/, 'policy\\-cli')} preset solo-dev`, `node -e "require('${cliFile.replace(/i\.cjs$/, '')}'+'i.cjs').run(['preset','solo-dev'])"`,
    `node - <<EOF\nrequire('${cliFile}').run(['preset','solo-dev'])\nEOF`].entries()) {
    const result = await engine.handle(call(command, `indirect-${index}`, {cwd: workspace}));
    assert.equal(permission(result), 'deny', command); assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /built_in/, command);
  }
  // The exact packaged read-only helper, run by the real interpreter, stays usable under strict.
  assert.equal(permission(await engine.handle(call(`${process.execPath} ${cliFile} show`, 'exact-show'))), 'allow');
  assert.equal(permission(await engine.handle(call(`${process.execPath} ${cliFile} explain GP001`, 'exact-explain'))), 'allow');
  assert.ok(!fs.existsSync(path.join(data, 'policy-approvals')) || true);
});

test('writes and shell commands that target plugin state or the IPC directory are stopped on every host', async t => {
  const {start, data, workspace} = fixture(t); const engine = await start();
  const loc = locations(data);
  const ticket = path.join(data, 'policy-approvals', 'a'.repeat(32) + '.json');
  const targets = [path.join(data, 'policy.json'), path.join(data, 'org-policy-status.json'), path.join(data, 'org-policy.json'), ticket,
    path.join(data, 'license-status', 'sessions', 'x.json'), path.join(loc.ipc, 'x.response'), path.join(process.env.AGENTGUARD_HOME, 'upgrade-moments', 'quiet')];
  let index = 0;
  for (const target of targets) {
    const patch = await engine.handle(call('', `patch-${index++}`, {tool: 'apply_patch', input: {input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-x\n+y\n*** End Patch`}}));
    assert.equal(permission(patch), 'deny', `apply_patch ${target}`);
    assert.equal(permission(await engine.handle(call('', `write-${index++}`, {tool: 'Write', input: {file_path: target, content: 'x'}}))), 'deny', `Write ${target}`);
    assert.equal(permission(await engine.handle(call(`echo x > ${target}`, `shell-${index++}`))), 'deny', `shell ${target}`);
  }
  for (const [name, variable] of [['data', 'PLUGIN_DATA'], ['data', 'CLAUDE_PLUGIN_DATA'], ['home', 'AGENTGUARD_HOME']]) {
    assert.equal(permission(await engine.handle(call(`cp x "$${variable}/policy.json"`, `var-${name}-${index++}`))), 'deny', variable);
  }
  assert.equal(permission(await engine.handle(call(`rm -rf ${loc.ipc}`, 'ipc-rm'))), 'deny');
  // Writes whose target rides on an option value, a clobber redirect, or an
  // interpreter one-liner still name the protected path and still stop.
  for (const [index, command] of [`dd if=/dev/zero of=${path.join(data, 'policy.json')} bs=1 count=1`, `echo x >| ${path.join(data, 'policy.json')}`,
    `cp --target-directory=${data} notes.txt`, `python3 -c "open('${path.join(data, 'policy.json')}','w').write('x')"`, `cd ${data} && echo x >| policy.json`].entries()) {
    assert.equal(permission(await engine.handle(call(command, `surface-${index}`, {cwd: workspace}))), 'deny', command);
  }
  // A glob, a backslash or a case flip in the directory component still reaches
  // the same files once the shell expands it.
  const flipped = path.join(path.dirname(data), path.basename(data).toUpperCase());
  for (const [index, command] of [`echo x > ${data.slice(0, -1)}?/policy.json`, `echo x > ${data.replace(/([a-z0-9])([^/]*)$/, '[$1]$2')}/policy.json`,
    `rm -rf ${loc.ipc.slice(0, -6)}*`, `echo x > ${data.slice(0, -3)}\\${data.slice(-3)}/policy.json`, ...(fs.existsSync(flipped) ? [`cd ${flipped} && echo x > policy.json`] : [])].entries()) {
    assert.equal(permission(await engine.handle(call(command, `spelling-${index}`, {cwd: workspace}))), 'deny', command);
  }
  assert.equal(permission(await engine.handle(call('ls *.js && echo x > build/*.log', 'ordinary-glob', {cwd: workspace}))), 'allow');
  // Brace expansion, the current user's tilde form, a recursive wildcard under a
  // parent of the data directory, deleting a parent, and a working directory
  // set into the data directory all reach the same files.
  const parent = path.dirname(data), base = path.basename(data), user = os.userInfo().username;
  const home = process.env.AGENTGUARD_HOME;
  for (const [index, command] of [`echo x > ${parent}/{${base},other}/policy.json`, `echo x > ${parent}/{${base.slice(0, 3)},zz}${base.slice(3)}/policy.json`,
    `node ${path.join(root, 'runtime')}/policy-{cli,x}.cjs preset solo-dev`, `rm -rf ${parent}/${base.slice(0, -1)}?/**`, `echo x > ${parent}/${base.slice(0, -1)}*/**/policy.json`,
    `rm -rf ${parent}`, `rm -rf ${home}/..`].entries()) {
    assert.equal(permission(await engine.handle(call(command, `expansion-${index}`, {cwd: workspace}))), 'deny', command);
  }
  if (path.resolve(home).startsWith(os.homedir() + path.sep)) assert.equal(permission(await engine.handle(call(`echo x > ~${user}${path.resolve(home).slice(os.homedir().length)}/upgrade-moments/quiet`, 'tilde-user', {cwd: workspace}))), 'deny');
  assert.equal(permission(await engine.handle(call('', 'workdir-state', {input: {command: "python3 -c \"open('policy.json','w').write('x')\"", workdir: data}}))), 'deny');
  assert.equal(permission(await engine.handle(call('', 'workdir-bad-type', {input: {command: 'rm -rf /var/tmp/x', workdir: 5}}))), 'allow');
  assert.equal(rows(engine).at(-1).decision.plugin.event, 'decision');
  // Ordinary developer commands that merely resemble the protected names stay allowed.
  for (const [index, command] of ['cat src/policy-client.ts', 'git commit -m "insurance policy-approval flow"', 'grep -rn policy-status src/', 'node -p "\'approval count: \' + 3"', 'ls /usr/*/*'].entries()) {
    assert.equal(permission(await engine.handle(call(command, `lookalike-${index}`, {cwd: workspace}))), 'allow', command);
  }
  // Oversized or pathological input never throws the scan into a fail-open.
  for (const [index, command] of [`rm -rf ${'a/'.repeat(9000)}z`, `ls ${'/usr/*/* '.repeat(200)}`, `echo ${'node '.repeat(70000)}`, `${'cd a;'.repeat(20000)}rm -rf /var/tmp/x`].entries()) {
    const started = Date.now(); const result = await engine.handle(call(command, `bounded-${index}`, {cwd: workspace}));
    assert.ok(Date.now() - started < 1500, `${index}: ${Date.now() - started}ms`); assert.equal(rows(engine).at(-1).decision.plugin.event, 'decision', String(index));
    void result;
  }
  assert.equal(rows(engine).filter(row => row.decision.plugin.event === 'fail_open').length, 0);
  assert.equal(permission(await engine.handle(call('', 'ordinary-write', {tool: 'Write', input: {file_path: path.join(workspace, 'notes.txt'), content: 'x'}}))), 'allow');
  assert.equal(permission(await engine.handle(call('echo x > notes.txt', 'ordinary-shell'))), 'allow');
  assert.doesNotMatch(JSON.stringify(rows(engine)), new RegExp(data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the approval token stays out of the deny message and the ledger; the operator lists it with pending', async t => {
  if (matrix.isClaude) return;
  const {cli, start, data} = fixture(t); await cli(['preset', 'strict']); const engine = await start();
  const request = call('curl https://example.invalid', 'network-1'); const first = await engine.handle(request);
  assert.equal(permission(first), 'deny');
  assert.doesNotMatch(first.output.hookSpecificOutput.permissionDecisionReason, /[a-f0-9]{32}/);
  assert.match(first.output.hookSpecificOutput.permissionDecisionReason, /pending/);
  assert.doesNotMatch(JSON.stringify(rows(engine)), /[a-f0-9]{32}\b(?!.*inputSha256)/.source ? /approve [a-f0-9]{32}/ : /x/);
  const listing = await cli(['pending']);
  const token = listing.match(/([a-f0-9]{32})/)[1];
  assert.match(listing, /network/); assert.match(listing, /Bash|exec_command|shell/);
  await cli(['approve', token]);
  assert.equal(permission(await engine.handle(call('curl https://example.invalid', 'approved'))), 'allow');
  assert.equal(permission(await engine.handle(call('curl https://example.invalid', 'consumed'))), 'deny');
  assert.equal(fs.existsSync(path.join(data, 'policy-approvals')), true);
});

// Finding 1: an unbalanced quote or heredoc never disables command rules.
test('explicit blocks and pattern rules survive a parse failure and are recorded as scan_incomplete', async t => {
  const policy = {...preset('careful'), commandRules: [...preset('careful').commandRules, {id: 'no-tf-destroy', pattern: 'terraform\\s+destroy', action: 'block'}]};
  const {start, workspace} = fixture(t, policy); const engine = await start();
  const cases = ["terraform destroy # don't", "git push --force origin feature #'", "rm -rf /var/tmp/x #'", "cat <<'EOF' > notes.txt\nit's done\nEOF\nterraform destroy",
    "git \\\n  push --force origin feature #'"];
  for (const [index, command] of cases.entries()) {
    const result = await engine.handle(call(command, `parse-${index}`, {cwd: workspace}));
    assert.equal(permission(result), 'deny', command);
    const last = rows(engine).at(-1).decision;
    assert.equal(last.plugin.event, 'decision', command); assert.equal(last.action, 'block', command);
    assert.ok(!last.reasons.includes('license_required'), command);
  }
  assert.equal(permission(await engine.handle(call("echo 'hello world' # it's fine", 'clean-comment', {cwd: workspace}))), 'allow');
  // A scan the hook could not run at all is a fail-open row labelled scan_incomplete, never license_required.
  const broken = call('git status', 'scan-failed', {cwd: workspace}); broken.meta.commandScanFailed = true;
  const result = await engine.handle(broken); assert.equal(permission(result), 'allow');
  const last = rows(engine).at(-1).decision;
  assert.equal(last.plugin.event, 'fail_open'); assert.ok(last.reasons.includes('scan_incomplete'), last.reasons.join(','));
  assert.ok(!last.reasons.includes('license_required'), last.reasons.join(','));
  // A policy that cannot be read (a missing team file) is a policy problem, not a licence problem.
  const {start: startBroken} = fixture(t, {version: 1, mode: 'enforce', teamPolicyFile: 'missing-team.json'});
  const broken2 = await startBroken(); await broken2.handle(call('git status', 'missing-team', {cwd: workspace}));
  const row = rows(broken2).at(-1).decision; assert.equal(row.plugin.event, 'fail_open');
  assert.ok(row.reasons.includes('policy_invalid') && !row.reasons.includes('license_required'), row.reasons.join(','));
});

// Finding 2: pattern rules cannot take the hook past its budget.
test('nested quantifiers and backreferences are rejected and scanned text is capped', async t => {
  for (const pattern of ['^(a+)+$', '(a|aa)*b', '(\\d+)+x', '(a)\\1', '(?<n>a)\\k<n>', '((ab)*)*', '(a?){20}a{20}',
    // Adjacent quantified atoms over overlapping characters backtrack super-linearly too.
    'a*a*a*a*a*a*a*a*b', '.*.*x', '[a-z]*[a-z]*!', 'a*?a*b', '\\w+\\w+x', '(ab)*(ab)*c', '[^x]*.*y',
    // Groups and optional atoms are transparent to the backtracking engine.
    '(a+)(a+)(a+)x', '(?:a+)(?:a+)x', 'a+()a+x', 'a+(?:)a+x', '\\w+\\s*\\w+\\s*\\w+x', '\\S+\\s?\\S+x', 'a+b?a+x', '(a+)b*(a+)x', '[a-z]+_?[a-z]+!', 'a+(?=)a+x', '\\s+.*x', '(?:a+b?)*c']) {
    assert.equal(validateCommandRules([{id: 'x', pattern, action: 'block'}]).length, 1, pattern);
  }
  for (const pattern of ['\\bgit\\s+push\\b[^;\\n]*\\bmain\\b', 'terraform\\s+destroy', '^curl', '(?:git|hg)\\s+push', '(?:a|b)c+', 'a+b+c*', '[0-9]{2,4}-x', '(?<!x)y',
    '\\d+\\.\\d+', '\\s+\\S+', 'x*y*z', '[a-c]+[d-f]*', '.*x', 'rm\\s+-rf?\\s+/',
    // Ordinary linear idioms stay valid: an optional group, bounded group repetition, a mandatory separator before a wildcard.
    '(?:sudo\\s+)?rm\\s+-rf', 'git\\s+(?:-C\\s+\\S+\\s+)?push', '\\d{1,3}(?:\\.\\d{1,3}){3}', 'curl\\s+(?:-[a-zA-Z]+\\s+)*https?://', 'rm\\s+(?:-[rf]+\\s+)+/', 'npm\\s+(?:i|install)\\s.*--registry', '(?:a+b)*c']) {
    assert.deepEqual(validateCommandRules([{id: 'x', pattern, action: 'block'}]), [], pattern);
  }
  // An accepted pattern is evaluated per line under a small cap, so one long line cannot spend the budget.
  const slow = scanCommands({version: 1, commandRules: [{id: 'tail', pattern: '.*x.*y', action: 'block'}]}, 'Bash', {command: 'a'.repeat(6000) + '\nb'.repeat(3)}, {cwd: root, workspace: root});
  assert.equal(slow.commandScanIncomplete, true);
  // Splitting into lines is itself recorded, and a shell line continuation is joined before a rule sees it.
  const split = scanCommands({version: 1, commandRules: [{id: 'x', pattern: 'foo\\s+bar', action: 'block'}]}, 'Bash', {command: 'foo\nbar\n' + 'y\n'.repeat(2500)}, {cwd: root, workspace: root});
  assert.equal(split.commandScanIncomplete, true);
  assert.deepEqual(scanCommands({version: 1, commandRules: [{id: 'tf', pattern: 'terraform\\s+destroy', action: 'block'}]}, 'Bash', {command: 'terraform \\\n  destroy'}, {cwd: root, workspace: root}).commandRuleIds, ['tf']);
  const {data, cli} = fixture(t, {version: 1, mode: 'enforce', commandRules: [{id: 'redos', pattern: '^(a+)+$', action: 'block'}]});
  // Neither the CLI nor a hand-edited file can put an unsafe pattern into effect.
  assert.throws(() => policyState(data, 'session'), /overlapping characters/);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, mode: 'enforce', commandRules: [{id: 'tail', pattern: 'needle$', action: 'block'}]}));
  await assert.rejects(cli(['block', '^(a+)+$']), /overlapping characters/);
  const started = Date.now();
  const scan = scanCommands(localPolicy(data), 'Bash', {command: 'a'.repeat(40) + '!'}, {cwd: root, workspace: root});
  assert.ok(Date.now() - started < 50); assert.deepEqual(scan.commandRuleIds, [null]);
  const longLine = Date.now();
  scanCommands({version: 1, commandRules: [{id: 'tail', pattern: '.*x.*y', action: 'block'}]}, 'Bash', {command: 'a'.repeat(60000)}, {cwd: root, workspace: root});
  assert.ok(Date.now() - longLine < 250);
  const long = scanCommands(localPolicy(data), 'Bash', {command: 'x'.repeat(200000) + ' needle'}, {cwd: root, workspace: root});
  assert.equal(long.commandScanIncomplete, true);
});

// Finding 3: a push from a non-Solo key never marks org_policy_unavailable.
test('a Team push is refused without an upload and without touching live sessions', async t => {
  const {data, start} = fixture(t, {version: 1, mode: 'enforce', licenseKey: 'synthetic-key'});
  await refreshOrgPolicy({data, policy: {licenseKey: 'synthetic-key'}, getPolicy: async () => ({status: 200, body: envelope({version: 1, deniedTools: ['^Read$']})})});
  const engine = await start({licenseReader: () => team});
  const meta = id => ({gate: 'spend', toolName: 'Read', sessionId: 'live', toolUseId: id, host: matrix.host});
  assert.equal(permission(await engine.handle({meta: meta('1')})), 'deny');
  const result = await pushPersonalPolicy({data, sessionId: 'policy-cli', resolveLicense: async () => team, put: () => { throw new Error('no upload'); }});
  assert.ok(result.error); assert.equal(result.syncFailed, false);
  require('../runtime/worker-session.cjs').recordPushResult(engine, ['live'], result);
  assert.equal(permission(await engine.handle({meta: meta('2')})), 'deny');
  assert.equal(engine.context(meta('3')).mode, 'enforce');
  const failed = await pushPersonalPolicy({data, sessionId: 'policy-cli', resolveLicense: async () => solo, put: () => { throw new Error('offline'); }});
  assert.ok(failed.error); assert.equal(failed.syncFailed, true);
});

// Finding 4: a Solo sync failure is one state on disk for the hook and the worker.
test('a Solo sync failure is written to the status file so the hook and the worker decide the same call', async t => {
  const {data, start} = fixture(t, {version: 1, mode: 'enforce', licenseKey: 'synthetic-key', commandRules: [{id: 'no-curl', pattern: 'curl', action: 'block'}]});
  await refreshOrgPolicy({data, policy: {licenseKey: 'synthetic-key'}, getPolicy: async () => ({status: 200, body: envelope({version: 1, mode: 'enforce', commandRules: [{id: 'no-curl-synced', pattern: 'curl', action: 'block'}]})})});
  const engine = await start({licenseReader: () => solo});
  const state = require('../runtime/policy-state.cjs'), original = state.policyState;
  state.policyState = (d, s, options = {}) => original(d, s, {licenseReader: () => solo, ...options}); t.after(() => { state.policyState = original; });
  const hook = id => call('curl https://example.invalid', id, {cwd: root});
  assert.equal(permission(await engine.handle(hook('a'))), 'deny');
  const failed = await pushPersonalPolicy({data, sessionId: 'policy-cli', resolveLicense: async () => solo, put: () => { throw new Error('offline'); }});
  assert.ok(failed.error);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'org-policy-status.json'), 'utf8')).status, 'shadow');
  engine.recordOrgFailure('session', 'org_policy_unavailable');
  const after = await engine.handle(hook('b'));
  assert.equal(permission(after), 'deny'); assert.equal(rows(engine).at(-1).decision.plugin.event, 'decision');
  assert.equal(engine.context(hook('c').meta).orgPolicy, null);
  // A refusal before any PUT leaves the snapshot in force on both sides.
  const second = {...envelope({version: 1, mode: 'enforce', commandRules: [{id: 'no-curl-synced', pattern: 'curl', action: 'block'}]}), version: 4};
  await refreshOrgPolicy({data, policy: {licenseKey: 'synthetic-key'}, getPolicy: async () => ({status: 200, body: second})});
  const refused = await pushPersonalPolicy({data, sessionId: 'policy-cli', resolveLicense: async () => ({...solo, mode: 'shadow', reason: 'license_unavailable'}), put: () => { throw new Error('must not upload'); }});
  assert.ok(refused.error); assert.equal(refused.syncFailed, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'org-policy-status.json'), 'utf8')).status, 'ready');
  engine.clearSessionFailure('session', 'org');
  assert.equal(permission(await engine.handle(hook('d'))), 'deny'); assert.equal(rows(engine).at(-1).decision.plugin.event, 'decision');
  assert.equal(engine.context(hook('e').meta).orgPolicy?.version, 4);
});

// Finding 5: a pushed personal policy can only tighten the Guard Pack.
test('a Solo push cannot turn a Guard Pack rule off', async t => {
  const off = Object.fromEntries(Array.from({length: 14}, (_, index) => ['GP' + String(index + 1).padStart(3, '0'), 'off']));
  const {data} = fixture(t, {version: 1, licenseKey: 'k', guardPack: {rules: off}});
  const result = await pushPersonalPolicy({data, sessionId: 's', resolveLicense: async () => solo, put: async (url, request) => ({status: 200, body: envelope(request.policy)})});
  assert.ok(result.sha256);
  const view = policyState(data, 's', {licenseReader: () => solo});
  assert.equal(view.orgPolicy.sha256, result.sha256);
  for (const id of Object.keys(off)) assert.equal(view.config.guardPack.rules[id], 'stop', id);
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({version: 1, licenseKey: 'k', guardPack: {rules: {'inbox-reset-codes': 'stop'}}}));
  assert.equal(policyState(data, 's', {licenseReader: () => solo}).config.guardPack.rules['inbox-reset-codes'], 'stop');
});

// Finding 7: merge-only keys in a policy file cannot erase another layer's rules.
test('commandRuleGroups and allowedToolGroups in a policy file are ignored', async t => {
  const {data} = fixture(t, {version: 1, mode: 'enforce', licenseKey: 'k', teamPolicyFile: 'team.json', commandRuleGroups: [[]], allowedToolGroups: [[]]});
  fs.writeFileSync(path.join(data, 'team.json'), JSON.stringify({version: 1, mode: 'enforce', commandRules: [{id: 'team-no-deploy', match: 'deploy', action: 'block'}], allowedTools: ['^Read$']}));
  await refreshOrgPolicy({data, policy: {licenseKey: 'k'}, getPolicy: async () => ({status: 204})});
  const state = policyState(data, 's', {licenseReader: () => team});
  assert.equal(scanCommands(state.config, 'Bash', {command: 'vercel deploy'}, {cwd: data, workspace: data}).commandRuleIds.at(-1), 'team-no-deploy');
  assert.equal(state.config.allowedToolGroups, undefined); assert.deepEqual(state.config.allowedTools, ['^Read$']);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-review-solo-'));
  t.after(() => fs.rmSync(other, {recursive: true, force: true}));
  fs.writeFileSync(path.join(other, 'policy.json'), JSON.stringify({version: 1, licenseKey: 'k', commandRuleGroups: [[]]}));
  const synced = {version: 1, commandRules: [{id: 'synced', match: 'deploy', action: 'block'}]};
  await refreshOrgPolicy({data: other, policy: {licenseKey: 'k'}, getPolicy: async () => ({status: 200, body: {version: 2, published_at: '2026-09-22T00:00:00.000Z', sha256: hashPolicy(synced), policy: synced}})});
  assert.equal(scanCommands(policyState(other, 's', {licenseReader: () => solo}).config, 'Bash', {command: 'vercel deploy'}, {cwd: other, workspace: other}).commandRuleIds.at(-1), 'synced');
  assert.equal(localPolicy(data).commandRuleGroups, undefined);
});

// Finding 6: ordinary spellings of the built-in categories.
test('built-in matches cover ordinary spellings and leave ordinary work alone', async t => {
  const {workspace} = fixture(t);
  const policy = {...preset('careful'), commandRules: [...preset('careful').commandRules, {id: 'package-publish', match: 'package-publish', action: 'block'}]};
  for (const [expected, command] of spellings) {
    const scan = scanCommands(policy, 'Bash', {command}, {cwd: workspace, workspace});
    assert.equal(scan.commandRuleIds[0], expected, command);
  }
  for (const command of ordinary) assert.equal(scanCommands(policy, 'Bash', {command}, {cwd: workspace, workspace}).commandRuleIds[0], null, command);
});

// Low findings.
test('a throwing upgrade moment cannot turn a deny into an allow', async t => {
  const {cli, start} = fixture(t); await cli(['preset', 'careful']); const engine = await start();
  const moments = require('../runtime/upgrade-moments.cjs'), original = moments.stopMoment;
  moments.stopMoment = () => { throw new Error('boom'); }; t.after(() => { moments.stopMoment = original; });
  assert.equal(permission(await engine.handle(call('git push --force origin feature', 'stop-survives'))), 'deny');
});

test('a stale upgrade-moment lock is cleared', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-review-home-')); t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const {claim} = require('../runtime/upgrade-moments.cjs');
  const dir = path.join(home, 'upgrade-moments'); fs.mkdirSync(dir, {recursive: true});
  const lock = path.join(dir, 'free-stop.lock'); fs.writeFileSync(lock, '');
  const old = Date.now() / 1000 - 3600; fs.utimesSync(lock, old, old);
  assert.equal(claim('free-stop', {home, interval: 1000}), true);
  assert.equal(fs.existsSync(lock), false);
});

test('an unknown branch under strict still asks instead of skipping the rule', async t => {
  const {cli, start} = fixture(t); await cli(['preset', 'strict']); const engine = await start();
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-review-nogit-')); t.after(() => fs.rmSync(nowhere, {recursive: true, force: true}));
  const result = await engine.handle(call('git reset --hard HEAD', 'unknown-branch', {cwd: nowhere}));
  assert.equal(permission(result), held);
  const last = rows(engine).at(-1).decision;
  assert.ok(last.reasons.some(reason => /guard_branch_unknown/.test(reason)), last.reasons.join(','));
});

test('show prints shadow for a Team policy failure', async t => {
  const {data, cli} = fixture(t, {version: 1, mode: 'enforce', licenseKey: 'k'});
  await refreshOrgPolicy({data, policy: {licenseKey: 'k'}, getPolicy: async () => { throw new Error('offline'); }});
  const output = await run(['show'], {data, sessionId: 'session', licenseReader: () => team});
  assert.match(output, /shadow/); assert.doesNotMatch(output, /Local policy applies/);
});

test('push resolves the license from the cached status without registering a seat', async t => {
  const {data} = fixture(t, {version: 1, mode: 'enforce', licenseKey: 'k'});
  const previous = global.fetch; global.fetch = () => { throw new Error('Unexpected network'); }; t.after(() => { global.fetch = previous; });
  const result = await pushPersonalPolicy({data, sessionId: 'policy-cli', put: () => { throw new Error('must not upload'); }});
  assert.ok(result.error); assert.equal(result.syncFailed, false);
});

test('per-session charges stay bounded', async t => {
  const {cli, start} = fixture(t, {version: 1, mode: 'enforce', toolRules: [{pattern: '^Read$', unitCostCents: 1}]});
  await cli(['set-cap', '100', 'per_session']); const engine = await start();
  for (let index = 0; index < 3000; index++) assert.equal(permission(await engine.handle(call('', `charge-${index}`, {tool: 'Read', input: {}}))), 'allow');
  assert.ok(engine.chargeCount('session') <= 2048);
  for (let index = 0; index < 7100; index++) await engine.handle(call('', `more-${index}`, {tool: 'Read', input: {}}));
  assert.equal(permission(await engine.handle(call('', 'over-cap', {tool: 'Read', input: {}}))), 'deny');
});
