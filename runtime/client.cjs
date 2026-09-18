'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { locations, allow, metadata, spoolFailure, writeWorkerPid } = require('./common.cjs');

async function request(message) {
  const loc = locations();
  fs.mkdirSync(loc.data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(loc.ipc, { recursive: true, mode: 0o700 });
  const ipcStat = fs.lstatSync(loc.ipc);
  if (!ipcStat.isDirectory() || ipcStat.isSymbolicLink() || (ipcStat.mode & 0o077) !== 0 || (process.getuid && ipcStat.uid !== process.getuid())) throw new Error('ipc_directory_not_private');
  const warm = fs.existsSync(loc.socket);
  return new Promise((resolve, reject) => {
    let finished = false, started = false, active;
    const deadline = setTimeout(() => done(new Error('worker_timeout')), warm ? 28 : 1500);
    function done(error, value) {
      if (finished) return; finished = true; clearTimeout(deadline); active?.destroy();
      error ? reject(error) : resolve(value);
    }
    function startWorker() {
      if (started) return; started = true;
      try {
        try { const pid = Number(fs.readFileSync(loc.lock, 'utf8')); process.kill(pid, 0); return; }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') return; }
        try { fs.unlinkSync(loc.lock); } catch {}
        const fd = fs.openSync(loc.lock, 'wx', 0o600);
        fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
        const child = spawn(process.execPath, [path.join(__dirname, 'daemon.cjs')], { detached: true, stdio: 'ignore', env: process.env });
        if (child.pid) writeWorkerPid(loc.lock, child.pid);
        child.on('error', () => done(new Error('worker_start'))); child.unref();
      } catch (error) { if (error.code !== 'EEXIST') done(new Error('worker_start')); }
    }
    function connect() {
      if (finished) return;
      const socket = active = net.createConnection(loc.socket);
      let text = '';
      socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
      socket.on('data', chunk => { text += chunk; if (text.includes('\n')) {
        try { done(null, JSON.parse(text.split('\n')[0])); } catch { done(new Error('worker_response')); }
      }});
      socket.on('error', error => {
        socket.destroy();
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') { startWorker(); setTimeout(connect, 8); }
        else done(new Error('worker_unavailable'));
      });
    }
    connect();
  });
}
function hookOutput(output, options = {}) {
  const specific = output?.hookSpecificOutput;
  if (!options.legacyAllow || specific?.hookEventName !== 'PreToolUse' ||
      specific.permissionDecision !== 'allow' || specific.updatedInput != null) return output;
  // Codex 0.154 accepts an empty successful response for an unmodified input;
  // its explicit allow envelope is supported only when updatedInput is set.
  // Preserve advisory context, including Burn shadow-mode warnings.
  const normalized = {...output, hookSpecificOutput: {...specific}};
  delete normalized.hookSpecificOutput.permissionDecision;
  delete normalized.hookSpecificOutput.permissionDecisionReason;
  if (Object.keys(normalized.hookSpecificOutput).every(key => key === 'hookEventName')) delete normalized.hookSpecificOutput;
  return normalized;
}
async function run(gate, options = {}) {
  let meta = { schema: 'agentguard.codex.v1', gate, toolName: 'unknown', sessionId: 'unknown', toolUseId: require('node:crypto').randomUUID(), startedAt: new Date().toISOString() };
  try {
    const raw = JSON.parse(fs.readFileSync(0, 'utf8'));
    meta = metadata(raw, gate);
    const result = await request({ meta, ...(gate === 'burn' && typeof raw.transcript_path === 'string' ? { transcriptPath: raw.transcript_path } : {}) });
    if (result.warning) process.stderr.write('agentguard: internal error; allowed tool call; fail-open event recorded.\n');
    process.stdout.write(JSON.stringify(hookOutput(result.output ?? (gate === 'receipt' ? {} : allow()), options)) + '\n');
  } catch {
    spoolFailure(meta, 'hook_internal_error');
    process.stderr.write('agentguard: internal error; allowed tool call; audit recovery queued when storage is writable.\n');
    process.stdout.write(JSON.stringify(hookOutput(gate === 'receipt' ? {} : allow(), options)) + '\n');
  }
}
module.exports = { request, run, hookOutput };
