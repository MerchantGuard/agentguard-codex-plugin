'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { locations, writeWorkerPid } = require('./common.cjs');
const { ensurePrivateIpc, readPrivate, writeMessage } = require('./client.cjs');
const loc = locations();
let watcher, idle, rescan, engine, health, stopPromise, draining = false, stopped = false;
function ownsWorker() {
  try { return readPrivate(loc.lock) === String(process.pid); } catch { return false; }
}
function stop(responsePath) {
  if (stopPromise) return stopPromise;
  stopped = true; clearTimeout(idle); clearInterval(rescan); watcher?.close();
  stopPromise = (async () => {
    let timer;
    try {
      await Promise.race([
        Promise.all([engine?.flush(), health?.persist()]),
        new Promise(resolve => { timer = setTimeout(resolve, 1500); }),
      ]);
    } catch { /* An unconfirmed tail is reconciled at the next startup. */ }
    finally { clearTimeout(timer); }
    if (responsePath) { try { writeMessage(responsePath, {}); } catch {} }
    if (ownsWorker()) { try { fs.unlinkSync(loc.lock); } catch {} try { fs.unlinkSync(loc.ready); } catch {} }
    process.exit(0);
  })();
  return stopPromise;
}
function touch() { clearTimeout(idle); idle = setTimeout(stop, 300000); }
async function main() {
  ensurePrivateIpc(loc);
  const owner = Number(readPrivate(loc.lock));
  if (owner !== process.pid && owner !== process.ppid) return;
  writeWorkerPid(loc.lock, process.pid);
  const { Engine } = require('./engine.cjs');
  const {HealthTracker} = require('./health.cjs');
  health = new HealthTracker({data: loc.data});
  health.recordPending();
  engine = new Engine(); await engine.init();
  async function drain() {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped) {
        if (!ownsWorker()) return stop();
        const name = fs.readdirSync(loc.ipc).filter(name => /^\d{16}-\d+-[a-f0-9-]{36}\.request$/.test(name)).sort()[0];
        if (!name) break;
        const input = path.join(loc.ipc, name), output = input.replace(/\.request$/, '.response');
        let message;
        try { message = JSON.parse(readPrivate(input)); }
        catch { try { fs.unlinkSync(input); } catch {} continue; }
        try { fs.unlinkSync(input); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        touch();
        if (message.control === 'stop') return stop(output);
        try {
          health.recordPending();
          const result = await engine.handle(message);
          const snapshot = health.record({requestId: message.meta?.requestId, gate: message.meta?.gate,
            startedAt: message.meta?.startedAt, failOpen: result.warning === true,
            cause: result.cause || (result.warning ? 'policy_or_runtime_error' : undefined)});
          if (snapshot.warning) result.healthWarning = snapshot.warning;
          writeMessage(output, result);
        } catch {
          health.record({requestId: message.meta?.requestId, gate: message.meta?.gate,
            startedAt: message.meta?.startedAt, failOpen: true, cause: 'worker_request'});
          writeMessage(output, {transportError: 'worker_request'});
        } finally {
          // Publish the reply before scheduling durability or metric storage.
          engine.afterReply();
          void health.persist().catch(() => {});
        }
      }
    } catch { stop(); }
    finally { draining = false; }
  }
  function cleanup() {
    const now = Date.now();
    for (const name of fs.readdirSync(loc.ipc)) {
      if (!/^\d{16}-\d+-[a-f0-9-]{36}\.(request|response)$/.test(name)) continue;
      const file = path.join(loc.ipc, name);
      try { if (now - fs.lstatSync(file).mtimeMs > 30000) fs.unlinkSync(file); } catch {}
    }
  }
  cleanup();
  function pollingFallback() {
    watcher?.close(); watcher = undefined; clearInterval(rescan);
    let cleanedAt = Date.now();
    rescan = setInterval(() => {
      if (Date.now() - cleanedAt >= 1000) { cleanup(); cleanedAt = Date.now(); }
      void drain();
    }, 4);
  }
  // Watching provides the fast path. Sandboxed hosts may disallow filesystem
  // watchers, so bounded local polling remains available without a socket.
  try {
    watcher = fs.watch(loc.ipc, () => { void drain(); });
    watcher.on('error', pollingFallback);
    rescan = setInterval(() => { cleanup(); void drain(); }, 1000);
  } catch { pollingFallback(); }
  writeMessage(loc.ready, { pid: process.pid, transport: 'files-v1' });
  touch(); engine.afterReply(); void health.persist().catch(() => {}); void drain();
  process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
}
main().catch(() => { void stop(); });
