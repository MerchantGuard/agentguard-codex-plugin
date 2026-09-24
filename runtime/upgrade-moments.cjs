'use strict';
// Local display preferences only. No requests, metrics or decision changes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash, randomUUID} = require('node:crypto');
const TEAM_LINE = 'Using this at work? Team puts one policy on every seat. agentguard.run/pricing';
const SCORE_LINE = 'Free AgentGuard Score: if your agent moves money, five questions check the basics (accountable human, wallet, limits, audit trail) and tell you what to fix. Ask for the agentguard-score skill.';
// One announcement per plugin version. A version without an entry announces
// nothing and burns no claim, so a stale line can never ship with a new version.
const WHATS_NEW = {
  '0.3.6': "What's new in AgentGuard 0.3.6: local policy presets, command rules, inbox protection and Solo policy sync. Run node runtime/policy-cli.cjs show to inspect your policy.",
  '0.3.7': "What's new in AgentGuard 0.3.7: the free AgentGuard Score, five questions on whether your agent has the basic payment controls. Ask for the agentguard-score skill. Run node runtime/policy-cli.cjs show to inspect your policy.",
  '0.3.8': "What's new in AgentGuard 0.3.8: the free AgentGuard Score now scores four payment controls and names exactly where your answers go. Ask for the agentguard-score skill. Run node runtime/policy-cli.cjs show to inspect your policy.",
  '0.3.9': "What's new in AgentGuard 0.3.9: after your AgentGuard Score, open the full visual report in your browser straight from the terminal. Ask for the agentguard-score skill. Run node runtime/policy-cli.cjs show to inspect your policy.",
};
const WEEK = 7 * 86400000;
const homeDirectory = () => path.resolve(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'));
const directory = home => path.join(home || homeDirectory(), 'upgrade-moments');
function quiet(home) { return fs.existsSync(path.join(directory(home), 'quiet')); }
function dismiss(home) {
  fs.mkdirSync(directory(home), {recursive: true, mode: 0o700});
  try { fs.writeFileSync(path.join(directory(home), 'quiet'), '1\n', {flag: 'wx', mode: 0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
function claim(name, {home, now = Date.now(), interval} = {}) {
  if (quiet(home)) return false;
  const dir = directory(home), file = path.join(dir, name), lock = file + '.lock';
  let owned = false;
  try {
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      // A lock left by a process that died mid-claim must not silence the
      // moment forever. One minute is far longer than any claim takes.
      if (error.code !== 'EEXIST' || now - fs.statSync(lock).mtimeMs < 60000) throw error;
      fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx', 0o600);
    }
    fs.closeSync(fd); owned = true;
    let previous;
    try { previous = Number(fs.readFileSync(file, 'utf8').trim()); } catch {}
    if (previous !== undefined && (!interval || !Number.isFinite(previous) || now - previous < interval)) return false;
    // A failed persistence operation suppresses copy rather than risking spam.
    const temporary = file + '.' + randomUUID();
    try { fs.writeFileSync(temporary, String(now) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
    return !quiet(home);
  } catch { return false; }
  finally { if (owned) { try { fs.unlinkSync(lock); } catch {} } }
}
function stopMoment(output, license, options = {}) {
  if (output?.hookSpecificOutput?.permissionDecision !== 'deny' || license?.paid || license?.tier !== 'free' || license?.mode !== 'enforce' || license?.reason) return output;
  if (!claim('free-stop', {...options, interval: WEEK})) return output;
  return {...output, systemMessage: [output.systemMessage, TEAM_LINE].filter(Boolean).join('\n')};
}
function whatsNew(version, options = {}) {
  if (!/^[A-Za-z0-9.+_-]{1,80}$/.test(version) || !Object.hasOwn(WHATS_NEW, version) || !claim('plugin-version-' + version, options)) return null;
  return WHATS_NEW[version];
}
// One informational line per install (one AgentGuard home) inviting the free
// AgentGuard Score. Display copy only: no request, no decision change, and
// Quiet removes it.
function scoreInvite(options = {}) {
  return claim('agent-score-invite', options) ? SCORE_LINE : null;
}
function registerLedger(data, home = homeDirectory()) {
  // Burn status can find both hosts without copying any ledger content.
  try {
    const dir = path.join(home, 'plugin-ledgers'); fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const file = path.join(dir, createHash('sha256').update(path.resolve(data)).digest('hex') + '.json');
    if (fs.existsSync(file)) return;
    const temporary = file + '.' + randomUUID();
    try { fs.writeFileSync(temporary, JSON.stringify({data: path.resolve(data)}) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  } catch { /* Discoverability cannot change a decision. */ }
}
module.exports = {TEAM_LINE, SCORE_LINE, WHATS_NEW, WEEK, quiet, dismiss, claim, stopMoment, whatsNew, scoreInvite, registerLedger, homeDirectory};
