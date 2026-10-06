#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {snapshot, assertUnchanged} = require('./test-isolation.cjs');
const root = path.resolve(__dirname, '..');

// The injectable protected directory is for regression fixtures only. The CLI
// always protects the OS user's real home, regardless of the caller's env.
async function runTests(args = [], {protectedHome = path.join(os.userInfo().homedir, '.agentguard')} = {}) {
  const before = snapshot(protectedHome);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-test-run-'));
  const home = path.join(temporary, 'agentguard');
  fs.mkdirSync(home, {mode: 0o700});
  const env = {...process.env, AGENTGUARD_NOTIFY_SUPPRESS: '1', AGENTGUARD_HOME: home};
  // Nested runner regression tests must launch an actual test coordinator.
  delete env.NODE_TEST_CONTEXT;
  const files = args.some(arg => /\.c?js$/.test(arg)) ? []
    : fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.cjs')).sort().map(name => path.join('tests', name));
  let status = 1;
  try {
    status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', path.join(root, 'tests/helper-notifications.cjs'), '--test', '--test-concurrency=1', ...args, ...files],
        {cwd: root, env, stdio: 'inherit'});
      const interrupt = signal => child.kill(signal);
      const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
      process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
      child.once('error', reject);
      child.once('close', code => {
        process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
        resolve(code ?? 1);
      });
    });
  } finally {
    try {
      assertUnchanged(protectedHome, before);
      process.stdout.write('# Test isolation: real AgentGuard home unchanged.\n');
    } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
  }
  return status;
}

module.exports = {runTests};
if (require.main === module) runTests(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
