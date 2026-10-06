'use strict';
// The tip from the person's last session, shown once when the next one starts.
// SessionEnd records which session ended and starts this file as a detached
// process; that process reads the transcript with Burn's sessionTip (the
// "Next: ..." line `npx agentguard-burn why` ends with, sub-agents included,
// in its plugin wording: the fan-out tip names an action instead of pointing
// to this plugin) and stores the line in the plugin's data directory. The
// hooks never read a transcript. SessionStart reads one small file and waits
// for nothing. Local display only: no request, no decision change, and quiet
// on silences it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {quiet} = require('./upgrade-moments.cjs');

const FILE = 'session-tip.json';
const SCHEMA = 'agentguard.session-tip.v1';
const DAY = 86400000;
const LEAD = 'AgentGuard tip from your last session: ';
// A startup or /clear begins a new conversation. A resumed, compacted or forked
// session continues one, so it shows nothing; a host that sends no source is
// treated as a startup.
const NEW_SESSION = new Set(['startup', 'clear']);
const MAX_BYTES = 16384;
// No holder keeps the lock for longer than one small read and write, so an
// older lock was left by a process that died and must not stop tips for good.
const STALE_LOCK_MS = 10000;

const dataDirectory = () => require('./common.cjs').locations().data;
// Burn's home, where `why` finds its pricing overrides, as the engine resolves it.
const burnHome = () => process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard');
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Burn renders the line from counts; it is still bounded and kept to one line.
const usableTip = value => typeof value === 'string' && value.length <= 1000 && /^Next: \S/.test(value) && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null;
const usableTally = value => typeof value === 'string' && value.length <= 1000 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null;
const sameJob = (last, sessionId, endedAt) => last?.sessionId === sessionId && last.endedAt === endedAt && last.state === 'computing';
const showable = (last, sessionId) => last?.state === 'ready' && (usableTip(last.tip) !== null || usableTally(last.tally) !== null) && last.sessionId !== sessionId;

function read(data) {
  let value = null;
  try {
    const fd = fs.openSync(path.join(data, FILE), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (stat.isFile() && stat.size <= MAX_BYTES) value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  } catch { /* Missing or unreadable: nothing to show. */ }
  const last = value?.schema === SCHEMA && value.last && typeof value.last === 'object' && typeof value.last.sessionId === 'string' ? value.last : null;
  const shown = Array.isArray(value?.shown) ? value.shown.filter(entry => typeof entry?.sha256 === 'string' && Number.isFinite(entry.at)) : [];
  return {last, shown};
}
function write(data, {last, shown}, now) {
  const file = path.join(data, FILE), temporary = `${file}.${process.pid}.${crypto.randomUUID()}`;
  // Only tips shown in the last day decide anything, so the list stays short.
  const recent = shown.filter(entry => now - entry.at < DAY && entry.at <= now).slice(-50);
  try { fs.writeFileSync(temporary, JSON.stringify({schema: SCHEMA, last, shown: recent}) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
// Every change to the file is a read and a write under this lock. It returns
// undefined when the lock stays busy past waitMs. It never creates the data
// directory, so a late detached process cannot bring back a removed one.
function locked(data, change, waitMs) {
  const lock = path.join(data, FILE + '.lock'), deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > STALE_LOCK_MS) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() >= deadline) return undefined;
      sleep(2);
    }
  }
  try { return change(); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}

// SessionEnd: record the session that ended, which supersedes any earlier
// session's tip, and start the detached process that reads its transcript.
// With quiet on, or without a transcript or ledger, nothing is read. Checking
// for the files is bounded metadata I/O; the hook opens no transcript or ledger.
function ended({sessionId, transcriptPath, data = dataDirectory(), home, now = Date.now(), spawnImpl = spawn} = {}) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) return false;
  let readable = typeof transcriptPath === 'string' && transcriptPath.length <= 4096 && path.isAbsolute(transcriptPath) && transcriptPath.endsWith('.jsonl');
  try { readable &&= fs.statSync(transcriptPath).isFile(); } catch { readable = false; }
  const computing = (readable || fs.existsSync(path.join(data, 'ledger', 'decisions.ndjson'))) && !quiet(home);
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const recorded = locked(data, () => {
    write(data, {...read(data), last: {sessionId, endedAt: now, state: computing ? 'computing' : 'none'}}, now);
    return true;
  }, 50);
  if (!recorded || !computing) return false;
  const child = spawnImpl(process.execPath, [__filename, sessionId, String(now), readable ? transcriptPath : ''], {detached: true, stdio: 'ignore', env: process.env});
  child.on('error', () => {});
  child.unref();
  return true;
}

// The detached process: the tip for the session SessionEnd recorded, stored
// unless a later session has ended since. Burn 0.3.20 has no sessionTip, so
// its sessions have no tip. A failure leaves the record computing, which
// shows nothing.
function compute({sessionId, endedAt, transcriptPath, data = dataDirectory(), home = burnHome(), sessionTip, tallyLine, now} = {}) {
  if (!sameJob(read(data).last, sessionId, endedAt)) return null;
  if (!sessionTip) {
    const burn = require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
    sessionTip = typeof burn.sessionTip === 'function' ? burn.sessionTip : () => null;
  }
  // The person already runs this plugin, so the fan-out tip must not point to it.
  const tip = usableTip(sessionTip(transcriptPath, {home, context: 'plugin'}));
  locked(data, () => {
    const state = read(data), computedAt = now ?? Date.now();
    if (sameJob(state.last, sessionId, endedAt)) write(data, {...state, last: {sessionId, endedAt, state: 'ready', tip, ...(usableTally(tallyLine) ? {tally: tallyLine} : {}), computedAt}}, computedAt);
  }, 2000);
  return tip;
}

// SessionStart: the one line, for a new session only, at most once per ended
// session, and never the same words twice within a day. Nothing to show costs
// one small read; a busy lock skips the tip rather than wait.
function take({sessionId, source, data = dataDirectory(), home, now = Date.now()} = {}) {
  if (source !== undefined && !NEW_SESSION.has(source)) return null;
  if (quiet(home) || !showable(read(data).last, sessionId)) return null;
  return locked(data, () => {
    const state = read(data), {last} = state;
    if (!showable(last, sessionId)) return null;
    const tally = usableTally(last.tally);
    const sha256 = digest(tally ? last.sessionId + tally + (last.tip || '') : last.tip);
    if (state.shown.some(entry => entry.sha256 === sha256 && now - entry.at < DAY && entry.at <= now)) return null;
    write(data, {last: {...last, state: 'shown', shownAt: now}, shown: [...state.shown, {sha256, at: now}]}, now);
    const tip = usableTip(last.tip)?.slice('Next: '.length);
    return LEAD + (tally && tip ? tally.replace(/\.$/, '') + '. ' + tip : tally || tip);
  }, 0) ?? null;
}

async function computeWithTally(options) {
  if (!sameJob(read(options.data || dataDirectory()).last, options.sessionId, options.endedAt)) return null;
  const burn = options.burn || require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
  let tallyLine;
  if (typeof burn.sessionTally === 'function') {
    try {
      // SessionEnd starts this detached task before the worker acknowledges
      // its signed summary. Give that bounded write time to finish off-hook.
      const deadline = Date.now() + 5000;
      let tally;
      do {
        tally = await burn.sessionTally(options.sessionId, {data: options.data || dataDirectory()});
        if (tally.status !== 'missing' || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 200));
        if (!sameJob(read(options.data || dataDirectory()).last, options.sessionId, options.endedAt)) return null;
      } while (true);
      // Older or transcript-only sessions can have a coaching tip without a
      // receipt ledger. Preserve that tip, and stay silent on a read failure.
      // Once a ledger exists, missing or invalid receipts must remain explicit.
      if (tally.status !== 'missing' || fs.existsSync(path.join(options.data || dataDirectory(), 'ledger', 'decisions.ndjson')))
        tallyLine = burn.renderSessionTally(tally);
    }
    catch { tallyLine = 'Receipt verification failed.'; }
  }
  const sessionTip = (...args) => {
    if (!options.transcriptPath || typeof burn.sessionTip !== 'function') return null;
    try { return burn.sessionTip(...args); } catch { return null; }
  };
  return compute({...options, sessionTip, tallyLine});
}
module.exports = {FILE, SCHEMA, LEAD, DAY, NEW_SESSION, ended, compute, computeWithTally, take, read};

if (require.main === module) {
  // Started by SessionEnd with the session id, the time it ended and its
  // transcript path. It runs below normal priority and exits when done.
  try { os.setPriority(0, 10); } catch {}
  const [sessionId, endedAt, transcriptPath] = process.argv.slice(2);
  computeWithTally({sessionId, endedAt: Number(endedAt), transcriptPath}).catch(() => {});
}
