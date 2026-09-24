'use strict';
// Open the user's own AgentGuard Score report in the default browser, only
// when the skill asked for it with openReport: true. The address must be https
// on the consented service origin and is passed to the platform opener as its
// own argument, never through a shell. AGENTGUARD_NO_BROWSER=1 disables it, and
// a Linux session without a display never tries.
const { spawn } = require('node:child_process');

function openerFor(platform) {
  if (platform === 'darwin') return url => ['open', [url]];
  if (platform === 'win32') return url => ['cmd', ['/c', 'start', '', url]];
  return url => ['xdg-open', [url]];
}

function canOpen(env, platform) {
  if (!env || env.AGENTGUARD_NO_BROWSER === '1') return false;
  if (platform !== 'darwin' && platform !== 'win32' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

function acceptable(url, origin) {
  if (typeof url !== 'string' || typeof origin !== 'string' || !url.startsWith(origin + '/')) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
}

function openReport(url, { origin, platform = process.platform, env = process.env, spawnImpl = spawn } = {}) {
  if (!acceptable(url, origin) || !canOpen(env, platform)) return false;
  const [command, args] = openerFor(platform)(url);
  try {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { openReport, openerFor, canOpen, acceptable };
