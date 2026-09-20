'use strict';
// Imported by the detached worker only. The policy engine reads cache files.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {validateEnvelope} = require('./org-policy-contract.cjs');
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
      if (response?.status === 204) {
        // A last good copy can remain on disk; status 'none' unbinds it.
        state = {license_fingerprint, status: 'none', reason: null, org_policy_sha256: null, updated_at};
      } else {
        if (response?.status !== 200 || validateEnvelope(response.body).length) throw new Error('org_policy_invalid');
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
module.exports = {refreshOrgPolicy, ENDPOINT};
