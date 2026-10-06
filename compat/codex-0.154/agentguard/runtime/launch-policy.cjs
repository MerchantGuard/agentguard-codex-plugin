'use strict';
// Host metadata only. Tool prompts and descriptions stay in the hook process.
const fs = require('node:fs');
const path = require('node:path');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,128}$/.test(value) && !value.includes('--') ? value : null;
const agentId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0;

// Burn owns cumulative usage and its persisted replacement identity. This
// compatibility export delegates only; it never parses or adds a second total.
function observeCodexUsage(burn, gateway, meta, transcriptPath) {
  const events = burn.readCodexTranscriptUsage(transcriptPath, meta.sessionId, Date.now());
  if (events.length) gateway.observe(events);
}

function observedTokens(view) {
  return (view?.usage?.authoritative > 0 || view?.usage?.estimated > 0) && count(view?.state?.totalTokens) ? view.state.totalTokens : null;
}

function canRewrite(raw, host) {
  if (host === 'claude-code') return raw.tool_input?.subagent_type !== 'fork';
  // Full-history Codex forks inherit the main model. Never change their
  // context policy just to obtain a different model.
  if (!require('./common.cjs').SPAWN.has(raw.tool_name) || !/^(none|[1-9][0-9]*)$/.test(raw.tool_input?.fork_turns ?? '')) return false;
  // Custom roles may override the explicit spawn model. Until their resolved
  // configuration is exposed by the host, use the approval suggestion.
  const type = raw.tool_input?.agent_type ?? 'default';
  if (!['default', 'worker', 'explorer'].includes(type)) return false;
  const directories = [process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex')];
  if (typeof raw.cwd !== 'string' || !path.isAbsolute(raw.cwd)) return false;
  let cwd = raw.cwd;
  for (;;) { directories.push(path.join(cwd, '.codex')); const parent = path.dirname(cwd); if (parent === cwd) break; cwd = parent; }
  try {
    for (const directory of directories) {
      // Any custom role file is conservatively uncertain, including one that
      // overrides a built-in under a different filename.
      if (fs.existsSync(path.join(directory, 'agents')) && fs.readdirSync(path.join(directory, 'agents')).some(name => name.endsWith('.toml'))) return false;
      const config = path.join(directory, 'config.toml');
      if (fs.existsSync(config) && /\[\s*agents\s*\./.test(fs.readFileSync(config, 'utf8'))) return false;
    }
    return true;
  } catch { return false; }
}

function validate(config) {
  if (config.max_depth !== undefined && config.max_depth !== null && (!count(config.max_depth) || config.max_depth < 1)) throw new Error('max_depth must be null or a positive integer.');
  const p = config.helper_models;
  if (p === undefined) return;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['enabled', 'token_budget', 'helper_types', 'keep_types', 'model'].includes(k)) || typeof p.enabled !== 'boolean') throw new Error('helper_models is invalid.');
  if (!p.enabled && Object.keys(p).length === 1) return;
  if (!count(p.token_budget) || !id(p.model) || ![p.helper_types, p.keep_types].every(a => Array.isArray(a) && a.length <= 256 && a.every(v => id(v)))) throw new Error('helper_models needs a token budget, model, helper types and keep types.');
}

function readSidecar(transcriptPath, caller) {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl') || !agentId(caller)) return null;
  const directory = path.basename(path.dirname(transcriptPath)) === 'subagents'
    ? path.dirname(transcriptPath) : path.join(transcriptPath.slice(0, -6), 'subagents');
  const file = path.join(directory, `agent-${caller}.meta.json`);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) return null;
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!count(value.spawnDepth) || value.spawnDepth < 1 || value.spawnDepth > 256) return null;
    return {depth: value.spawnDepth + 1, source: 'claude_agent_sidecar', callerId: caller,
      parentAgentId: agentId(value.parentAgentId), callerType: id(value.agentType)};
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function lineage(raw, host) {
  let lineage = {depth: null, source: 'unavailable', callerId: agentId(raw.agent_id), parentAgentId: null, callerType: id(raw.agent_type)};
  if (host === 'claude-code') {
    // Claude documents absence of agent_id as the main thread, including
    // named main agents. A malformed supplied id is never taken as main.
    if (raw.agent_id === undefined) lineage = {...lineage, depth: 1, source: 'claude_main', callerId: 'main'};
    else lineage = readSidecar(raw.transcript_path, raw.agent_id) ?? lineage;
  }
  return {...lineage, callerType: lineage.callerType ?? id(raw.agent_type)};
}
function metadata(raw, host) {
  // A Codex launch without a role is explicitly the default helper type.
  // Never infer a helper type from task_name, description or message text.
  return {launch: {...lineage(raw, host), agentType: id(raw.tool_input?.subagent_type ?? raw.tool_input?.agent_type ?? (host === 'codex' ? 'default' : null)),
    fromModel: id(raw.tool_input?.model) ?? id(raw.model) ?? 'inherit', activeModel: id(raw.model),
    resumed: !!raw.tool_input?.resume, modelRewriteSupported: canRewrite(raw, host)}};
}

// The full replacement input is assembled only in the short-lived hook.
// No prompt, code, file contents or tool arguments cross worker IPC.
function applyModel(output, model, raw, host) {
  if (!model) return output;
  if (!canRewrite(raw, host) || !require('./common.cjs').SPAWN.has(raw.tool_name) || !id(model) || !raw.tool_input || typeof raw.tool_input !== 'object' || Array.isArray(raw.tool_input)) throw new Error('model_rewrite_unsupported');
  const specific = output.hookSpecificOutput ?? {};
  if (specific.permissionDecision === 'deny') return output;
  // Codex only consumes updatedInput together with allow. Claude's native
  // permission decision remains intact, including an outstanding depth ask.
  return {...output, hookSpecificOutput: {...specific, hookEventName: 'PreToolUse',
    ...(host === 'codex' ? {permissionDecision: 'allow'} : {}), updatedInput: {...raw.tool_input, model}}};
}

function receiptValid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = {depth: v => v === null || count(v), source: v => ['unavailable', 'claude_main', 'claude_agent_sidecar'].includes(v),
    callerId: v => v === null || !!agentId(v), parentAgentId: v => v === null || !!agentId(v), callerType: v => v === null || !!id(v),
    agentType: v => v === null || !!id(v), fromModel: v => !!id(v), activeModel: v => v === null || !!id(v), resumed: v => typeof v === 'boolean', modelRewriteSupported: v => typeof v === 'boolean',
    maxDepth: v => v === null || count(v), depthDecision: v => ['off', 'within_limit', 'over_limit', 'lineage_unavailable'].includes(v),
    modelDecision: v => ['off', 'unchanged', 'rewrite', 'suggestion', 'shadow'].includes(v), toModel: v => v === null || !!id(v),
    tokenBudget: v => v === null || count(v), sessionTokens: v => v === null || count(v),
    reason: v => ['helper_token_budget', 'helper_policy_unchanged'].includes(v)};
  return Object.entries(value).every(([k,v]) => fields[k]?.(v));
}
module.exports = {validate, metadata, lineage, applyModel, receiptValid, observeCodexUsage, observedTokens};
