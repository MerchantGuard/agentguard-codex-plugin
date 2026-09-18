'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync, execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-public-sync-test-'));
  const source = path.join(temporary, 'source package');
  const destination = path.join(temporary, 'public checkout');
  fs.cpSync(root, source, {recursive: true, filter: filename => !['node_modules', '.git', '.DS_Store'].includes(path.basename(filename))});
  fs.mkdirSync(destination);
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', destination]);
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  return {temporary, source, destination};
}
function sync(f, destination = f.destination) {
  return spawnSync('bash', [path.join(f.source, 'scripts', 'sync-public.sh'), destination], {encoding: 'utf8', timeout: 30000});
}
function files(directory, prefix = '') {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative) : [relative];
  });
}
function snapshot(directory) {
  return Object.fromEntries(files(directory).sort().map(relative => [relative, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, relative))).digest('hex')]));
}

test('public sync copies an explicit distribution, preserves Git, removes owned stale files, and is idempotent', t => {
  const f = fixture(t);
  const marker = crypto.randomUUID();
  for (const relative of ['.env.secret', 'scratch/private.txt', 'node_modules/private.txt', 'tests/private-notes.json', 'runtime/scratch-secret.cjs', 'compat/codex-0.154/agentguard/runtime/scratch-secret.cjs', '.git/private.txt']) {
    const filename = path.join(f.source, relative);
    fs.mkdirSync(path.dirname(filename), {recursive: true});
    fs.writeFileSync(filename, marker);
  }
  // The unlisted runtime file also exists in the generated source artifact.
  // Both copies must be excluded by the sync allowlist.
  fs.writeFileSync(path.join(f.destination, '.git', 'review-sentinel'), 'git directory must survive');
  fs.writeFileSync(path.join(f.destination, 'UNRELATED-NOTES.txt'), 'outside the package deletion scope');
  fs.mkdirSync(path.join(f.destination, 'runtime'));
  fs.writeFileSync(path.join(f.destination, 'runtime', 'stale.cjs'), 'old distribution file');
  const gitConfig = fs.readFileSync(path.join(f.destination, '.git', 'config'));
  const result = sync(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Review the working tree/);
  assert.equal(fs.readFileSync(path.join(f.destination, '.git', 'review-sentinel'), 'utf8'), 'git directory must survive');
  assert.deepEqual(fs.readFileSync(path.join(f.destination, '.git', 'config')), gitConfig);
  assert.equal(fs.readFileSync(path.join(f.destination, 'UNRELATED-NOTES.txt'), 'utf8'), 'outside the package deletion scope');
  assert.equal(fs.existsSync(path.join(f.destination, 'runtime', 'stale.cjs')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'node_modules')), false);
  for (const relative of files(f.destination)) assert.equal(fs.readFileSync(path.join(f.destination, relative)).includes(Buffer.from(marker)), false, relative);
  const catalog = JSON.parse(fs.readFileSync(path.join(f.destination, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(catalog.name, 'agentguard');
  assert.equal(catalog.plugins[0].source.path, './compat/codex-0.154/agentguard');
  assert.deepEqual(catalog.plugins[0].policy, {installation: 'AVAILABLE', authentication: 'ON_INSTALL'});
  assert.equal(catalog.plugins[0].category, 'Productivity');
  const before = snapshot(f.destination);
  const again = sync(f);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(snapshot(f.destination), before);
  assert.equal(execFileSync('git', ['-C', f.destination, 'rev-list', '--all', '--count'], {encoding: 'utf8'}).trim(), '0');
});

test('synced standalone checkout passes the same packaging tests without ancestor files', t => {
  const f = fixture(t);
  const result = sync(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Resolve the already-installed registry dependencies for this temporary
  // test checkout. No package manifest contains a local dependency link.
  const env = {...process.env, NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter), AGENTGUARD_HOME: path.join(f.temporary, 'sdk-home')};
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', 'tests/packaging.test.cjs'], {
    cwd: f.destination, encoding: 'utf8', timeout: 30000,
    env,
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /(?:#|ℹ) fail 0/);
  assert.equal(fs.existsSync(path.join(f.temporary, 'public', 'logo.svg')), false);
});

test('sync rejects source symlinks and destination symlinks before modifying the checkout', t => {
  const f = fixture(t);
  const outside = path.join(f.temporary, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside directory');
  fs.symlinkSync(outside, path.join(f.destination, 'runtime'), 'dir');
  const unsafeDestination = sync(f);
  assert.notEqual(unsafeDestination.status, 0);
  assert.match(unsafeDestination.stderr, /unsafe path/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside directory');
  assert.equal(fs.existsSync(path.join(f.destination, 'package.json')), false);
  fs.unlinkSync(path.join(f.destination, 'runtime'));
  fs.unlinkSync(path.join(f.source, 'assets', 'logo.svg'));
  fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(f.source, 'assets', 'logo.svg'));
  const unsafeSource = sync(f);
  assert.notEqual(unsafeSource.status, 0);
  assert.match(unsafeSource.stderr, /regular package file/);
  assert.equal(fs.existsSync(path.join(f.destination, 'package.json')), false);
});

test('sync refuses a checkout ancestor of its source and a checkout subdirectory', t => {
  const f = fixture(t);
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', f.temporary]);
  const ancestor = sync(f, f.temporary);
  assert.notEqual(ancestor.status, 0);
  assert.match(ancestor.stderr, /must not contain/);
  fs.mkdirSync(path.join(f.destination, 'nested'));
  const nested = sync(f, path.join(f.destination, 'nested'));
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /root of an existing Git checkout/);
});
