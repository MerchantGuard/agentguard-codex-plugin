'use strict';
// Dependency resolution is read-only and offline. npm's postinstall provisions
// registry packages outside the Codex cache, which the host can replace.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {createRequire} = require('node:module');
const pluginRoot = path.resolve(__dirname, '..');
const allowed = new Set(['@agentguard-run/spend', '@agentguard-run/burn']);
const cache = new Map();

function dependencyInfo(root = pluginRoot) {
  root = path.resolve(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  const dependencies = manifest.dependencies;
  if (!dependencies || Object.keys(dependencies).length !== allowed.size ||
      [...allowed].some(name => !dependencies[name] || lock.packages?.['']?.dependencies?.[name] !== dependencies[name])) {
    throw new Error('AgentGuard dependency manifest does not match its lockfile.');
  }
  const packages = Object.entries(lock.packages ?? {}).filter(([name]) => name !== '');
  for (const [relative, pkg] of packages) {
    if (!/^node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)*$/.test(relative) ||
        pkg.link || typeof pkg.version !== 'string' || !/^https:\/\/registry\.npmjs\.org\//.test(pkg.resolved ?? '') ||
        !/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity ?? '')) {
      throw new Error('AgentGuard requires a registry-only dependency lockfile.');
    }
  }
  if ([...allowed].some(name => !lock.packages?.[`node_modules/${name}`])) {
    throw new Error('AgentGuard dependency lockfile is incomplete.');
  }
  return {root, lockBytes, lockDigest: createHash('sha256').update(lockBytes).digest('hex'), dependencies, packages};
}

function durableDataDirectory(root = pluginRoot) {
  const data = require('./common.cjs').hostContext().data;
  if (data) return path.resolve(data);
  return require('./mcp-legacy.cjs').legacyDataDirectory(root);
}

function contained(filename, directory) {
  const relative = path.relative(directory, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateModules(modules, info) {
  modules = path.resolve(modules);
  if (fs.lstatSync(modules).isSymbolicLink()) {
    throw new Error('AgentGuard dependencies must be local regular package directories.');
  }
  modules = fs.realpathSync(modules);
  for (const [relative, expected] of info.packages) {
    const directory = path.join(modules, relative.slice('node_modules/'.length));
    if (!contained(fs.realpathSync(directory), modules)) throw new Error('AgentGuard dependency escapes its installation.');
    const actual = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (actual.version !== expected.version) throw new Error('AgentGuard installed dependency version differs from the lockfile.');
  }
  const resolver = createRequire(path.join(path.dirname(modules), 'package.json'));
  for (const name of allowed) {
    const filename = resolver.resolve(name);
    if (!contained(fs.realpathSync(filename), path.join(modules, name))) {
      throw new Error('AgentGuard dependency entry point is outside its installation.');
    }
  }
  return resolver;
}

function validateProvision(directory, info) {
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'provision.json'), 'utf8'));
  if (provenance.schema !== 'agentguard.dependencies.v1' || provenance.lockDigest !== info.lockDigest ||
      Object.keys(provenance.dependencies ?? {}).length !== allowed.size ||
      [...allowed].some(name => provenance.dependencies[name] !== info.dependencies[name]) ||
      !fs.readFileSync(path.join(directory, 'package-lock.json')).equals(info.lockBytes)) {
    throw new Error('AgentGuard durable dependency provenance is stale or incomplete.');
  }
  return validateModules(path.join(directory, 'node_modules'), info);
}

function loadDependency(name) {
  if (!allowed.has(name)) throw new Error('Unsupported AgentGuard dependency.');
  if (cache.has(name)) return cache.get(name);
  const info = dependencyInfo();
  const local = path.join(info.root, 'node_modules');
  // A present but broken local installation is an error, not permission to
  // silently load a different package from an ancestor or global NODE_PATH.
  const resolver = fs.existsSync(local) ? validateModules(local, info)
    : validateProvision(path.join(durableDataDirectory(), 'dependencies', info.lockDigest), info);
  const result = resolver(name);
  cache.set(name, result);
  return result;
}

module.exports = {loadDependency, durableDataDirectory, dependencyInfo, validateModules, validateProvision};
