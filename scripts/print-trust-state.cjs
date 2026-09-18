#!/usr/bin/env node
'use strict';

// Codex rust-v0.154.0: hooks/src/engine/discovery.rs and config/src/fingerprint.rs.
// This hashes normalized hook definitions, not the files a command executes.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const EVENTS = Object.freeze({
  PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact', PostCompact: 'post_compact', SessionStart: 'session_start',
  SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt_submit', SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop', Stop: 'stop', Interrupt: 'interrupt',
});
const NO_MATCHER = new Set(['UserPromptSubmit', 'Stop', 'Interrupt']);
const ADDITIONAL_CONTEXT = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'SubagentStart']);

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  if (value === null || (typeof value === 'number' && !Number.isFinite(value)) ||
      !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Hook identity must be representable in TOML.');
  return JSON.stringify(value);
}
function versionForToml(value) {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function timeoutFor(event, timeout) {
  if (timeout !== undefined && timeout !== null && (!Number.isSafeInteger(timeout) || timeout < 0)) throw new Error('Hook timeout must be a nonnegative safe integer.');
  if (event === 'SessionEnd' || event === 'Interrupt') return Math.min(3, Math.max(1, timeout ?? 1));
  return Math.max(1, timeout ?? 600);
}
function normalizedIdentity(event, group, handler, platform = process.platform) {
  if (!Object.hasOwn(EVENTS, event)) throw new Error('Unsupported hook event.');
  if (!handler || typeof handler !== 'object') throw new Error('Hook handler is missing.');
  const timeout = timeoutFor(event, handler.timeout);
  let normalized;
  if (handler.type === 'command') {
    const alternate = handler.commandWindows ?? handler.command_windows;
    const command = platform === 'win32' ? (alternate ?? handler.command) : handler.command;
    if (typeof command !== 'string' || !command.trim()) throw new Error('Hook command must not be empty.');
    if (handler.async !== undefined && typeof handler.async !== 'boolean') throw new Error('Hook async must be boolean.');
    normalized = {type: 'command', command, timeout, async: handler.async ?? false};
    if (ADDITIONAL_CONTEXT.has(event) && handler.additionalContextLimit != null && handler.additionalContextLimit !== 2500) {
      if (!Number.isSafeInteger(handler.additionalContextLimit) || handler.additionalContextLimit < 0) throw new Error('Invalid additional context limit.');
      normalized.additionalContextLimit = handler.additionalContextLimit;
    }
  } else throw new Error('This helper supports the AgentGuard command hooks only.');
  if (handler.statusMessage != null) {
    if (typeof handler.statusMessage !== 'string') throw new Error('Hook status message must be a string.');
    normalized.statusMessage = handler.statusMessage;
  }
  const identity = {event_name: EVENTS[event], hooks: [normalized]};
  if (!NO_MATCHER.has(event) && group.matcher != null) {
    if (typeof group.matcher !== 'string') throw new Error('Hook matcher must be a string.');
    identity.matcher = group.matcher;
  }
  return identity;
}
function hookKey(pluginId, sourceRelativePath, event, groupIndex, handlerIndex) {
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(pluginId)) throw new Error('Plugin id must include its marketplace, such as agentguard@agentguard.');
  if (!Object.hasOwn(EVENTS, event)) throw new Error('Unsupported hook event.');
  return `${pluginId}:${sourceRelativePath}:${EVENTS[event]}:${groupIndex}:${handlerIndex}`;
}
function trustEntries(hooks, {pluginId = 'agentguard@agentguard', sourceRelativePath = 'hooks/hooks.json', platform = process.platform} = {}) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('Expected hook event definitions.');
  for (const event of Object.keys(hooks)) if (!Object.hasOwn(EVENTS, event)) throw new Error('Unsupported hook event.');
  const entries = [];
  for (const event of Object.keys(EVENTS)) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error('Hook event must contain matcher groups.');
    for (const [groupIndex, group] of groups.entries()) {
      if (!Array.isArray(group.hooks ?? [])) throw new Error('Matcher group hooks must be an array.');
      for (const [handlerIndex, handler] of (group.hooks ?? []).entries()) {
        const identity = normalizedIdentity(event, group, handler, platform);
        entries.push({key: hookKey(pluginId, sourceRelativePath, event, groupIndex, handlerIndex), trusted_hash: versionForToml(identity)});
      }
    }
  }
  return entries;
}
function defaultRoot() {
  const root = path.resolve(__dirname, '..');
  if (process.env.PLUGIN_ROOT) return path.resolve(process.env.PLUGIN_ROOT);
  return fs.existsSync(path.join(root, '.codex-plugin/plugin.json')) ? root : path.join(root, 'compat/codex-0.154/agentguard');
}
function installedTrustEntries(root = defaultRoot(), pluginId = 'agentguard@agentguard', platform = process.platform) {
  root = fs.realpathSync(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
  const sources = manifest.hooks == null ? ['./hooks/hooks.json'] : Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks];
  const entries = [];
  for (const source of sources) {
    if (typeof source !== 'string') throw new Error('This script supports plugin hook files, not inline manifests.');
    const file = fs.realpathSync(path.resolve(root, source));
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Hook file must remain within the installed plugin.');
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    entries.push(...trustEntries(document.hooks ?? {}, {pluginId, sourceRelativePath: relative.split(path.sep).join('/'), platform}));
  }
  if (!entries.length) throw new Error('The installed plugin declares no supported hooks.');
  return entries;
}
function renderToml(entries) {
  return entries.map(entry => `[hooks.state.${JSON.stringify(entry.key)}]\ntrusted_hash = ${JSON.stringify(entry.trusted_hash)}\n`).join('\n');
}
function main(argv = process.argv.slice(2)) {
  if (argv.length > 2) throw new Error('Usage: node scripts/print-trust-state.cjs [installed-plugin-root] [plugin@marketplace]');
  process.stdout.write(renderToml(installedTrustEntries(argv[0], argv[1])));
}
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write('AgentGuard: ' + error.message + '\n'); process.exitCode = 1; }
}
module.exports = {canonicalJson, versionForToml, timeoutFor, normalizedIdentity, hookKey, trustEntries, installedTrustEntries, renderToml, main};
