'use strict';
const {execFile} = require('node:child_process');
// The message is argv data, never AppleScript or shell source.
const SCRIPT = 'on run argv\n display notification (item 1 of argv) with title "AgentGuard STOP"\nend run';
function notifyStop({mode, stopped, ruleIds = [], notifyOnStop = true}, options = {}) {
  // AGENTGUARD_NOTIFY_SUPPRESS=1 keeps tests and rehearsals off a real screen.
  if (!options.execFile && process.env.AGENTGUARD_NOTIFY_SUPPRESS === '1') return false;
  if ((options.platform ?? process.platform) !== 'darwin' || mode !== 'enforce' || !stopped || notifyOnStop === false) return false;
  const ids = [...new Set(ruleIds.filter(id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(id)))].slice(0, 14);
  if (!ids.length) ids.push('policy');
  const message = ids.join(', ') + ': resume with agentguard-burn resume';
  try {
    const child = (options.execFile ?? execFile)('/usr/bin/osascript', ['-e', SCRIPT, message], {timeout: 1500, maxBuffer: 1024, windowsHide: true, detached: true, stdio: 'ignore'}, () => {});
    // Never hold the hook process open for the notification.
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch { return false; }
}
module.exports = {notifyStop};
