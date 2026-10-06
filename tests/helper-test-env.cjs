'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-plugin-tests-'));
const home = path.join(temporary, 'home');
const agentguard = path.join(temporary, 'agentguard');
const data = path.join(temporary, 'data');
for (const directory of [home, agentguard, data]) fs.mkdirSync(directory, {mode: 0o700});

// A fresh default per test process also isolates in-process Engine.init(): its
// registerLedger() uses AGENTGUARD_HOME, independently of locations().data.
Object.assign(process.env, {HOME: home, AGENTGUARD_HOME: agentguard,
  PLUGIN_DATA: data, AGENTGUARD_NOTIFY_SUPPRESS: '1'});
if (process.platform === 'win32') process.env.USERPROFILE = home;
for (const key of ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA',
  // A license key set as the plugin option in the session running the tests
  'CLAUDE_PLUGIN_OPTION_LICENSE_KEY']) delete process.env[key];
process.once('exit', () => fs.rmSync(temporary, {recursive: true, force: true}));

const temporaryRoots = [...new Set([os.tmpdir(), '/tmp'].filter(fs.existsSync).map(directory => fs.realpathSync(directory)))];
function isTemporary(directory) {
  if (!directory || !path.isAbsolute(directory)) return false;
  // Resolve existing ancestors too: /tmp and macOS's /var are symlinks, and a
  // fixture may name a directory the worker has not created yet.
  let ancestor = path.resolve(directory), suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
  const resolved = path.join(fs.realpathSync(ancestor), ...suffix);
  return temporaryRoots.some(root => resolved.startsWith(root + path.sep));
}

function testEnv(source = process.env) {
  const env = {...source, AGENTGUARD_NOTIFY_SUPPRESS: '1'};
  env.AGENTGUARD_HOME ||= agentguard;
  env.HOME = isTemporary(env.HOME) ? env.HOME : home;
  if (process.platform === 'win32') env.USERPROFILE = env.HOME;
  // Preserve intentionally absent plugin variables in fixtures testing host
  // auto-discovery. Their HOME is temporary, so the runtime fallback is safe.
  // For a minimal env with no fixture HOME, supply the host's data variable.
  if (!env.PLUGIN_DATA && !env.CLAUDE_PLUGIN_DATA && !isTemporary(source.HOME)) {
    env[env.CLAUDE_PLUGIN_ROOT && !env.PLUGIN_ROOT ? 'CLAUDE_PLUGIN_DATA' : 'PLUGIN_DATA'] = data;
  }
  for (const key of ['AGENTGUARD_HOME', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA']) {
    if (env[key] && !isTemporary(env[key])) throw new Error(`${key} must point to a temporary test directory: ${env[key]}`);
  }
  return env;
}

// Use these for every test subprocess, including commands which launch Node
// indirectly. Explicit env objects receive the same safety defaults.
function run(method, file, args, options) {
  if (!Array.isArray(args)) { options = args ?? options; args = []; }
  return child[method](file, args, {...options, env: testEnv(options?.env ?? process.env)});
}
const spawn = (file, args, options) => run('spawn', file, args, options);
const spawnSync = (file, args, options) => run('spawnSync', file, args, options);
const execFileSync = (file, args, options) => run('execFileSync', file, args, options);
module.exports = {temporary, testEnv, isTemporary, spawn, spawnSync, execFileSync};
