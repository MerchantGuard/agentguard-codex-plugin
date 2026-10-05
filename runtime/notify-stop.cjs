'use strict';
// Desktop notification for an enforced STOP, macOS only. Plain words, the right next step for the kind of
// stop, at most one every ten minutes, and the person's Mute or Turn off choice is honored. When the
// AgentGuard notifier app is built (runtime/notifier), it shows the alert with our icon and the buttons;
// otherwise AppleScript shows a plain one and a build starts in the background. The text is argv data,
// never AppleScript or shell source, and it carries no tool input.
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const notifier = require('./notifier/build.cjs');

const COOLDOWN_MS = 10 * 60 * 1000;
const STATE_FILE = 'notify-state.json';
const SCRIPT = 'on run argv\n display notification (item 1 of argv) with title (item 2 of argv)\nend run';
const RESUME = 'To let this one launch, type: ! npx agentguard-burn resume --once --reason "why"';
// Burn's detectors stop sub-agent launches. The value is the reason in plain words.
const BURN = {
  spawn_rate: 'Sub-agents started too fast',
  fanout: 'Too many sub-agents at once',
  sustained_burn: 'Token use stayed high for too long',
  burn_debt: 'Earlier sub-agents left a token debt',
  duplicate_work: 'The same work was started twice',
  local_compute: 'The local compute limit was reached',
  account: 'The plan allowance is almost used up',
};
const CAPS = {per_day: 'Daily spend cap reached', per_hour: 'Hourly spend cap reached', per_session: 'Session spend cap reached', per_week: 'Weekly spend cap reached', per_month: 'Monthly spend cap reached'};

// What the notification says, from the rule ids and the engine's one-line summary.
function compose(ids, summary, skipped) {
  // The guard pack's message starts with "AgentGuard STOP <ids>:"; the notification already says that.
  const clean = text => String(text ?? '').replace(/^AgentGuard STOP[^:]*:\s*/, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 200);
  const burn = ids.find(id => BURN[id]);
  const cap = ids.find(id => id.startsWith('cap:'));
  let title, subtitle, next;
  if (burn) {
    title = 'AgentGuard stopped a sub-agent launch'; subtitle = BURN[burn]; next = RESUME;
  } else if (cap) {
    title = 'AgentGuard stopped a tool call';
    subtitle = CAPS[cap.slice(4)] ?? `Spend cap reached (${cap.slice(4)})`;
    next = 'Raise the cap in your AgentGuard policy, or wait for it to reset.';
  } else {
    title = 'AgentGuard stopped a tool call';
    subtitle = clean(summary) || (ids.some(id => /^GP\d/.test(id)) ? 'A safety rule stopped it' : 'A policy rule stopped it');
    next = 'If that was intended, change the rule in your AgentGuard policy.';
  }
  const detail = burn && clean(summary) ? clean(summary) + '. ' : '';
  const more = skipped > 0 ? ` ${skipped} more stop${skipped === 1 ? '' : 's'} since the last alert.` : '';
  return {title, subtitle, body: `${detail}Details are in your terminal. ${next}${more}`};
}

function readState(file) {
  try { const state = JSON.parse(fs.readFileSync(file, 'utf8')); return state && typeof state === 'object' ? state : {}; }
  catch { return {}; }
}
function writeState(file, state) {
  try { fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700}); fs.writeFileSync(file, JSON.stringify(state), {mode: 0o600}); } catch {}
}

function notifyStop({mode, stopped, ruleIds = [], notifyOnStop = true, summary, dataDir}, options = {}) {
  const stubbed = !!(options.execFile || options.launch);
  // Test runs and rehearsals never reach a real screen: the Node test runner sets NODE_TEST_CONTEXT in every
  // process it starts, and AGENTGUARD_NOTIFY_SUPPRESS=1 is the explicit switch.
  if (!stubbed && (process.env.AGENTGUARD_NOTIFY_SUPPRESS === '1' || process.env.NODE_TEST_CONTEXT)) return false;
  if ((options.platform ?? process.platform) !== 'darwin' || mode !== 'enforce' || !stopped || notifyOnStop === false) return false;
  const ids = [...new Set(ruleIds.filter(id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(id)))].slice(0, 14);
  if (!ids.length) ids.push('policy');
  const now = options.now ?? Date.now();
  const stateDir = options.stateDir ?? dataDir ?? require('./common.cjs').locations().data;
  const file = path.join(stateDir, STATE_FILE);
  const state = readState(file);
  if (state.off === true) return false;
  if (typeof state.muteUntil === 'number' && state.muteUntil * 1000 > now) return false;
  if (typeof state.lastShownAt === 'number' && now - state.lastShownAt < (options.cooldownMs ?? COOLDOWN_MS)) {
    writeState(file, {...state, skipped: (state.skipped ?? 0) + 1});
    return false;
  }
  const text = compose(ids, summary, state.skipped ?? 0);
  writeState(file, {...state, lastShownAt: now, skipped: 0, lastRules: ids});
  const spawnOptions = {timeout: 1500, maxBuffer: 1024, windowsHide: true, detached: true, stdio: 'ignore'};
  try {
    const binary = options.binary !== undefined ? options.binary : notifier.notifierBinary(options.notifierOptions);
    let child;
    if (binary) {
      child = (options.launch ?? execFile)(binary, ['--title', text.title, '--subtitle', text.subtitle, '--body', text.body, '--state', file], spawnOptions, () => {});
    } else {
      // No app yet: start building one for next time (needs swiftc) and show the plain notification now.
      if (options.canBuild ?? !!notifier.swiftc()) notifier.startBuild(options.notifierOptions);
      child = (options.execFile ?? execFile)('/usr/bin/osascript', ['-e', SCRIPT, `${text.subtitle}. ${text.body}`, text.title], spawnOptions, () => {});
    }
    // Never hold the hook process open for the notification.
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch { return false; }
}
module.exports = {notifyStop, compose, COOLDOWN_MS, STATE_FILE, BURN, CAPS};
