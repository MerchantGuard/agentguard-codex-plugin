'use strict';
// Gate decisions are offline. Session startup and seat renewal own licensing I/O.
process.env.AGENTGUARD_NO_BEACON = '1';
process.env.AGENTGUARD_TELEMETRY = '0';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
const burn = require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
const { OwnedLogStore } = require('./owned-log.cjs');
const { readSessionLicense, configuredKey } = require('./license.cjs');
const { readCachedOrgPolicy, mergeOrgPolicy, orgEnabled } = require('./org-policy.cjs');
const {validateGuardPack, mergeGuardPack} = require('./org-policy-contract.cjs');
const {guardResult} = require('./guard-pack.cjs');
const {notifyStop} = require('./notify-stop.cjs');
const { locations, allow, deny, SPAWN, hostContext, runBurnHook, matchingExternalBurn, outcomeFlow, minimumCapability } = require('./common.cjs');
const tiers = ['read_only', 'data_write', 'payment_initiate', 'payment_execute'];
const durations = { per_minute: 60000, per_hour: 3600000, per_day: 86400000, per_month: 2592000000 };
const startWindow = (window, now = Date.now()) => Math.floor(now / durations[window]) * durations[window];
const offline = async () => { throw new Error('offline_license_refresh_required'); };
const basePolicy = { id: 'agentguard-codex', name: 'AgentGuard tool policy', scope: { tenantId: 'local' }, version: 1, mode: 'enforce', caps: [] };
const callKey = meta => JSON.stringify([meta.sessionId, meta.toolUseId]);
const governs = meta => meta.gate === 'spend' ? !SPAWN.has(meta.toolName) : meta.gate === 'burn' && SPAWN.has(meta.toolName);
const matches = (patterns, name) => (patterns ?? []).some(pattern => new RegExp(pattern, 'i').test(name));

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('policy_invalid');
  if (policy.version !== 1 || !['enforce', 'shadow'].includes(policy.mode ?? 'enforce')) throw new Error('policy_invalid');
  if (policy.notifyOnStop !== undefined && typeof policy.notifyOnStop !== 'boolean') throw new Error('policy_invalid');
  if (validateGuardPack(policy.guardPack).length) throw new Error('guard_policy_invalid');
  const configs = [policy, ...Object.values(policy.sessions ?? {})];
  for (const config of configs) {
    if (!config || typeof config !== 'object') throw new Error('policy_invalid');
    if (config !== policy && config.guardPack !== undefined) throw new Error('guard_policy_invalid');
    if (config.maxCapability !== undefined && !tiers.includes(config.maxCapability)) throw new Error('policy_invalid');
    for (const group of config.allowedToolGroups ?? []) {
      if (!Array.isArray(group)) throw new Error('policy_invalid');
      for (const pattern of group) { if (typeof pattern !== 'string' || pattern.length > 512) throw new Error('policy_invalid'); new RegExp(pattern, 'i'); }
    }
    for (const field of ['allowedTools', 'deniedTools', 'ethicalWall']) {
      if (config[field] !== undefined && !Array.isArray(config[field])) throw new Error('policy_invalid');
      for (const pattern of config[field] ?? []) { if (typeof pattern !== 'string' || pattern.length > 512) throw new Error('policy_invalid'); new RegExp(pattern, 'i'); }
    }
    for (const cap of config.caps ?? []) {
      if (!['per_call', ...Object.keys(durations)].includes(cap.window) || !Number.isSafeInteger(cap.amountCents) || cap.amountCents < 0 || (cap.action && !['block', 'shadow', 'allow'].includes(cap.action))) throw new Error('policy_invalid');
      if (cap.selector && Object.entries(cap.selector).some(([k, v]) => !['tenantId', 'userId', 'teamId', 'agentId', 'taskId', 'sessionId', 'provider'].includes(k) || typeof v !== 'string')) throw new Error('policy_invalid');
    }
  }
  new RegExp(policy.paymentPattern ?? 'payment|pay_|charge|transfer|checkout|purchase', 'i');
  for (const rule of policy.toolRules ?? []) {
    if (typeof rule.pattern !== 'string' || rule.pattern.length > 512) throw new Error('policy_invalid');
    new RegExp(rule.pattern, 'i');
    if ([rule.capability, rule.requiredCapability].some(v => v !== undefined && !tiers.includes(v))) throw new Error('policy_invalid');
    if (rule.unitCostCents !== undefined && (!Number.isSafeInteger(rule.unitCostCents) || rule.unitCostCents < 0)) throw new Error('policy_invalid');
  }
  return policy;
}

class Engine {
  constructor(options = {}) {
    this.licenseReader = options.licenseReader ?? readSessionLicense;
    this.stopNotifier = options.stopNotifier ?? notifyStop;
    this.logOptions = options.logOptions ?? {};
    this.loc = locations(); this.spendStore = new sdk.InMemorySpendStore(); this.pending = new Map(); this.completed = new Map(); this.failures = new Set();
    this.outcomes = new sdk.SpendGuard({ policy: basePolicy, spendStore: this.spendStore, licensePostJson: offline });
    this.guards = new Map(); this.orgPolicyDigests = new Map(); this.sessionFailures = new Map();
  }
  async init() {
    fs.mkdirSync(this.loc.data, { recursive: true, mode: 0o700 });
    const keyFile = path.join(this.loc.data, 'signing-key.hex');
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const seed = fs.readFileSync(keyFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error('invalid_signing_key');
    this.privateKey = Buffer.from(seed, 'hex');
    const privateObject = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), this.privateKey]), type: 'pkcs8', format: 'der' });
    this.publicKey = crypto.createPublicKey(privateObject).export({ type: 'spki', format: 'der' }).subarray(-32);
    // The SDK lazily imports its signer. Finish that cold work before accepting
    // hooks, including workers whose first requests are observation-only.
    await sdk.signDecision({ sequence: 0, previousHash: sdk.GENESIS_PREVIOUS_HASH,
      decision: this.basic({ toolName: 'signer-warmup', sessionId: 'local', toolUseId: 'warmup', gate: 'spend' }, 'allow', 'signer_warmup'),
      privateKey: this.privateKey, publicKey: this.publicKey });
    fs.writeFileSync(path.join(this.loc.data, 'public-key.hex'), this.publicKey.toString('hex') + '\n', { mode: 0o600 });
    this.logStore = new OwnedLogStore('ledger', { ...this.logOptions, home: this.loc.data, publicKeyHex: this.publicKey.toString('hex') });
    const {entries, integrity} = await this.logStore.recover(this.publicKey.toString('hex'));
    this.sequence = entries.length; this.previousHash = entries.at(-1)?.entryHash ?? sdk.GENESIS_PREVIOUS_HASH;
    for (const entry of entries) {
      const decision = entry.decision, meta = decision.plugin;
      if (!meta) continue;
      if (meta.event === 'decision') {
        this.completed.set(`${meta.gate}:${callKey(meta)}`, decision);
        if (decision.action !== 'block') this.pending.set(callKey(meta), decision);
        for (const window of decision.action === 'block' ? [] : meta.chargedWindows ?? []) {
          if (window.windowStart === startWindow(window.window)) await this.spendStore.incrementWindowSpend(window.scopeKey, window.window, meta.chargedCents ?? 0);
        }
      } else if (meta.event === 'fail_open') {
        this.failures.add(`${meta.gate}:${callKey(meta)}`);
        if (governs(meta)) { this.pending.set(callKey(meta), decision); this.completed.set(`${meta.gate}:${callKey(meta)}`, decision); }
      }
      else if (meta.event === 'outcome') this.pending.delete(callKey(meta));
    }
    if (integrity) {
      const decision = this.basic({toolName: 'ledger_integrity', sessionId: 'worker', toolUseId: crypto.randomUUID(), gate: 'spend'}, 'allow', integrity.reason);
      decision.enforcementMode = 'shadow';
      decision.plugin.event = 'integrity';
      decision.plugin.integrity = integrity;
      await this.append(decision);
      this.logStore.clearRecoveredFailureAfter(this.sequence - 1);
    }
    // Import deferred events only after validating the existing chain.
    await this.drainSpool();
  }
  setSessionFailure(sessionId, source, reason) {
    const existing = this.sessionFailures.get(sessionId);
    const failures = existing instanceof Map ? existing : new Map(existing ? [['legacy', existing]] : []);
    failures.set(source, reason);
    this.sessionFailures.set(sessionId, failures);
  }
  clearSessionFailure(sessionId, source) {
    const failures = this.sessionFailures.get(sessionId);
    if (!(failures instanceof Map)) return;
    failures.delete(source);
    if (!failures.size) this.sessionFailures.delete(sessionId);
  }
  preferredSessionFailure(sessionId) {
    const failures = this.sessionFailures.get(sessionId);
    if (!(failures instanceof Map)) return failures;
    const reasons = [...failures.values()];
    return reasons.includes('seat_revoked') ? 'seat_revoked' : reasons.at(-1);
  }
  context(meta) {
    this.orgPolicyDigests.set(meta.sessionId, null);
    const source = require('./policy-file.cjs').readPolicy(this.loc.data);
    let license = this.licenseReader({data: this.loc.data, sessionId: meta.sessionId, policy: source.policy, personalPolicy: source.personal});
    let selected = license.paid || !source.team ? source.policy : source.personal;
    let org = null;
    if (orgEnabled(license)) {
      const key = configuredKey(source.policy);
      org = readCachedOrgPolicy(this.loc.data, {keyFingerprint: key ? crypto.createHash('sha256').update(key).digest('hex') : null});
      if (org.envelope) {
        // Validate each layer before internal merge fields are constructed.
        validatePolicy(source.personal);
        if (source.shared) validatePolicy({...source.personal, ...source.shared});
        selected = mergeOrgPolicy(source.personal, source.shared, org.envelope.policy);
      }
      if (org.reason) license = {...license, mode: 'shadow', reason: license.reason || org.reason};
    }
    selected = {...selected, guardPack: mergeGuardPack(source.personal, license.paid ? source.shared : null, org?.envelope?.policy)};
    if (meta.guardScanReason) {
      if (!['guard_branch_unknown', 'guard_scan_incomplete'].includes(meta.guardScanReason)) throw new Error('guard_scan_reason_invalid');
      license = {...license, mode: 'shadow', reason: license.reason || meta.guardScanReason};
    }
    const text = JSON.stringify(selected);
    if (text !== this.policyText) { this.policyValue = validatePolicy(selected); this.policyText = text; this.guards.clear(); }
    if (org?.envelope) this.orgPolicyDigests.set(meta.sessionId, org.envelope.sha256);
    // The worker can retain a failure even when disk writes themselves fail.
    // A stale ready file must never override the most recent failed refresh.
    const failure = this.preferredSessionFailure(meta.sessionId);
    if (failure) license = {...license, mode: 'shadow', reason: license.reason === 'seat_revoked' ? 'seat_revoked' : failure,
      ...((failure === 'seat_revoked' || license.reason === 'seat_revoked') ? {seatRevoked: true} : {})};
    return {config: this.policyValue, license, orgPolicy: org?.envelope ?? null,
      mode: (license.paid || license.mode === 'enforce') && license.mode !== 'shadow' ? (this.policyValue.mode ?? 'enforce') : 'shadow'};
  }
  licenseMetadata(decision, license, mode) {
    const reason = license.reason || null;
    decision.enforcementMode = mode;
    decision.plugin.license = {paid: license.paid === true, tier: license.tier ?? 'free',
      seatsUsed: license.seatsUsed ?? null, seatLimit: license.seatLimit ?? null,
      expiresAt: license.expiresAt ?? null, mode, reason, offlineGrace: license.offlineGrace === true};
    if (reason) {
      decision.reasons = [reason, ...decision.reasons.filter(value => value !== reason)];
      if (decision.plugin.reasonCode && decision.plugin.reasonCode !== reason) decision.plugin.policyReasonCode = decision.plugin.reasonCode;
      decision.plugin.reasonCode = reason;
    }
    return decision;
  }
  failureLicense(decision, meta) {
    try { const {license, mode} = this.context(meta); this.licenseMetadata(decision, license, mode); }
    catch { this.licenseMetadata(decision, {paid: false, reason: 'license_required', tier: 'free'}, 'shadow'); }
    return decision;
  }
  basic(meta, action, reasonCode, actor = { tenantId: 'local', sessionId: meta.sessionId, agentId: meta.agentId ?? meta.sessionId }) {
    return { decisionId: crypto.randomUUID(), timestamp: new Date().toISOString(), action, actor,
      triggeredCap: null, triggeredScopeKey: null, projectedCents: 0, windowSpendBefore: 0, windowSpendAfter: 0,
      provider: meta.host ?? hostContext().host, modelRequested: meta.toolName, modelResolved: meta.toolName, policyId: basePolicy.id,
      policyVersion: 1, enforcementMode: 'enforce', reasons: [reasonCode], plugin: { host: hostContext().host, ...meta, event: 'decision', reasonCode } };
  }
  async append(decision) {
    const entry = await sdk.signDecision({ sequence: this.sequence, decision, previousHash: this.previousHash, privateKey: this.privateKey, publicKey: this.publicKey });
    await this.logStore.append(entry); this.sequence++; this.previousHash = entry.entryHash;
    return decision;
  }
  afterReply() { this.logStore.afterReply(); }
  async flush() { return this.logStore.flush(); }
  async close() { return this.logStore.close(); }
  notifyStop(config, decision, ruleIds) {
    try { this.stopNotifier({mode: decision.enforcementMode, stopped: decision.action === 'block', ruleIds, notifyOnStop: config.notifyOnStop ?? true}); }
    catch { /* Desktop notification failure must never change a signed decision. */ }
  }
  async failure(meta, reasonCode) {
    const key = `${meta.gate}:${callKey(meta)}`;
    let guard;
    try { guard = guardResult(meta.guardRuleIds ?? [], {}, 'shadow'); } catch { guard = {matches: [], warning: false}; }
    const output = meta.gate === 'receipt' ? {} : {...allow(), ...(guard.warning ? {systemMessage: guard.message} : {})};
    if (this.failures.has(key)) return { output, warning: true, cause: reasonCode };
    const decision = this.basic(meta, 'allow', reasonCode);
    decision.plugin.event = 'fail_open';
    if (guard.matches.length) { decision.plugin.guardPack = guard.matches; decision.plugin.guardPackMessage = guard.message; }
    this.failureLicense(decision, meta);
    await this.append(decision);
    this.failures.add(key);
    if (governs(meta)) { this.pending.set(callKey(meta), decision); this.completed.set(key, decision); }
    return { output, warning: true, cause: reasonCode };
  }
  async drainSpool() {
    const batch = this.loc.spool + '.recovering';
    // Recover an interrupted batch before handing off a fresh one. Rename BEFORE
    // reading so a concurrent client's append cannot be discarded unseen.
    if (!fs.existsSync(batch)) {
      try { fs.renameSync(this.loc.spool, batch); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    }
    const text = fs.readFileSync(batch, 'utf8');
    for (const line of text.split('\n').filter(Boolean)) await this.failure(JSON.parse(line), 'deferred_fail_open');
    fs.unlinkSync(batch);
  }
  async handle(message) {
    const meta = {host: hostContext().host, ...message.meta};
    try {
      await this.drainSpool();
      if (meta.gate === 'receipt') return await this.receipt(meta);
      if (meta.gate === 'spend' && SPAWN.has(meta.toolName)) return { output: allow() };
      const previous = this.completed.get(`${meta.gate}:${callKey(meta)}`);
      if (previous) {
        if (previous.action !== 'block') return {output: {...allow(), ...(previous.plugin.guardPackMessage ? {systemMessage: previous.plugin.guardPackMessage} : {})}};
        // A prior denial must not survive a switch to shadow mode.
        const {mode} = this.context(meta);
        if (mode === 'enforce') return {output: deny(previous.reasons.join('; '))};
      }
      if (meta.gate === 'burn') return await this.burn(meta, message.transcriptPath, message.workingDirectory);
      return await this.spend(meta);
    } catch { return await this.failure(meta, 'policy_or_runtime_error'); }
  }
  async burn(meta, transcriptPath, workingDirectory) {
    const {config, license, mode} = this.context(meta);
    const guard = guardResult(meta.guardRuleIds ?? [], config.guardPack, mode);
    if (guard.stop) {
      const blocked = this.basic(meta, 'block', 'guard_pack'); blocked.reasons = [guard.message];
      blocked.plugin.guardPack = guard.matches; blocked.plugin.guardPackMessage = guard.message;
      this.licenseMetadata(blocked, license, mode); await this.append(blocked);
      this.completed.set(`burn:${callKey(meta)}`, blocked);
      this.notifyStop(config, blocked, guard.matches.filter(rule => rule.action === 'stop').map(rule => rule.id));
      return {output: deny(guard.message)};
    }
    if (matchingExternalBurn(meta, workingDirectory)) {
      if (SPAWN.has(meta.toolName)) {
        const mirror = this.basic(meta, 'shadow', 'burn_external_hook');
        if (guard.matches.length) { mirror.plugin.guardPack = guard.matches; mirror.plugin.guardPackMessage = guard.message; }
        this.licenseMetadata(mirror, license, mode);
        await this.append(mirror); this.completed.set(`burn:${callKey(meta)}`, mirror);
        this.pending.set(callKey(meta), mirror);
      }
      return {output: {...allow(), ...(guard.warning ? {systemMessage: guard.message} : {})}};
    }
    if (!this.gateway) this.gateway = new burn.Gateway(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'));
    let decision;
    const original = this.gateway.beforeSpawn;
    let output, observationFailed = false;
    // Burn 0.2.3 has no policy override parameter. Its synchronous gateway
    // reads this CommonJS export before reserving or signing. Temporarily
    // adapting that read keeps its real home, ledger and receipt semantics,
    // including shadow mode, without rewriting the user's policy file.
    const policyModule = Object.values(require.cache).find(module => {
      const descriptor = Object.getOwnPropertyDescriptor(module.exports ?? {}, 'loadPolicy');
      return descriptor?.writable === true && descriptor.value === burn.loadPolicy;
    });
    if (mode === 'shadow' && !policyModule) throw new Error('burn_policy_adapter_unavailable');
    const loadPolicy = policyModule?.exports.loadPolicy;
    this.gateway.beforeSpawn = (...args) => { decision = original.apply(this.gateway, args); return decision; };
    if (mode === 'shadow') policyModule.exports.loadPolicy = (...args) => ({...loadPolicy(...args), mode: 'shadow'});
    const stderrWrite = process.stderr.write;
    process.stderr.write = () => { observationFailed = true; return true; };
    try { output = runBurnHook(burn, this.gateway, meta, transcriptPath); }
    finally { this.gateway.beforeSpawn = original; process.stderr.write = stderrWrite; if (mode === 'shadow') policyModule.exports.loadPolicy = loadPolicy; }
    if (decision?.failedClosed || observationFailed) throw new Error('burn_internal_error');
    if (decision) {
      const mirror = this.basic(meta, mode === 'shadow' && !license.paid ? 'shadow' : (decision.blocked ? 'block' : decision.wouldBlock ? 'shadow' : 'allow'), `burn_${decision.verdict.toLowerCase()}`);
      mirror.enforcementMode = decision.mode;
      mirror.plugin.burnReceiptId = decision.receipt?.receiptId ?? decision.decisionId;
      if (guard.matches.length) { mirror.plugin.guardPack = guard.matches; mirror.plugin.guardPackMessage = guard.message; }
      this.licenseMetadata(mirror, license, decision.mode);
      await this.append(mirror); this.completed.set(`burn:${callKey(meta)}`, mirror);
      if (decision.verdict === 'STOP' && decision.blocked) this.notifyStop(config, mirror, decision.report.findings.filter(finding => finding.verdict === 'STOP').map(finding => finding.detector));
      if (!decision.blocked) this.pending.set(callKey(meta), mirror);
    }
    if (output.hookSpecificOutput?.permissionDecision === 'deny') return { output: deny(output.hookSpecificOutput.permissionDecisionReason) };
    const messages = [output.systemMessage, guard.warning ? guard.message : null].filter(Boolean);
    return { output: { ...allow(), ...(messages.length ? { systemMessage: messages.join(' ').replace(/[\r\n]+/g, ' ') } : {}) } };
  }
  async spend(meta) {
    const {config, license, mode} = this.context(meta), session = config.sessions?.[meta.sessionId] ?? {};
    const guard = guardResult(meta.guardRuleIds ?? [], config.guardPack, mode);
    const match = /^mcp__(.+?)__(.+)$/.exec(meta.toolName);
    const provider = match?.[1] ?? meta.host ?? hostContext().host, model = match?.[2] ?? meta.toolName;
    const actor = { tenantId: config.tenantId ?? 'local', sessionId: meta.sessionId, agentId: meta.agentId ?? session.agentId ?? meta.sessionId,
      ...((session.matterId ?? config.defaultMatterId) ? { taskId: session.matterId ?? config.defaultMatterId } : {}), provider };
    let capability = minimumCapability(meta.toolName);
    const payment = new RegExp(config.paymentPattern ?? 'payment|pay_|charge|transfer|checkout|purchase', 'i').test(`${provider} ${model}`);
    if (payment) capability = 'payment_initiate';
    const minimumClassification = capability;
    let unitCostCents = 0, requiredCapability;
    for (const rule of config.toolRules ?? []) if (new RegExp(rule.pattern, 'i').test(meta.toolName)) {
      capability = rule.capability ?? capability; unitCostCents = rule.unitCostCents ?? unitCostCents;
      requiredCapability = rule.requiredCapability ?? requiredCapability;
    }
    if (tiers.indexOf(capability) < tiers.indexOf(minimumClassification)) capability = minimumClassification;
    let reason = guard.stop ? guard.message : undefined;
    for (const scope of [config, session]) {
      const allowlists = scope.allowedToolGroups ?? (scope.allowedTools === undefined ? [] : [scope.allowedTools]);
      if (allowlists.some(patterns => !matches(patterns, meta.toolName))) reason = 'tool_not_allowlisted';
      if (matches(scope.deniedTools, meta.toolName)) reason = 'tool_denied';
      if (matches(scope.ethicalWall, meta.toolName)) reason = 'ethical_wall';
      if (scope.maxCapability && tiers.indexOf(capability) > tiers.indexOf(scope.maxCapability)) reason = 'capability_tier_exceeded';
    }
    let decision;
    const caps = [...(config.caps ?? []), ...(session.caps ?? []).map(cap => ({ ...cap, selector: { ...cap.selector, sessionId: meta.sessionId } }))]
      .map(cap => ({ ...cap, action: cap.action ?? 'block' }));
    const policy = { ...basePolicy, scope: { tenantId: actor.tenantId }, mode, caps, ...(requiredCapability ? { requiredCapability } : {}) };
    const call = {scope: actor, provider, model, inputTokens: 1000, outputTokens: 0, capabilityClaim: capability};
    if (reason && mode === 'enforce') decision = this.basic(meta, 'block', reason, actor);
    else {
      sdk.setCostOverride(model, {inputCentsPerKtok: unitCostCents, outputCentsPerKtok: 0});
      // The public policy evaluator is local and already handles scoped caps.
      // Session startup owns license resolution; no SDK license request belongs
      // inside this hook's decision path.
      decision = await sdk.evaluatePolicy(policy, call, this.spendStore);
      const basis = sdk.costBasisFor(decision.modelResolved);
      if (basis) decision.costBasis = basis;
      decision.reasons = [reason ?? (decision.action === 'block' ? 'spend_or_capability_policy_blocked' : decision.action === 'shadow' ? 'shadow_policy_would_block' : 'tool_policy_allowed')];
      if (mode === 'shadow' && decision.action === 'block') {
        // Capability gates normally fail closed even in the SDK's shadow mode.
        // The shadow fallback observes every tool, including these calls, and keeps
        // their actual configured unit cost in its shared window accounting.
        await sdk.adjustPolicyWindowSpend(policy, this.spendStore, unitCostCents, call);
        decision.projectedCents = unitCostCents;
        decision.action = 'shadow';
      }
      if (mode === 'shadow' && (!license.paid || reason)) decision.action = 'shadow';
      if (guard.warning && decision.action === 'allow') decision.action = 'shadow';
    }
    const windows = new Map();
    if (decision.action !== 'block') for (const cap of caps) {
      if (cap.window === 'per_call' || Object.entries(cap.selector ?? {}).some(([key, value]) => actor[key] !== value)) continue;
      const scopeKey = sdk.buildScopeKey({ ...policy.scope, ...cap.selector });
      windows.set(`${scopeKey}:${cap.window}`, { scopeKey, window: cap.window, windowStart: startWindow(cap.window) });
    }
    decision.plugin = { ...meta, event: 'decision', capabilityTier: capability, unitCostCents,
      chargedCents: decision.action === 'block' ? 0 : unitCostCents, chargedWindows: [...windows.values()],
      ...(reason ? { reasonCode: reason } : {}) };
    if (guard.matches.length) { decision.plugin.guardPack = guard.matches; decision.plugin.guardPackMessage = guard.message; decision.reasons.push(...guard.matches.filter(item => item.action !== 'off').map(item => `guard_pack:${item.id}:${item.action}`)); }
    this.licenseMetadata(decision, license, mode);
    await this.append(decision); this.completed.set(`spend:${callKey(meta)}`, decision);
    if (decision.action === 'block' && mode === 'enforce') {
      const ids = guard.matches.filter(rule => rule.action === 'stop').map(rule => rule.id);
      this.notifyStop(config, decision, ids.length ? ids : [decision.triggeredCap ? `cap:${decision.triggeredCap.window}` : reason || 'tool_policy']);
    }
    if (decision.action !== 'block') this.pending.set(callKey(meta), decision);
    return { output: decision.action === 'block' ? deny(decision.reasons.join('; ')) : {...allow(), ...(guard.warning ? {systemMessage: guard.message} : {})} };
  }
  async receipt(meta) {
    const original = this.pending.get(callKey(meta));
    if (!original) return this.failure(meta, 'outcome_without_decision');
    const durationMs = meta.durationMs ?? Math.max(0, Date.now() - Date.parse(original.timestamp));
    const { decision } = await this.outcomes.recordOutcomeReceipt({ flow: outcomeFlow(meta), decisionId: original.decisionId,
      status: meta.success === null ? 'unknown' : meta.success ? 'completed' : 'failed', durationMs, outputBytes: meta.outputBytes,
      totalCostCents: original.plugin.unitCostCents ?? 0 });
    decision.originalDecisionId = original.decisionId; decision.actor = original.actor;
    decision.plugin = { ...meta, event: 'outcome', decisionId: original.decisionId, durationMs, durationSource: meta.durationSource ?? 'elapsed_since_decision' };
    this.failureLicense(decision, meta);
    await this.append(decision); this.pending.delete(callKey(meta));
    return { output: {} };
  }
}
module.exports = { Engine, validatePolicy };
