#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {locations, hostContext} = require('./common.cjs');
const {validatePolicy} = require('./policy-schema.cjs');
const {validateOrgPolicy, ROOT_FIELDS} = require('./org-policy-contract.cjs');
const UPSELL = 'Policy sync is part of Solo: your policy on up to three machines. agentguard.run/pricing';
const PRESETS = ['solo-dev', 'careful', 'strict'];
function localPolicy(data) {
  try { return require('./policy-file.cjs').stripMergeFields(JSON.parse(fs.readFileSync(path.join(data, 'policy.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Local policy is not readable JSON.'); return JSON.parse(fs.readFileSync(path.join(__dirname, '../config/default-policy.json'), 'utf8')); }
}
function policyConfig(value) {
  validatePolicy(value);
  const policy = Object.fromEntries(ROOT_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  const error = validateOrgPolicy(policy)[0];
  if (error) throw new Error(error);
  if (Buffer.byteLength(JSON.stringify({policy})) > 65536) throw new Error('Policy exceeds 64 KB.');
  return policy;
}
function writePolicy(data, before, after) {
  policyConfig(after);
  fs.mkdirSync(data, {recursive: true, mode: 0o700});
  const file = path.join(data, 'policy.json'), temporary = file + '.' + randomUUID();
  try { fs.writeFileSync(temporary, JSON.stringify(after, null, 2) + '\n', {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
  const diff = ROOT_FIELDS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .flatMap(key => [`Before ${key}: ${JSON.stringify(before[key] ?? null)}`, `After ${key}: ${JSON.stringify(after[key] ?? null)}`]);
  return diff.length ? diff.join('\n') : 'Policy unchanged.';
}
function describe(state) {
  const {config, license, orgPolicy} = state;
  const lines = [`Mode: ${license.mode === 'shadow' && license.reason ? 'shadow fallback (' + license.reason + ')' : config.mode ?? 'enforce'}.`,
    orgPolicy ? `Synced policy version ${orgPolicy.version}, SHA256 ${orgPolicy.sha256}.` : 'Using the local policy on this machine.'];
  for (const cap of config.caps ?? []) lines.push(`Cap: $${(cap.amountCents / 100).toFixed(2)} ${cap.window.replaceAll('_', ' ')}; ${cap.action ?? 'block'} before exceeding the limit.`);
  if (!(config.caps ?? []).length) lines.push('No spend cap configured.');
  lines.push('Caps count configured tool unit prices, not provider bills. Unpriced tools count as zero.');
  for (const group of config.commandRuleGroups ?? [config.commandRules ?? []]) for (const rule of group) lines.push(`${rule.id}: ${rule.action} ${rule.match?.replaceAll('-', ' ') ?? `shell commands matching ${JSON.stringify(rule.pattern)}`}.`);
  for (const [id, mode] of Object.entries(config.guardPack?.rules ?? {})) lines.push(`${id}: ${mode}. ${require('./guard-pack.cjs').RULES.find(rule => rule.id === id)?.reason ?? ''}`);
  for (const field of ['allowedTools', 'deniedTools', 'ethicalWall']) if (config[field]?.length) lines.push(`${field}: ${config[field].join(', ')}.`);
  if (config.maxCapability) lines.push(`Maximum capability: ${config.maxCapability.replaceAll('_', ' ')}.`);
  for (const rule of config.toolRules ?? []) lines.push(`Tools matching ${JSON.stringify(rule.pattern)}: ${rule.unitCostCents === undefined ? 'price unchanged' : '$' + (rule.unitCostCents / 100).toFixed(2) + ' per call'}${rule.capability ? ', capability ' + rule.capability.replaceAll('_', ' ') : ''}.`);
  for (const [id, session] of Object.entries(config.sessions ?? {})) {
    lines.push(`Session ${id}:`);
    for (const cap of session.caps ?? []) lines.push(`  Cap $${(cap.amountCents / 100).toFixed(2)} ${cap.window.replaceAll('_', ' ')}; ${cap.action ?? 'block'}.`);
    for (const field of ['allowedTools', 'deniedTools', 'ethicalWall']) if (session[field]) lines.push(`  ${field}: ${session[field].join(', ') || 'empty list'}.`);
    if (session.maxCapability) lines.push(`  Maximum capability: ${session.maxCapability.replaceAll('_', ' ')}.`);
  }
  if ((config.commandRuleGroups ?? [config.commandRules ?? []]).flat().some(rule => rule.match === 'network')) lines.push('Strict approval includes every shell and connector call because those tools can open network connections.');
  if (state.syncReason) lines.push(license.mode === 'shadow' ? 'Team policy unavailable. Enforcement is in shadow until it can be read again.' : 'Policy sync unavailable. Local policy applies.');
  return lines.join('\n');
}
async function run(argv, options = {}) {
  const data = options.data ?? locations().data, sessionId = options.sessionId ?? hostContext().sessionId ?? 'policy-cli';
  const [command, ...args] = argv;
  if (command === 'quiet' && args.length === 1 && args[0] === 'on') {
    require('./upgrade-moments.cjs').dismiss();
    return 'Quiet is on. STOP upgrade lines, monthly Burn summaries and version announcements are dismissed permanently on this machine.';
  }
  const before = localPolicy(data);
  if (command === 'show' && !args.length) return describe(require('./policy-state.cjs').policyState(data, sessionId, options));
  if (command === 'explain' && args.length === 1) {
    const state = require('./policy-state.cjs').policyState(data, sessionId, options);
    const builtIn = require('./guard-pack.cjs').RULES.find(rule => rule.id === args[0]);
    if (builtIn) return `${builtIn.id}: ${builtIn.reason} Effective action: ${state.config.guardPack.rules[builtIn.id]}.`;
    const rule = (state.config.commandRuleGroups ?? [state.config.commandRules ?? []]).flat().find(rule => rule.id === args[0]);
    if (rule) return `${rule.id}: ${rule.action} ${rule.match?.replaceAll('-', ' ') ?? `shell commands matching ${JSON.stringify(rule.pattern)}`}. Last match wins within a policy layer; Team constraints still apply.`;
    throw new Error('Unknown rule ID.');
  }
  if (command === 'push' && !args.length) {
    if (!require('./license.cjs').configuredKey(before)) return UPSELL;
    // Validate and project here and again inside the detached worker. No policy
    // body or key is put into IPC, and this process opens no network socket.
    policyConfig(before);
    const result = await (options.request ?? require('./client.cjs').request)({control: 'policy-push', sessionId}, {data, timeoutMs: 8000});
    if (result.error) throw new Error(result.error);
    if (!result.sha256) throw new Error('Policy sync unavailable. Local policy is unchanged.');
    return `Policy synced. Version ${result.version}, SHA256 ${result.sha256}. Other machines load it at session start or the next policy refresh.`;
  }
  if (command === 'benchmark' && args.length === 2 && ['on', 'off'].includes(args[0])) {
    // Consent lives in the signed ledger, written by the worker; this process
    // sends only the run id and opens no socket.
    const result = await (options.request ?? require('./client.cjs').request)({control: 'benchmark-consent', runId: args[1], granted: args[0] === 'on'}, {data, timeoutMs: 8000});
    if (result.error) throw new Error(result.error);
    if (!Number.isSafeInteger(result.sequence)) throw new Error('Benchmark consent unavailable. Enforcement is unchanged.');
    return args[0] === 'on'
      ? `Benchmark consent for run ${args[1]} recorded as signed ledger row ${result.sequence}. With AGENTGUARD_BENCHMARK=1 and AGENTGUARD_BENCH_RUN_ID=${args[1]}, hooks on this machine measure instead of enforce until you run: node runtime/policy-cli.cjs benchmark off ${args[1]}`
      : `Benchmark consent for run ${args[1]} revoked in signed ledger row ${result.sequence}. Hooks enforce normally.`;
  }
  if (command === 'approve' && args.length === 1) {
    require('./policy-approval.cjs').approve(data, args[0]);
    return 'Approved once for the exact pending call. Retry before the five-minute approval expires.';
  }
  if (command === 'pending' && !args.length) {
    const list = require('./policy-approval.cjs').pending(data);
    if (!list.length) return 'No held calls are waiting for approval.';
    return list.map(item => `${item.token}  rule ${item.ruleId ?? 'unknown'}  tool ${item.toolName ?? 'unknown'}  session ${item.sessionId ?? 'unknown'}  input sha256 ${(item.inputSha256 ?? '').slice(0, 12)}  expires in ${item.expiresInSeconds}s`)
      .concat('Approve one exact call with: node runtime/policy-cli.cjs approve <token>. Confirm the call with the person driving the agent first.').join('\n');
  }
  let after = {...before};
  if (command === 'preset' && args.length === 1) {
    if (!PRESETS.includes(args[0])) throw new Error('Choose solo-dev, careful or strict.');
    after = {...before, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'presets', args[0] + '.json'), 'utf8'))};
  } else if (command === 'set-cap' && args.length === 2) {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(args[0]) || !['per_day', 'per_session'].includes(args[1])) throw new Error('Use a nonnegative dollar amount with at most two decimals and per_day or per_session.');
    const amountCents = Math.round(Number(args[0]) * 100);
    if (!Number.isSafeInteger(amountCents)) throw new Error('Cap amount is too large.');
    after.caps = [...(before.caps ?? []).filter(cap => cap.window !== args[1] || Object.keys(cap.selector ?? {}).length), {window: args[1], amountCents, action: 'block'}];
  } else if (['block', 'allow'].includes(command) && args.length === 1) {
    const pattern = args[0], id = 'command-' + createHash('sha256').update(pattern).digest('hex').slice(0, 16);
    after.commandRules = [...(before.commandRules ?? []).filter(rule => rule.id !== id), {id, pattern, action: command}];
  } else throw new Error('Use show, preset <name>, set-cap <dollars> <per_day|per_session>, block <pattern>, allow <pattern>, explain <rule-id>, push, pending, approve <token>, benchmark on|off <run-id> or quiet on.');
  const diff = writePolicy(data, before, after);
  return diff + (require('./license.cjs').configuredKey(before) ? '\nLocal policy updated. Run policy-cli push to sync a Solo policy.' : '');
}
if (require.main === module) run(process.argv.slice(2)).then(message => process.stdout.write(message + '\n')).catch(error => {
  process.stderr.write(String(error.message || 'Policy command failed.').replace(/[\r\n]+/g, ' ') + '\n'); process.exitCode = 1;
});
module.exports = {run, localPolicy, policyConfig, writePolicy, describe, UPSELL};
