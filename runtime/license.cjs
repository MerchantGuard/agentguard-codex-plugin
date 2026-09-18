'use strict';

// Network resolution belongs to session startup or explicit activation. Hooks
// call readSessionLicense only, which reads a content-free local snapshot.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 2000;
const SCHEMA = 'agentguard.plugin.license.v1';
const PAID_TIERS = new Set(['solo', 'startup', 'growth', 'solo_pro', 'startup_pro', 'growth_pro']);
const pending = new Map();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const nowOf = now => typeof now === 'function' ? now() : (now ?? Date.now());
const home = () => path.resolve(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'));

function configuredKey(policy = {}) {
  const value = process.env.AGENTGUARD_LICENSE_KEY?.trim() || policy.licenseKey;
  return typeof value === 'string' ? value.trim() : '';
}
function identity({data, sessionId, policy}) {
  const key = configuredKey(policy);
  const sessionFingerprint = digest(String(sessionId || 'unknown'));
  const keyFingerprint = key ? digest(key) : null;
  const directory = path.join(path.resolve(data), 'license-status', 'sessions');
  return {key, keyFingerprint, sessionFingerprint, directory,
    file: path.join(directory, `${sessionFingerprint}-${keyFingerprint || 'free'}.json`)};
}
function licenseStatusPath(options) { return identity(options).file; }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function expiry(status) {
  if (status.expiresAt === null || status.expiresAt === undefined) return null;
  return typeof status.expiresAt === 'string' && Number.isFinite(Date.parse(status.expiresAt))
    ? Date.parse(status.expiresAt) : NaN;
}
function eligible(status, now, grace = false) {
  if (!status || status.valid !== true || !PAID_TIERS.has(status.tier)) return false;
  const at = expiry(status);
  return at === null || (Number.isFinite(at) && now < at + (grace ? GRACE_MS : 0));
}
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function limits(status) {
  return count(status?.features?.maxActiveSeats) ?? count(status?.seats)
    ?? (String(status?.tier).startsWith('growth') ? 50 : String(status?.tier).startsWith('startup') ? 5 : 1);
}
function snapshot(id, status, now, values = {}) {
  const at = status ? expiry(status) : null;
  return {schema: SCHEMA, sessionFingerprint: id.sessionFingerprint, keyFingerprint: id.keyFingerprint,
    paid: false, mode: 'shadow', reason: 'license_required', tier: PAID_TIERS.has(status?.tier) ? status.tier : 'free',
    seatsUsed: null, seatLimit: limits(status), expiresAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
    graceUntil: Number.isFinite(at) ? new Date(at + GRACE_MS).toISOString() : null,
    offlineGrace: false, source: 'missing', refreshedAt: new Date(now).toISOString(), ...values};
}
function matchStatus(value, id) {
  return value?.schema === SCHEMA && value.sessionFingerprint === id.sessionFingerprint
    && value.keyFingerprint === id.keyFingerprint;
}
function effective(value, now) {
  if (!value.paid || !PAID_TIERS.has(value.tier)) return {...value, paid: false, mode: 'shadow'};
  const at = expiry(value);
  if (Number.isNaN(at) || (at !== null && now >= at + GRACE_MS)) {
    return {...value, paid: false, mode: 'shadow', reason: 'license_required', offlineGrace: false};
  }
  return {...value, mode: 'enforce', reason: null, offlineGrace: at !== null && now >= at};
}
function writeStatus(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(temporary, file);
}
function readSessionLicense(options) {
  const id = identity(options);
  const now = nowOf(options.now);
  const value = readJson(id.file);
  if (matchStatus(value, id) && value.source !== 'resolving') return effective(value, now);
  // Session startup resolves remotely outside hooks. A previously validated
  // paid customer retains cached access while that detached refresh starts.
  const cached = id.key ? cachedStatus(id) : null;
  if (eligible(cached, now, true)) {
    const at = expiry(cached);
    return snapshot(id, cached, now, {paid: true, mode: 'enforce', reason: null,
      source: value?.source === 'resolving' ? 'cached_pending' : 'offline_cache',
      offlineGrace: at !== null && now >= at, seatStatus: 'unknown'});
  }
  return snapshot(id, null, now, {source: id.key ? 'unresolved' : 'missing'});
}
// This helper is for status display only. It must not authorize an export or
// tool in a different session using the most recently opened session's seat.
function readLatestLicenseStatus(options) {
  const id = identity(options);
  let files;
  try { files = fs.readdirSync(id.directory); } catch { return readSessionLicense(options); }
  const suffix = `-${id.keyFingerprint || 'free'}.json`;
  const values = files.filter(file => /^[a-f0-9]{64}-(?:[a-f0-9]{64}|free)\.json$/.test(file) && file.endsWith(suffix))
    .map(file => readJson(path.join(id.directory, file)))
    .filter(value => value?.schema === SCHEMA && value.keyFingerprint === id.keyFingerprint && value.source !== 'resolving' && Number.isFinite(Date.parse(value.refreshedAt)))
    .sort((a, b) => Date.parse(b.refreshedAt) - Date.parse(a.refreshedAt));
  return values.length ? effective(values[0], nowOf(options.now)) : readSessionLicense(options);
}

function cachedStatus(id) {
  return readJson(path.join(home(), `license-${id.keyFingerprint}.json`))?.status || null;
}

async function httpPostJson(url, payload, {signal}) {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify(payload), signal, redirect: 'error'});
  if (!response.ok) throw new Error('License service unavailable.');
  return response.json();
}

async function refresh(options, id) {
  const now = nowOf(options.now);
  const cached = cachedStatus(id);
  let status = null;
  let source = 'remote';
  let seat = null;
  let seatFailure = false;
  const controller = new AbortController();
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  const aborted = new Promise((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('License refresh timed out.')), {once: true});
  });
  // The same deadline covers validation and seat registration, including a
  // transport that is injected by an embedding runtime or test.
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  const transport = async (url, payload) => {
    if (controller.signal.aborted || Date.now() >= deadline) throw new Error('License refresh timed out.');
    return Promise.race([Promise.resolve().then(() => (options.postJson || httpPostJson)(url, payload,
      {signal: controller.signal, deadline})), aborted]);
  };
  try {
    const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
    try {
      status = await sdk.validateLicenseKey(id.key, {home: home(), nowMs: now, force: true, postJson: transport});
    } catch {
      status = cached;
      source = 'offline_cache';
    }
    const paid = eligible(status, now, source === 'offline_cache');
    if (!paid) return snapshot(id, status, now, {source});
    // The SDK provides the existing installation identity and seat protocol.
    // Its validation callback reuses this session's result, so only one actual
    // validation request is made and cached paid seats are still registered.
    try {
      await sdk.validateAndRegisterLicense(id.key, {home: home(), nowMs: now, force: true,
        postJson: async (url, payload) => {
          if (new URL(url).pathname === '/api/license/validate') return status;
          try { seat = await transport(url, payload); return seat; }
          catch (error) { seatFailure = true; throw error; }
        }});
    } catch {
      if (!seat || seat.ok !== false) seatFailure = true;
    }
    if (seat?.ok !== true || count(seat?.activeSeats) === null || count(seat?.maxActiveSeats) === null) seatFailure = true;
    const seatLimit = count(seat?.maxActiveSeats) ?? limits(status);
    const seatsUsed = count(seat?.activeSeats);
    const overLimit = seat?.ok === false || (seatsUsed !== null && seatsUsed > seatLimit);
    const at = expiry(status);
    return snapshot(id, status, now, {paid: !overLimit, mode: overLimit ? 'shadow' : 'enforce',
      reason: overLimit ? (seat?.error === 'license_not_found' ? 'license_required' : 'seat_limit') : null,
      seatsUsed, seatLimit, source, offlineGrace: at !== null && now >= at,
      seatStatus: overLimit ? 'denied' : seatFailure ? 'unavailable' : 'registered'});
  } catch {
    return snapshot(id, null, now, {source: 'unavailable'});
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Suppress the deliberately rejected timeout promise after a successful
    // refresh, while leaving all in-flight transports subject to the deadline.
    aborted.catch(() => {});
  }
}

async function resolveSessionLicense(options) {
  const id = identity(options);
  const now = nowOf(options.now);
  const existing = readJson(id.file);
  if (!options.forceActivation && matchStatus(existing, id) && existing.source !== 'resolving') return effective(existing, now);
  if (pending.has(id.file)) return pending.get(id.file);
  const work = (async () => {
    if (!id.key) {
      const free = snapshot(id, null, now);
      writeStatus(id.file, free);
      return free;
    }
    fs.mkdirSync(id.directory, {recursive: true, mode: 0o700});
    const claim = `${id.file}.claim`;
    if (options.forceActivation) {
      // Explicit activation is the sole operator-triggered retry in a session.
      try { fs.unlinkSync(claim); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let fd;
    try { fd = fs.openSync(claim, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Another startup process owns this session's attempt. A claim survives
      // crashes so a broken startup cannot cause a validation retry storm.
      const until = Date.now() + REFRESH_TIMEOUT_MS + 100;
      while (Date.now() < until) {
        const value = readJson(id.file);
        if (matchStatus(value, id) && value.source !== 'resolving') return effective(value, nowOf(options.now));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return readSessionLicense(options);
    }
    fs.closeSync(fd);
    writeStatus(id.file, snapshot(id, null, now, {source: 'resolving'}));
    const value = await refresh(options, id);
    writeStatus(id.file, value);
    return effective(value, nowOf(options.now));
  })();
  pending.set(id.file, work);
  try { return await work; } finally { pending.delete(id.file); }
}

module.exports = {resolveSessionLicense, readSessionLicense, readLatestLicenseStatus, licenseStatusPath, configuredKey,
  GRACE_MS, REFRESH_TIMEOUT_MS, PAID_TIERS};
