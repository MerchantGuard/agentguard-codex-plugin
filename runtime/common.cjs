'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const SPAWN = new Set(['spawn_agent', 'Agent', 'Task']);
function locations() {
  const data = path.resolve(process.env.PLUGIN_DATA || path.join(os.homedir(), '.agentguard', 'codex-plugin'));
  const tag = crypto.createHash('sha256').update(data).digest('hex').slice(0, 24);
  // macOS Unix sockets have a short path limit. The directory is private to this uid.
  const ipc = path.join('/tmp', `ag-plugin-${process.getuid?.() ?? 'local'}-${tag}`);
  return { data, ipc, socket: path.join(ipc, 'worker.sock'), lock: path.join(ipc, 'worker.lock'),
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
  const output = JSON.stringify(response ?? null);
  const toolName = identifier(raw.tool_name);
  return { schema: 'agentguard.codex.v1', gate, toolName,
    toolUseId: identifier(raw.tool_use_id, crypto.randomUUID()), sessionId: identifier(raw.session_id),
    ...(raw.agent_id ? { agentId: identifier(raw.agent_id) } : {}),
    inputSha256: crypto.createHash('sha256').update(input).digest('hex'),
    inputBytes: Buffer.byteLength(input), inputKeys: raw.tool_input && typeof raw.tool_input === 'object' ? Object.keys(raw.tool_input).length : 0,
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
module.exports = { locations, allow, deny, metadata, identifier, spoolFailure, writeWorkerPid, SPAWN };
