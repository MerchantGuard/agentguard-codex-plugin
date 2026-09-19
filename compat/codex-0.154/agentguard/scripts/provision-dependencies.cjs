#!/usr/bin/env node
'use strict';
// Run only at installation. Hooks and the MCP reader never copy or download
// dependencies. The immutable snapshot survives host plugin-cache refreshes.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {dependencyInfo, durableDataDirectory, validateModules, validateProvision} = require('../runtime/dependencies.cjs');
const root = path.resolve(__dirname, '..');

function privateDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('AgentGuard dependency data directory must be owned by the current user.');
  }
  fs.chmodSync(directory, 0o700);
}

function safeCopyTree(directory, rootDirectory = fs.realpathSync(directory)) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(filename);
      const relative = path.relative(rootDirectory, fs.realpathSync(filename));
      if (path.isAbsolute(link) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('AgentGuard cannot provision dependencies linked outside node_modules.');
      }
    } else if (entry.isDirectory()) safeCopyTree(filename, rootDirectory);
    else if (!entry.isFile()) throw new Error('AgentGuard dependencies contain an unsupported filesystem entry.');
  }
}

function provision() {
  let data;
  try { data = durableDataDirectory(root); } catch {
    // npm ci in a source checkout should not create implicit home state.
    if (require('../runtime/common.cjs').hostContext().data) throw new Error('AgentGuard plugin data directory is invalid.');
    process.stdout.write('AgentGuard dependencies remain local; set PLUGIN_DATA to provision a source checkout.\n');
    return;
  }
  const info = dependencyInfo(root);
  const modules = path.join(root, 'node_modules');
  validateModules(modules, info);
  safeCopyTree(modules);
  privateDirectory(data);
  const directory = path.join(data, 'dependencies');
  privateDirectory(directory);
  const destination = path.join(directory, info.lockDigest);
  if (fs.existsSync(destination)) {
    validateProvision(destination, info);
    process.stdout.write(`AgentGuard durable dependencies already provisioned (${info.lockDigest.slice(0, 12)}).\n`);
    return;
  }
  const temporary = path.join(directory, `.provision-${randomUUID()}`);
  try {
    privateDirectory(temporary);
    fs.cpSync(modules, path.join(temporary, 'node_modules'), {recursive: true, verbatimSymlinks: true});
    fs.writeFileSync(path.join(temporary, 'package-lock.json'), info.lockBytes, {mode: 0o600});
    fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({private: true, dependencies: info.dependencies}) + '\n', {mode: 0o600});
    validateModules(path.join(temporary, 'node_modules'), info);
    fs.writeFileSync(path.join(temporary, 'provision.json'), JSON.stringify({schema: 'agentguard.dependencies.v1', lockDigest: info.lockDigest, dependencies: info.dependencies}) + '\n', {mode: 0o600});
    validateProvision(temporary, info);
    try { fs.renameSync(temporary, destination); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      validateProvision(destination, info); // Another install completed first.
    }
    process.stdout.write(`AgentGuard durable dependencies provisioned (${info.lockDigest.slice(0, 12)}).\n`);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
}

module.exports = {provision};
if (require.main === module) {
  try { provision(); } catch {
    process.stderr.write('AgentGuard dependency provisioning failed; check the installed packages, lockfile and writable PLUGIN_DATA.\n');
    process.exitCode = 1;
  }
}
