'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const SPAWN = new Set(['spawn_agent', 'Agent', 'Task']);
function hostContext(env = process.env) {
  // Host identity comes from the launch environment, never tool input. Explicit
  // Codex paths win when a Codex process inherits a parent Claude environment.
  const host = env.PLUGIN_ROOT || env.PLUGIN_DATA ? 'codex'
    : env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PLUGIN_DATA ? 'claude-code' : 'codex';
  return { host, root: env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || undefined,
    data: env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || undefined,
    // Claude documents this as a skill substitution. Accept it if an operator
    // explicitly exports it, but hook session_id remains authoritative.
    sessionId: identifier(host === 'claude-code' ? env.CLAUDE_SESSION_ID : env.CODEX_THREAD_ID, null) ?? undefined };
}
function locations(dataOverride) {
  const data = path.resolve(dataOverride || hostContext().data || path.join(os.homedir(), '.agentguard', 'codex-plugin'));
  const tag = crypto.createHash('sha256').update(data).digest('hex').slice(0, 24);
  // Hook IPC uses files only. The directory is private to this uid.
  const ipc = path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${tag}`);
  return { data, ipc, ready: path.join(ipc, 'worker.ready'), socket: path.join(ipc, 'worker.ready'), lock: path.join(ipc, 'worker.lock'),
    spool: path.join(data, 'fail-open-pending.ndjson') };
}
function allow() { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }; }
function writeWorkerPid(lock, pid) {
  const temporary = `${lock}.${process.pid}.${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, String(pid), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, lock);
}
function deny(reason) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason.replace(/[\r\n]+/g, ' ').slice(0, 700) } }; }
function identifier(value, fallback = 'unknown') {
  return typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value) ? value : fallback;
}
function outcomeSuccess(raw, toolName) {
  if (hostContext().host === 'claude-code' && raw.hook_event_name === 'PostToolUseFailure') return false;
  const response = raw.tool_response;
  if (raw.is_error || response?.isError || response?.is_error || response?.error
    || (typeof response?.exit_code === 'number' && response.exit_code !== 0)) return false;
  if (raw.is_error === false || response?.isError === false || response?.is_error === false
    || response?.exit_code === 0) return true;
  // Codex 0.154 unified Bash hooks expose raw output only, without exit status.
  // Output text is untrusted: a printed "exit code" must not become audit evidence.
  if (toolName === 'Bash' && typeof response === 'string') return null;
  return true;
}
function metadata(raw, gate) {
  const input = JSON.stringify(raw.tool_input ?? {});
  const response = raw.tool_response;
  // A failure's error text is counted in memory, never retained in metadata.
  const output = JSON.stringify(hostContext().host === 'claude-code' && raw.hook_event_name === 'PostToolUseFailure' ? raw.error ?? null : response ?? null);
  const toolName = identifier(raw.tool_name);
  const guard = gate === 'spend' && !SPAWN.has(toolName) || gate === 'burn' && SPAWN.has(toolName)
    ? require('./guard-pack.cjs').scanGuardPack(toolName, raw.tool_input, {cwd: raw.cwd}) : {ruleIds: []};
  return { schema: 'agentguard.codex.v1', host: hostContext().host, requestId: crypto.randomUUID(), gate, toolName,
    toolUseId: identifier(raw.tool_use_id, crypto.randomUUID()), sessionId: identifier(raw.session_id, hostContext().sessionId ?? 'unknown'),
    ...(raw.agent_id ? { agentId: identifier(raw.agent_id) } : {}),
    inputSha256: crypto.createHash('sha256').update(input).digest('hex'),
    inputBytes: Buffer.byteLength(input), inputKeys: raw.tool_input && typeof raw.tool_input === 'object' ? Object.keys(raw.tool_input).length : 0,
    ...(guard.ruleIds.length ? {guardRuleIds: guard.ruleIds} : {}),
    ...(guard.reason ? {guardScanReason: guard.reason} : {}),
    startedAt: new Date().toISOString(),
    ...(gate === 'receipt' ? { outputBytes: Buffer.byteLength(output),
      success: outcomeSuccess(raw, toolName),
      ...(Number.isFinite(raw.duration_ms) && raw.duration_ms >= 0 ? { durationMs: raw.duration_ms, durationSource: 'host' } : {}) } : {}) };
}
function spoolFailure(meta, reasonCode) {
  const { data, spool } = locations();
  try { fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    fs.appendFileSync(spool, JSON.stringify({ ...meta, event: 'fail_open', reasonCode }) + '\n', { mode: 0o600 });
  } catch { /* Storage failure is itself fail-open. Never include payload or filesystem error text. */ }
}
function normalizeHookOutput(output, options = {}) {
  const specific = output?.hookSpecificOutput;
  const nativePermissions = hostContext().host === 'claude-code';
  if ((!nativePermissions && !options.legacyAllow) || specific?.hookEventName !== 'PreToolUse' ||
      specific.permissionDecision !== 'allow' || (!nativePermissions && specific.updatedInput != null)) return output;
  // An ordinary admission must preserve Claude's native permission prompts.
  // Codex 0.154 also accepts an empty response for an unmodified input.
  const normalized = {...output, hookSpecificOutput: {...specific}};
  delete normalized.hookSpecificOutput.permissionDecision;
  delete normalized.hookSpecificOutput.permissionDecisionReason;
  if (Object.keys(normalized.hookSpecificOutput).every(key => key === 'hookEventName')) delete normalized.hookSpecificOutput;
  return normalized;
}
function outcomeFlow(meta) { return meta.host === 'claude-code' ? 'claude-code-tool' : 'codex-tool'; }
function minimumCapability(toolName) {
  return /^(Bash|PowerShell|apply_patch|Edit|MultiEdit|Write|NotebookEdit)$/i.test(toolName) ? 'data_write' : 'read_only';
}
function standaloneBurnCommand(hook) {
  if (hook?.type !== 'command' || typeof hook.command !== 'string') return false;
  let words;
  if (Array.isArray(hook.args)) words = [hook.command, ...hook.args];
  else {
    // Only literal CLI commands are ownership evidence. Reject shell programs,
    // substitutions, comments and pipelines, including incidental echo text.
    if (/[;&|<>`$()#\r\n]/.test(hook.command)) return false;
    const tokens = hook.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    words = tokens.map(token => token.replace(/^(["'])(.*)\1$/, '$2'));
    if (words.some(word => /["']/.test(word))) return false;
  }
  if (words.some(word => typeof word !== 'string')) return false;
  const command = path.basename(words[0] ?? '');
  if (command === 'agentguard-burn') return words.length === 2 && words[1] === 'hook';
  if (command === 'node' || command === 'node.exe') return words.length === 3 && words[2] === 'hook' &&
    /(?:agentguard-burn|@agentguard-run[\\/]burn)[\\/](?:dist[\\/](?:src[\\/])?)?cli\.js$/.test(words[1]);
  if (command === 'npx' || command === 'npx.cmd') {
    const args = words.slice(1).filter(value => value !== '--no-install');
    return args.length === 2 && /^@agentguard-run\/burn(?:@[0-9][A-Za-z0-9.+-]*)?$/.test(args[0]) && args[1] === 'hook';
  }
  return false;
}
function matchingExternalBurn(meta, workingDirectory, env = process.env) {
  if (meta.host !== 'claude-code') return false;
  const configHome = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const directories = [workingDirectory, env.CLAUDE_PROJECT_DIR].filter(value => typeof value === 'string' && path.isAbsolute(value));
  const files = [...new Set([path.join(configHome, 'settings.json'), ...directories.flatMap(directory =>
    [path.join(directory, '.claude', 'settings.json'), path.join(directory, '.claude', 'settings.local.json')]),
    ...(process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json'] : ['/etc/claude-code/managed-settings.json'])])];
  for (const file of files) {
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (settings.disableAllHooks === true) continue;
    const groups = settings.hooks?.PreToolUse;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      let matched = !group.matcher || group.matcher === '*';
      try { matched ||= new RegExp(group.matcher).test(meta.toolName); } catch { continue; }
      if (!matched) continue;
      if (group.hooks.some(standaloneBurnCommand)) return true;
    }
  }
  return false;
}
const claudeReaders = new WeakMap();
function claudeUsage(burn, gateway, meta, transcriptPath) {
  if (!transcriptPath) return;
  let readers = claudeReaders.get(gateway);
  if (!readers) { readers = new Map(); claudeReaders.set(gateway, readers); }
  const key = crypto.createHash('sha256').update(`${meta.sessionId}:${transcriptPath}`).digest('hex');
  const directory = path.join(locations().data, 'claude-cursors'), file = path.join(directory, key + '.json');
  let reader = readers.get(key);
  const inode = fs.existsSync(transcriptPath) ? fs.statSync(transcriptPath).ino : null;
  if (!reader) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    reader = saved?.inode === inode && saved.cursor && Array.isArray(saved.cursor.depthByUuid)
      ? {inode, index: saved.index, cursor: {...saved.cursor, depthByUuid: new Map(saved.cursor.depthByUuid)}}
      : {inode, index: 0, cursor: burn.newCursor()};
  }
  if (reader.inode !== inode || fs.existsSync(transcriptPath) && fs.statSync(transcriptPath).size < reader.cursor.offset)
    reader = {inode, index: 0, cursor: burn.newCursor()};
  // Advance the persisted cursor only after the gateway stores the observations.
  const next = {inode, index: reader.index, cursor: {...reader.cursor, depthByUuid: new Map(reader.cursor.depthByUuid)}};
  const events = [];
  for (const record of burn.readIncremental(transcriptPath, next.cursor)) {
    const id = identifier(record.uuid, `line-${next.index++}`);
    const base = {schemaVersion: 1, host: 'claude-code', sessionId: meta.sessionId, at: record.at};
    if (record.tokens) events.push({...base, kind: 'model_usage',
      eventId: `claude:usage:${id}:${record.tokens}:${record.cacheRead}`, callId: `claude:usage:${id}`,
      tokens: record.tokens, cacheRead: record.cacheRead, usageCoverage: 'authoritative'});
    for (const [index, spawn] of record.spawns.entries()) events.push({...base, kind: 'spawn_started',
      eventId: `claude:spawn:${id}:${index}`, spawnId: `claude:spawn:${id}:${index}`, depth: spawn.issuerDepth + 1});
    for (const [index, surface] of record.surfaces.entries()) events.push({...base, kind: 'surface_read',
      eventId: `claude:surface:${id}:${index}`, surfaceDigest: crypto.createHash('sha256').update(surface).digest('hex')});
  }
  gateway.observe(events);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const temporary = file + '.' + crypto.randomUUID();
  fs.writeFileSync(temporary, JSON.stringify({...next, cursor: {...next.cursor, depthByUuid: [...next.cursor.depthByUuid]}}), {mode: 0o600});
  fs.renameSync(temporary, file);
  readers.set(key, next);
}
function runBurnHook(burn, gateway, meta, transcriptPath) {
  const raw = {session_id: meta.sessionId, tool_name: meta.toolName, tool_use_id: meta.toolUseId,
    hook_event_name: 'PreToolUse', transcript_path: transcriptPath, ...(meta.agentId ? {agent_id: meta.agentId} : {})};
  if (meta.host !== 'claude-code') return burn.handleCodexHook(raw, gateway);
  let observation = {};
  if (!SPAWN.has(meta.toolName)) observation = burn.handlePreToolUse(raw, gateway.dataDirectory);
  else {
    // Burn's public native spawn handler has no policy override or decision
    // callback. Reuse its pinned advisory observer and public Gateway instead.
    // Only counts, tool names and the transcript locator cross this boundary.
    const entry = Object.values(require.cache).find(module => module.exports === burn);
    if (entry) {
      const live = path.join(path.dirname(entry.filename), 'insights', 'live.js');
      if (fs.existsSync(live)) {
        const result = require(live).observeTool(gateway.dataDirectory, raw, 'claude', burn.loadPolicy(gateway.dataDirectory));
        if (result.messages.length) observation.systemMessage = result.messages.join('\n');
      }
    }
  }
  claudeUsage(burn, gateway, meta, transcriptPath);
  if (!SPAWN.has(meta.toolName)) return observation;
  const decision = gateway.beforeSpawn({schemaVersion: 1, kind: 'spawn_requested', eventId: `claude:request:${meta.toolUseId}`,
    host: 'claude-code', sessionId: meta.sessionId, at: Date.now(), spawnId: meta.toolUseId,
    proposedDepth: meta.agentId ? 2 : 1, attribution: 'high'});
  if (decision.blocked) return {...observation, ...deny(burn.renderStop(decision.report, {colour: false}))};
  const warnings = [observation.systemMessage];
  if (decision.overridden) warnings.push(`AgentGuard STOP overridden${decision.overridden.once ? ' once' : ''}: ${decision.report.findings[0]?.summary ?? ''}`);
  else if (decision.notify && decision.verdict !== 'OK') warnings.push(`AgentGuard ${decision.verdict}${decision.mode === 'shadow' && decision.wouldBlock ? ' (shadow: would have blocked)' : ''}: ${decision.report.findings[0]?.summary ?? ''}`);
  return warnings.some(Boolean) ? {systemMessage: warnings.filter(Boolean).join('\n')} : {};
}
module.exports = { locations, allow, deny, metadata, identifier, spoolFailure, writeWorkerPid, SPAWN,
  hostContext, normalizeHookOutput, outcomeFlow, outcomeSuccess, minimumCapability, matchingExternalBurn, standaloneBurnCommand, runBurnHook };
