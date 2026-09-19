'use strict';
const path = require('node:path');
const fs = require('node:fs');
const isClaude = process.env.AGENTGUARD_TEST_HOST === 'claude-code';
const host = isClaude ? 'claude-code' : 'codex';
const root = path.resolve(__dirname, '..');
const envKeys = ['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID'];
function environment(env, data) {
  if (!isClaude) { env.PLUGIN_DATA = data; return env; }
  delete env.PLUGIN_DATA; delete env.PLUGIN_ROOT; delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_SESSION_ID; delete env.CODEX_THREAD_ID;
  env.CLAUDE_PLUGIN_ROOT = root; env.CLAUDE_PLUGIN_DATA = data;
  env.CLAUDE_CONFIG_DIR = path.join(data, 'claude-config');
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, {recursive: true});
  return env;
}
function recorded() {
  if (!isClaude) return null;
  const value = require('./fixtures/claude-code-2.1.275-hooks.json');
  if (!Array.isArray(value.payloads) || !value.payloads.length) throw new Error('Claude matrix needs actual recorded hook fixtures.');
  return value.payloads;
}
function template(event, tool) {
  const raw = recorded().find(item => item.hook_event_name === event && (!tool || item.tool_name === tool));
  if (!raw) throw new Error(`Missing recorded Claude fixture: ${event} ${tool ?? ''}`);
  return structuredClone(raw);
}
function payloads(fallback) {
  if (!isClaude) return fallback;
  return recorded().filter(item => item.hook_event_name === 'PreToolUse').map(item => structuredClone(item));
}
function payload(fallback, event, tool) {
  return isClaude ? {...template(event, tool), ...fallback, hook_event_name: event, ...(tool ? {tool_name: tool} : {})} : fallback;
}
function permission(output) {
  if (isClaude) return output.hookSpecificOutput?.permissionDecision ?? 'allow';
  return output.hookSpecificOutput.permissionDecision;
}
function transcript(tokens) {
  if (!isClaude) return {timestamp: new Date().toISOString(), usage: {input_tokens: tokens, output_tokens: 0}, text: 'SYNTHETIC_TRANSCRIPT_CONTENT_MUST_NOT_APPEAR'};
  return {uuid: 'synthetic-matrix-usage', type: 'assistant', timestamp: new Date().toISOString(), message: {
    role: 'assistant', usage: {input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0},
    content: [{type: 'text', text: 'SYNTHETIC_TRANSCRIPT_CONTENT_MUST_NOT_APPEAR'}]}};
}
module.exports = {isClaude, host, spawnTool: isClaude ? 'Agent' : 'spawn_agent', environment, envKeys, recorded, template, payloads, payload, permission, transcript};
