'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { locations, allow, metadata, spoolFailure, writeWorkerPid } = require('./common.cjs');

function ensurePrivateIpc(loc) {
  fs.mkdirSync(loc.data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(loc.ipc, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(loc.ipc);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error('ipc_directory_not_private');
}
function readPrivate(file, maxBytes = 32768) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error('ipc_file_not_private');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function writeMessage(file, message) {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text) > 32768) throw new Error('ipc_message_too_large');
  const temporary = file + '.tmp-' + crypto.randomUUID();
  try { fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function workerReady(loc) {
  try {
    const ready = JSON.parse(readPrivate(loc.ready));
    const pid = Number(readPrivate(loc.lock));
    if (ready.pid !== pid || !Number.isSafeInteger(pid) || pid < 1) return false;
    process.kill(pid, 0); return true;
  } catch { return false; }
}
async function request(message, options = {}) {
  const loc = locations(); ensurePrivateIpc(loc);
  const warm = workerReady(loc);
  if (options.startWorker === false && !warm) return {};
  const id = `${Date.now().toString().padStart(16, '0')}-${process.hrtime.bigint()}-${crypto.randomUUID()}`;
  const input = path.join(loc.ipc, id + '.request');
  const output = path.join(loc.ipc, id + '.response');
  writeMessage(input, message);
  return new Promise((resolve, reject) => {
    let finished = false, started = false, poll;
    const deadline = setTimeout(() => done(new Error('worker_timeout')), options.timeoutMs ?? (warm ? 28 : 1500));
    function done(error, value) {
      if (finished) return; finished = true; clearTimeout(deadline); clearTimeout(poll);
      try { fs.unlinkSync(input); } catch {}
      try { fs.unlinkSync(output); } catch {}
      error ? reject(error) : resolve(value);
    }
    function startWorker() {
      if (started || options.startWorker === false) return; started = true;
      try {
        let owner;
        try { owner = Number(readPrivate(loc.lock)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (owner !== undefined) {
          if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('invalid_worker_owner');
          try { process.kill(owner, 0); return; }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
          // An exclusive retirement claim prevents simultaneous cold clients
          // from replacing a newly acquired worker lock.
          const retiring = loc.lock + '.retiring';
          const claim = fs.openSync(retiring, 'wx', 0o600); fs.closeSync(claim);
          try {
            if (Number(readPrivate(loc.lock)) !== owner) return;
            try { process.kill(owner, 0); return; } catch (error) { if (error.code !== 'ESRCH') throw error; }
            fs.unlinkSync(loc.lock);
          } finally { fs.unlinkSync(retiring); }
        }
        const fd = fs.openSync(loc.lock, 'wx', 0o600);
        fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
        const child = spawn(process.execPath, [path.join(__dirname, 'daemon.cjs')], { detached: true, stdio: 'ignore', env: process.env });
        if (child.pid) writeWorkerPid(loc.lock, child.pid);
        child.on('error', () => done(new Error('worker_start'))); child.unref();
      } catch (error) { if (error.code !== 'EEXIST') done(new Error('worker_start')); }
    }
    function receive() {
      if (finished) return;
      try { const result = JSON.parse(readPrivate(output)); if (result.transportError) throw new Error('worker_response'); done(null, result); return; }
      catch (error) { if (error.code !== 'ENOENT') { done(new Error('worker_response')); return; } }
      if (!warm) startWorker();
      poll = setTimeout(receive, 1);
    }
    receive();
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
module.exports = { request, run, hookOutput, ensurePrivateIpc, readPrivate, writeMessage, workerReady };
