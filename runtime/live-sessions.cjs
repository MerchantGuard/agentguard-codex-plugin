'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync, execFile} = require('node:child_process');
const ACTIVITY_LEASE_MS = 15 * 60 * 1000;
const validSession = id => typeof id === 'string' && id.length > 0 && id.length <= 512;
const validIdentity = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const psArgs = pid => ['-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm='];
const psOptions = {encoding: 'utf8', timeout: 100, maxBuffer: 4096};
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function hostProcess(text) {
  const match = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(text || '');
  if (!match) return null;
  const started = match[2].replace(/\s+/g, ' '), command = match[3];
  return {parentPid: Number(match[1]), command,
    identity: createHash('sha256').update(`${started}\0${command}`).digest('hex')};
}
function readHost(pid) {
  return new Promise((resolve, reject) => {
    execFile('ps', psArgs(pid), psOptions, (error, output) => error ? reject(error) : resolve(output));
  });
}
// Only lifecycle helpers walk ancestors. Tool hooks do no process discovery.
function findHost(initialPid, read = pid => execFileSync('ps', psArgs(pid), psOptions)) {
  let pid = Number(initialPid);
  for (let depth = 0; depth < 8 && Number.isSafeInteger(pid) && pid > 1; depth++) {
    let text; try { text = read(pid); } catch { return null; }
    const observed = hostProcess(text);
    if (!observed) return null;
    if (/^(codex|claude|chatgpt)(?:\.exe)?$/i.test(path.basename(observed.command))) return {ownerPid: pid, ownerIdentity: observed.identity};
    if (observed.parentPid === pid) return null; pid = observed.parentPid;
  }
  return null;
}
function findHostPid(initialPid, read) { return findHost(initialPid, read)?.ownerPid ?? null; }
class LiveSessions {
  constructor({data, now = Date.now, isAlive = alive, readHost: readHostProcess = readHost}) {
    this.file = path.join(data, 'live-sessions.json'); this.now = now; this.isAlive = isAlive;
    this.readHost = readHostProcess;
    this.sessions = new Map(); this.saving = Promise.resolve(); this.dirty = false;
    try {
      const values = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const row of values) if (validSession(row.sessionId) && Number.isFinite(row.lastActivity)) this.sessions.set(row.sessionId, row);
    } catch {}
    for (const id of this.sessions.keys()) this.isLive(id);
  }
  observe(sessionId, ownerPid, ownerIdentity) {
    if (!validSession(sessionId)) return;
    const existing = this.sessions.get(sessionId);
    const pid = Number.isSafeInteger(ownerPid) && ownerPid > 1 ? ownerPid : existing?.ownerPid ?? null;
    const identity = validIdentity(ownerIdentity) && pid ? ownerIdentity
      : existing?.ownerPid === pid && validIdentity(existing?.ownerIdentity) ? existing.ownerIdentity : null;
    this.sessions.set(sessionId, {sessionId, ownerPid: pid, ownerIdentity: identity, lastActivity: this.now()});
    this.dirty = true;
  }
  forget(sessionId) { if (this.sessions.delete(sessionId)) this.dirty = true; }
  isLive(sessionId) {
    const row = this.sessions.get(sessionId); if (!row) return false;
    // Rows from earlier versions have no process identity. Their recent tool
    // activity provides a bounded lease, never an unlimited PID-only lease.
    const live = row.ownerPid && validIdentity(row.ownerIdentity) ? this.isAlive(row.ownerPid)
      : this.now() - row.lastActivity < ACTIVITY_LEASE_MS;
    if (!live) this.forget(sessionId);
    return live;
  }
  async confirmHost(sessionId) {
    if (!this.isLive(sessionId)) return false;
    const row = this.sessions.get(sessionId);
    if (!validIdentity(row.ownerIdentity)) return true;
    let observed;
    try { observed = hostProcess(await this.readHost(row.ownerPid)); } catch { /* No renewed seat without process identity. */ }
    const current = this.sessions.get(sessionId);
    if (!current) return false;
    if (current.ownerPid !== row.ownerPid || current.ownerIdentity !== row.ownerIdentity) return this.confirmHost(sessionId);
    if (!observed || observed.identity !== row.ownerIdentity) { this.forget(sessionId); return false; }
    return this.isLive(sessionId);
  }
  ids() { return [...this.sessions.keys()].filter(id => this.isLive(id)); }
  persist() {
    if (!this.dirty) return this.saving;
    this.dirty = false;
    const contents = JSON.stringify([...this.sessions.values()]);
    this.saving = this.saving.catch(() => {}).then(async () => {
      const temp = this.file + '.' + process.pid + '.tmp';
      await fs.promises.writeFile(temp, contents, {mode: 0o600});
      await fs.promises.rename(temp, this.file);
    });
    return this.saving;
  }
}
module.exports = {LiveSessions, findHost, findHostPid, ACTIVITY_LEASE_MS};
