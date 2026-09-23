'use strict';
// Imported by the detached worker only. The policy engine reads cache files.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {validateEnvelope, hashPolicy} = require('./org-policy-contract.cjs');
const ENDPOINT = 'https://agentguard.run/api/org/policy';
const pending = new Map();
const fingerprint = key => createHash('sha256').update(key).digest('hex');
function write(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${randomUUID()}`;
  try { fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
async function fetchPolicy(url, {key, signal}) {
  const response = await fetch(url, {method: 'GET', headers: {authorization: `Bearer ${key}`}, signal, redirect: 'error'});
  return {status: response.status, ...(response.status === 200 ? {body: await response.json()} : {})};
}
async function refreshOrgPolicy({data, policy = {}, now = Date.now(), getPolicy = fetchPolicy}) {
  const key = require('./license.cjs').configuredKey(policy);
  if (!key) return {status: 'none', reason: null, org_policy_sha256: null};
  const license_fingerprint = fingerprint(key), statusFile = path.join(data, 'org-policy-status.json');
  const id = `${path.resolve(data)}:${license_fingerprint}`;
  if (pending.has(id)) return pending.get(id);
  const work = (async () => {
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('org_policy_timeout')); }, 2000);
    });
    const updated_at = new Date(typeof now === 'function' ? now() : now).toISOString();
    let state;
    try {
      const response = await Promise.race([Promise.resolve().then(() => getPolicy(ENDPOINT, {key, signal: controller.signal})), timeout]);
      let previous = null;
      try { previous = JSON.parse(fs.readFileSync(statusFile, 'utf8')); if (previous?.license_fingerprint !== license_fingerprint) previous = null; } catch { previous = null; }
      if (response?.status === 204) {
        // With no policy ever loaded, 204 means none. After a ready snapshot a
        // 204 (a deleted policy, or a store miss) withdraws to shadow with a
        // reason and keeps the envelope; the org publishes again to unbind.
        state = previous?.status === 'ready' && previous.org_policy_sha256
          ? {license_fingerprint, status: 'shadow', reason: 'org_policy_withdrawn', org_policy_sha256: previous.org_policy_sha256, updated_at}
          : {license_fingerprint, status: 'none', reason: null, org_policy_sha256: null, updated_at};
      } else {
        if (response?.status !== 200 || validateEnvelope(response.body).length) throw new Error('org_policy_invalid');
        // A published_at ahead of this clock by more than five minutes is not a
        // policy this machine can order; a different hash than the retained
        // envelope without a higher version is a replay or a silent swap.
        const publishedAt = Date.parse(response.body.published_at);
        if (!Number.isFinite(publishedAt) || publishedAt > Date.parse(updated_at) + 300000) throw new Error('org_policy_invalid');
        let retained = null;
        try { retained = JSON.parse(fs.readFileSync(path.join(data, 'org-policy.json'), 'utf8')); } catch { retained = null; }
        if (previous?.status === 'ready' && retained?.license_fingerprint === license_fingerprint && retained.sha256 !== response.body.sha256
          && Number.isSafeInteger(retained.version) && Number.isSafeInteger(response.body.version) && response.body.version <= retained.version) throw new Error('org_policy_invalid');
        // Separate metadata binds this immutable envelope to this license.
        write(path.join(data, 'org-policy.json'), {...response.body, license_fingerprint});
        state = {license_fingerprint, status: 'ready', reason: null, org_policy_sha256: response.body.sha256, updated_at};
      }
    } catch {
      // Never replace or delete the cached envelope on a failed refresh.
      let previous;
      try { previous = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
      state = {license_fingerprint, status: 'shadow', reason: 'org_policy_unavailable',
        org_policy_sha256: previous?.license_fingerprint === license_fingerprint ? previous.org_policy_sha256 ?? null : null, updated_at};
    } finally { clearTimeout(timer); controller.abort(); }
    write(statusFile, state);
    return state;
  })();
  pending.set(id, work);
  try { return await work; } finally { pending.delete(id); }
}
async function putPolicy(url, {key, policy, signal}) {
  const response = await fetch(url, {method: 'PUT', headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'}, body: JSON.stringify({policy}), signal, redirect: 'error'});
  return {status: response.status, ...(response.status === 200 ? {body: await response.json()} : {})};
}
// Writes a sync failure for this key so the hook and the worker read one state.
// The cached envelope stays on disk; a shadow status unbinds it for Solo.
function recordSyncFailure(data, policy = {}, reason = 'org_policy_unavailable') {
  const key = require('./license.cjs').configuredKey(policy);
  if (!key) return null;
  const license_fingerprint = fingerprint(key), statusFile = path.join(data, 'org-policy-status.json');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
  const state = {license_fingerprint, status: 'shadow', reason, org_policy_sha256: previous?.license_fingerprint === license_fingerprint ? previous.org_policy_sha256 ?? null : null, updated_at: new Date().toISOString()};
  write(statusFile, state);
  return state;
}
// The license is read from the cached session status, never resolved over the
// network here, so a push cannot register a seat for a synthetic session. The
// server is the authority for whether the key may publish.
async function pushPersonalPolicy({data, sessionId, put = putPolicy, resolveLicense = options => require('./license.cjs').readSessionLicense(options)}) {
  const {localPolicy, policyConfig, UPSELL} = require('./policy-cli.cjs');
  const local = localPolicy(data), key = require('./license.cjs').configuredKey(local);
  if (!key) return {error: UPSELL, syncFailed: false};
  const policy = policyConfig(local);
  const license = await resolveLicense({data, sessionId, policy: local, personalPolicy: local});
  // A refusal here attempted no upload, so it is not a sync failure.
  if (!require('./org-policy.cjs').soloEnabled(license) || license.mode === 'shadow') return {error: license.paid ? 'Personal policy sync requires an active Solo key. Team policies are managed in the dashboard.' : UPSELL, syncFailed: false};
  const license_fingerprint = fingerprint(key), id = `${path.resolve(data)}:${license_fingerprint}`;
  // A slow GET cannot overwrite a newly pushed snapshot.
  while (pending.has(id)) { try { await pending.get(id); } catch {} }
  const work = (async () => {
    const controller = new AbortController(); let timer;
    const updated_at = new Date().toISOString();
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('policy_sync_timeout')); }, 2000); });
      const response = await Promise.race([Promise.resolve().then(() => put(ENDPOINT, {key, policy, signal: controller.signal})), timeout]);
      if (response?.status !== 200 || validateEnvelope(response.body).length || response.body.sha256 !== hashPolicy(policy)) throw new Error('policy_sync_invalid');
      write(path.join(data, 'org-policy.json'), {...response.body, license_fingerprint});
      const state = {license_fingerprint, status: 'ready', reason: null, org_policy_sha256: response.body.sha256, updated_at};
      write(path.join(data, 'org-policy-status.json'), state);
      return {...state, version: response.body.version, sha256: response.body.sha256, syncFailed: false};
    } catch {
      try { recordSyncFailure(data, local); } catch {}
      return {error: 'Policy sync unavailable. Local policy is unchanged.', syncFailed: true};
    } finally { clearTimeout(timer); controller.abort(); }
  })();
  pending.set(id, work);
  try { return await work; } finally { pending.delete(id); }
}
module.exports = {refreshOrgPolicy, pushPersonalPolicy, recordSyncFailure, ENDPOINT};
