'use strict';
// Optional Team counts transport. Importing this module never reads or uploads.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SCHEMA = 'agentguard.team-counts.v1';
const ENDPOINT = 'https://agentguard.run/api/team/counts';
const FIELDS = ['launches', 'allowed', 'asked', 'saidYes', 'stopped', 'shadow', 'unrecorded', 'unresolvedAsked'];
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function settings(data) {
  try { return {enabled: JSON.parse(fs.readFileSync(path.join(data, 'team-counts.json'), 'utf8'))?.enabled === true}; } catch { return {enabled: false}; }
}
function setEnabled(data, enabled) {
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const file = path.join(data, 'team-counts.json'), tmp = file + '.' + crypto.randomUUID();
  fs.writeFileSync(tmp, JSON.stringify({enabled: enabled === true}) + '\n', {mode: 0o600, flag: 'wx'});
  fs.renameSync(tmp, file);
  return {enabled: enabled === true};
}
function dailyPayload(tallies, date, seatId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date || !/^[a-f0-9]{64}$/.test(seatId)) throw new Error('Daily count identity is invalid.');
  // Never upload a partial aggregate. Missing sessions require receipt recovery.
  if (tallies.some(t => t.status !== 'verified')) throw new Error('Daily counts require complete verified session receipts.');
  const rows = tallies.filter(t => t.date === date);
  if (!rows.length) return null;
  const counts = Object.fromEntries(FIELDS.map(k => [k, 0]));
  let tokens = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.tokens) || row.tokens < 0) throw new Error('Signed token totals are missing.');
    tokens += row.tokens;
    for (const key of FIELDS) {
      if (!Number.isSafeInteger(row.counts?.[key]) || row.counts[key] < 0) throw new Error('Signed tally counts are missing.');
      counts[key] += row.counts[key];
    }
  }
  if (![tokens, ...Object.values(counts)].every(n => Number.isSafeInteger(n) && n <= 1e12)) throw new Error('Daily counts exceed the supported range.');
  if (counts.launches !== counts.allowed + counts.asked + counts.stopped + counts.shadow + counts.unrecorded || counts.asked !== counts.saidYes + counts.unresolvedAsked) throw new Error('Daily counts do not reconcile.');
  return {schema: SCHEMA, date, seatId, counts, tokens};
}
function signPayload(payload, seed) {
  if (!/^[a-f0-9]{64}$/i.test(seed)) throw new Error('Receipt signing key is unavailable.');
  const key = crypto.createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]), type: 'pkcs8', format: 'der'});
  const publicKey = crypto.createPublicKey(key).export({type: 'spki', format: 'der'}).subarray(-32).toString('hex');
  return {payload, publicKey, signature: crypto.sign(null, Buffer.from(canonical(payload)), key).toString('hex')};
}
async function syncDailyCounts({data, home, sessionId, policy, date, now = Date.now(), transport = fetch, burn, licenseReader, featureEnabled = process.env.AGENTGUARD_TEAM_COUNTS === '1'} = {}) {
  data ||= require('./common.cjs').locations().data;
  if (!featureEnabled || settings(data).enabled !== true) return {status: 'off'};
  policy ||= require('./policy-file.cjs').readPolicy(data).personal;
  const license = require('./license.cjs');
  const key = license.configuredKey(policy);
  const status = (licenseReader || license.readSessionLicense)({data, sessionId, policy, now});
  if (!key || !status?.paid || !['startup', 'startup_pro', 'growth', 'growth_pro'].includes(status.tier)
      || status.offlineGrace || status.seatRevoked || status.reason || status.seatStatus !== 'registered'
      || (status.expiresAt && !(Date.parse(status.expiresAt) > now))) return {status: 'license_required'};
  const fingerprint = status.seatIdentity?.machineFingerprint;
  if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) return {status: 'seat_required'};
  date ||= new Date(now - 86400000).toISOString().slice(0, 10);
  if (date >= new Date(now).toISOString().slice(0, 10)) throw new Error('Only completed UTC days can sync.');
  burn ||= require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
  if (typeof burn.readLedgerTallies !== 'function') return {status: 'burn_update_required'};
  home ||= process.env.AGENTGUARD_HOME || path.join(require('node:os').homedir(), '.agentguard');
  const seatId = digest(key + '\0' + fingerprint), directory = path.join(home, 'team-counts', seatId);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const lock = path.join(directory, 'sync.lock');
  try { fs.writeFileSync(lock, String(process.pid), {flag: 'wx', mode: 0o600}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) return {status: 'busy'};
    try { process.kill(pid, 0); return {status: 'busy'}; }
    catch (e) { if (e.code !== 'ESRCH') return {status: 'busy'}; }
    try { fs.unlinkSync(lock); } catch {}
    return {status: 'retry'};
  }
  try {
    const directories = [...new Set([data, ...(burn.pluginLedgerDirectories?.(home) ?? [])].map(d => path.resolve(d)))].sort();
    const rows = [];
    for (const candidate of directories) {
      if (!settings(candidate).enabled) continue;
      const sourcePolicy = path.resolve(candidate) === path.resolve(data) ? policy : require('./policy-file.cjs').readPolicy(candidate).personal;
      if (license.configuredKey(sourcePolicy) !== key) continue;
      rows.push(...await (burn.readLedgerDailyTallies ?? burn.readLedgerTallies)(candidate));
    }
    const unique = new Map();
    for (const row of rows) {
      const id = row.host + ':' + row.session + ':' + row.date;
      if (unique.has(id) && canonical(unique.get(id)) !== canonical(row)) return {status: 'overlapping_sessions'};
      unique.set(id, row);
    }
    const payload = dailyPayload([...unique.values()], date, seatId);
    if (!payload) return {status: 'no_receipts'};
    // Pin one existing receipt signer for this machine and license. Other
    // installations verify their own chains but never replace this signer.
    const ownerFile = path.join(directory, 'owner.json');
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      owner = {data: path.resolve(data), publicKey: fs.readFileSync(path.join(data, 'public-key.hex'), 'utf8').trim()};
      fs.writeFileSync(ownerFile, JSON.stringify(owner) + '\n', {flag: 'wx', mode: 0o600});
    }
    const seed = fs.readFileSync(path.join(owner.data, 'signing-key.hex'), 'utf8').trim();
    const envelope = signPayload(payload, seed);
    if (envelope.publicKey !== owner.publicKey) throw new Error('Machine counts signer changed.');
    const sentFile = path.join(directory, date + '.json'), payloadDigest = digest(canonical(payload));
    if (fs.existsSync(sentFile)) {
      const sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
      return {status: sent.payloadDigest === payloadDigest ? 'already_synced' : 'changed_after_sync', date};
    }
    // Only this allowlisted aggregate leaves. No ledger rows or paths leave.
    const response = await transport(ENDPOINT, {method: 'POST', headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'}, body: JSON.stringify(envelope), signal: AbortSignal.timeout(5000), redirect: 'error'});
    if (!response.ok) return {status: 'upload_failed', httpStatus: response.status};
    fs.writeFileSync(sentFile, JSON.stringify({payloadDigest, publicKey: envelope.publicKey}) + '\n', {mode: 0o600});
    return {status: 'synced', date};
  } finally { try { fs.unlinkSync(lock); } catch {} }
}
// Used only by the detached worker. The hook reply is already published and
// all receipt writes must be durable before a sync can inspect their chains.
class DailyCountsScheduler {
  constructor({data, home, flush = async () => {}, sync = syncDailyCounts, now = Date.now} = {}) {
    Object.assign(this, {data, home, flush, sync, now}); this.due = 0; this.running = false;
  }
  completed(sessionId) { this.sessionId = sessionId; this.due = 0; }
  async tick() {
    if (!this.sessionId || this.running || this.now() < this.due) return;
    this.running = true; this.due = this.now() + 60000;
    try {
      await this.flush();
      return await this.sync({data: this.data, home: this.home, sessionId: this.sessionId, now: this.now()});
    } catch { return {status: 'unavailable'}; }
    finally { this.running = false; }
  }
}
module.exports = {SCHEMA, FIELDS, canonical, settings, setEnabled, dailyPayload, signPayload, syncDailyCounts, DailyCountsScheduler};
if (require.main === module) {
  const [command, sessionId, date] = process.argv.slice(2), data = require('./common.cjs').locations().data;
  const run = async () => {
    if (command === 'on' || command === 'off') return setEnabled(data, command === 'on');
    if (command === 'status') return settings(data);
    if (command === 'sync' && sessionId) return syncDailyCounts({data, sessionId, date});
    throw new Error('Use counts-sync.cjs on, off, status, or sync SESSION DATE.');
  };
  run().then(r => process.stdout.write(JSON.stringify(r) + '\n')).catch(() => {process.stderr.write('AgentGuard daily counts unavailable. Check local receipts and Team access.\n'); process.exitCode = 1;});
}
