'use strict';
// Local display preferences only. No requests, metrics or decision changes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash, randomUUID} = require('node:crypto');
const TEAM_LINE = 'Using this at work? Team puts one policy on every seat. agentguard.run/pricing';
const SOLO_LINE = 'Refused and signed on this machine. Free stays fully enforced here. Solo runs this same policy on up to three machines and exports these signed receipts: $19 a month, agentguard.run/pricing. Dismiss for good with quiet on.';
const SCORE_LINE = 'Free AgentGuard Score: if your agent moves money, five questions check the basics (accountable human, wallet, limits, audit trail) and tell you what to fix. Ask for the agentguard-score skill.';
// Once per machine. Claude Code holds a launch past a limit behind its own
// permission prompt; Codex has no prompt, so there the launch is refused until
// the person runs Burn's resume. Commands after ! run in the person's shell.
// "Your sessions stay on this machine" holds for every tier: a paid license
// check leaves the machine, but no session content ever does.
const FIRST_RUN_LINE = 'AgentGuard is on. If a session passes 15 sub-agents in 15 active minutes, 40 in 120, or 5B tokens, the next launch waits for your yes. Your sessions stay on this machine. See where a session went: ! npx agentguard-burn why';
const FIRST_RUN_CODEX_LINE = 'AgentGuard is on. If a session passes 15 sub-agents in 15 active minutes, 40 in 120, or 5B tokens, the next launch is refused until you allow it. Your sessions stay on this machine. See where a session went: ! npx agentguard-burn why';
// One announcement per plugin version. A version without an entry announces
// nothing and burns no claim, so a stale line can never ship with a new version.
const WHATS_NEW = {
  '0.3.6': "What's new in AgentGuard 0.3.6: local policy presets, command rules, inbox protection and Solo policy sync. Run node runtime/policy-cli.cjs show to inspect your policy.",
  '0.3.7': "What's new in AgentGuard 0.3.7: the free AgentGuard Score, five questions on whether your agent has the basic payment controls. Ask for the agentguard-score skill. Run node runtime/policy-cli.cjs show to inspect your policy.",
  '0.3.8': "What's new in AgentGuard 0.3.8: the free AgentGuard Score now scores four payment controls and names exactly where your answers go. Ask for the agentguard-score skill. Run node runtime/policy-cli.cjs show to inspect your policy.",
  '0.3.9': "What's new in AgentGuard 0.3.9: after your AgentGuard Score, open the full visual report in your browser straight from the terminal. Ask for the agentguard-score skill. Run node runtime/policy-cli.cjs show to inspect your policy.",
  '0.3.10': "What's new in AgentGuard 0.3.10: say yes once and your full AgentGuard Score report opens in the browser the moment the score is ready. Ask for the agentguard-score skill. Run node runtime/policy-cli.cjs show to inspect your policy.",
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
  return {...output, systemMessage: [output.systemMessage, SOLO_LINE].filter(Boolean).join('\n')};
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
// The first-run line describes enforcement, so it waits (unclaimed) while this
// machine is in shadow; quiet removes it like every other moment.
function firstRun({host, enforcing = true, ...options} = {}) {
  if (!enforcing || !claim('first-run', options)) return null;
  return host === 'codex' ? FIRST_RUN_CODEX_LINE : FIRST_RUN_LINE;
}
// A path the person can paste into a shell: double quotes for ordinary paths,
// single quotes (with any single quote escaped) for anything else.
function shellPath(value) {
  return /^[A-Za-z0-9_@%+=:,./ -]+$/.test(value) ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}
// The preset hint names a command the person can paste. ! runs it in their own
// shell, which does not carry the plugin's data variable, so the command names
// the data directory the hooks use along with the plugin's absolute path.
function presetHint({root, data, host}) {
  const variable = data ? `${host === 'claude-code' ? 'CLAUDE_PLUGIN_DATA' : 'PLUGIN_DATA'}=${shellPath(path.resolve(data))} ` : '';
  return `AgentGuard presets: solo-dev, careful and strict. No key or network is needed. Apply one by typing: ! ${variable}node ${shellPath(path.join(path.resolve(root), 'runtime', 'policy-cli.cjs'))} preset careful`;
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
module.exports = {TEAM_LINE, SOLO_LINE, SCORE_LINE, FIRST_RUN_LINE, FIRST_RUN_CODEX_LINE, WHATS_NEW, WEEK, quiet, dismiss, claim, stopMoment, whatsNew, scoreInvite, firstRun, presetHint, shellPath, registerLedger, homeDirectory};
