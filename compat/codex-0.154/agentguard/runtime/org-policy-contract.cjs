'use strict';
// Shared verbatim with the control-plane publisher. This module has no I/O.
const {createHash} = require('node:crypto');
const TIERS = ['read_only', 'data_write', 'payment_initiate', 'payment_execute'];
const ROOT_FIELDS = ['version', 'tenantId', 'mode', 'hookBudgetMs', 'defaultMatterId', 'maxCapability', 'allowedTools', 'deniedTools', 'ethicalWall', 'paymentPattern', 'toolRules', 'caps', 'sessions'];
const SESSION_FIELDS = ['matterId', 'agentId', 'allowedTools', 'deniedTools', 'ethicalWall', 'maxCapability', 'caps'];
const CAP_FIELDS = ['window', 'amountCents', 'action', 'selector', 'reason'];
const SELECTOR_FIELDS = ['tenantId', 'agentId', 'taskId', 'sessionId', 'provider', 'userId', 'teamId'];
const RULE_FIELDS = ['pattern', 'capability', 'requiredCapability', 'unitCostCents'];
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_./:@-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function validateOrgPolicy(policy) {
  const errors = [];
  function fields(value, permitted, at) {
    if (!object(value)) { errors.push(`${at} must be an object.`); return false; }
    for (const key of Object.keys(value)) if (FORBIDDEN.has(key) || !permitted.includes(key)) errors.push(`${at}.${key} is not an allowed organization policy field.`);
    return true;
  }
  function id(value, at) { if (!identifier(value)) errors.push(`${at} must be an identifier of 1 to 128 letters, digits, underscores, dots, slashes, colons, at signs or hyphens.`); }
  function regex(value, at) {
    if (typeof value !== 'string' || value.length > 512) { errors.push(`${at} must be a regular expression of at most 512 characters.`); return; }
    try { new RegExp(value, 'i'); } catch { errors.push(`${at} must be a valid JavaScript regular expression.`); }
  }
  function integer(value, at, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) errors.push(`${at} must be a safe integer of at least ${minimum}.`); }
  function enumeration(value, permitted, at) { if (!permitted.includes(value)) errors.push(`${at} must be one of ${permitted.join(', ')}.`); }
  function array(value, at, visit) {
    if (!Array.isArray(value) || value.length > 256) { errors.push(`${at} must be an array with at most 256 entries.`); return; }
    for (let i = 0; i < value.length; i++) visit(value[i], `${at}[${i}]`);
  }
  function cap(value, at) {
    if (!fields(value, CAP_FIELDS, at)) return;
    enumeration(value.window, ['per_call', 'per_minute', 'per_hour', 'per_day', 'per_month'], `${at}.window`);
    integer(value.amountCents, `${at}.amountCents`);
    if (value.action !== undefined) enumeration(value.action, ['block', 'shadow', 'allow'], `${at}.action`);
    if (value.reason !== undefined) id(value.reason, `${at}.reason`);
    if (value.selector !== undefined && fields(value.selector, SELECTOR_FIELDS, `${at}.selector`)) {
      for (const [key, val] of Object.entries(value.selector)) if (SELECTOR_FIELDS.includes(key)) id(val, `${at}.selector.${key}`);
    }
  }
  function constraints(value, at) {
    for (const key of ['allowedTools', 'deniedTools', 'ethicalWall']) if (value[key] !== undefined) array(value[key], `${at}.${key}`, regex);
    if (value.maxCapability !== undefined) enumeration(value.maxCapability, TIERS, `${at}.maxCapability`);
    if (value.caps !== undefined) array(value.caps, `${at}.caps`, cap);
  }
  if (!fields(policy, ROOT_FIELDS, 'policy')) return errors;
  if (policy.version !== 1) errors.push('policy.version must be the integer 1.');
  for (const key of ['tenantId', 'defaultMatterId']) if (policy[key] !== undefined) id(policy[key], `policy.${key}`);
  if (policy.mode !== undefined) enumeration(policy.mode, ['enforce', 'shadow'], 'policy.mode');
  if (policy.hookBudgetMs !== undefined) integer(policy.hookBudgetMs, 'policy.hookBudgetMs', 1);
  if (policy.paymentPattern !== undefined) regex(policy.paymentPattern, 'policy.paymentPattern');
  constraints(policy, 'policy');
  if (policy.toolRules !== undefined) array(policy.toolRules, 'policy.toolRules', (rule, at) => {
    if (!fields(rule, RULE_FIELDS, at)) return;
    regex(rule.pattern, `${at}.pattern`);
    for (const key of ['capability', 'requiredCapability']) if (rule[key] !== undefined) enumeration(rule[key], TIERS, `${at}.${key}`);
    if (rule.unitCostCents !== undefined) integer(rule.unitCostCents, `${at}.unitCostCents`);
  });
  if (policy.sessions !== undefined) {
    if (!object(policy.sessions) || Object.keys(policy.sessions).length > 256) errors.push('policy.sessions must be an object with at most 256 session identifiers.');
    else for (const [key, session] of Object.entries(policy.sessions)) {
      if (FORBIDDEN.has(key)) errors.push(`policy.sessions.${key} is not an allowed session identifier.`);
      id(key, `policy.sessions key ${key}`);
      if (!fields(session, SESSION_FIELDS, `policy.sessions.${key}`)) continue;
      for (const field of ['matterId', 'agentId']) if (session[field] !== undefined) id(session[field], `policy.sessions.${key}.${field}`);
      constraints(session, `policy.sessions.${key}`);
    }
  }
  return errors;
}
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hashPolicy = policy => createHash('sha256').update(canonicalize(policy)).digest('hex');
function validateEnvelope(value) {
  if (!object(value)) return ['The organization policy response must be an object.'];
  const errors = [];
  if (Object.keys(value).some(key => !['version', 'published_at', 'sha256', 'policy'].includes(key))) errors.push('The organization policy response contains an unknown field.');
  if (!Number.isSafeInteger(value.version) || value.version < 1) errors.push('The published policy version must be a positive safe integer.');
  if (typeof value.published_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.published_at) || !Number.isFinite(Date.parse(value.published_at))
    || new Date(value.published_at).toISOString().slice(0, 19) !== value.published_at.slice(0, 19)) errors.push('The published time must be an ISO date in UTC.');
  const policyErrors = validateOrgPolicy(value.policy);
  errors.push(...policyErrors);
  if (!/^[a-f0-9]{64}$/.test(value.sha256 ?? '') || (!policyErrors.length && value.sha256 !== hashPolicy(value.policy))) errors.push('The organization policy SHA256 does not match its canonical JSON.');
  return errors;
}
module.exports = {validateOrgPolicy, canonicalize, hashPolicy, validateEnvelope, TIERS, ROOT_FIELDS, SESSION_FIELDS, CAP_FIELDS, SELECTOR_FIELDS, RULE_FIELDS};
