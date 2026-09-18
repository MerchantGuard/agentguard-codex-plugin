'use strict';
// The worker is local-only, including when a configured licence needs refreshing.
process.env.AGENTGUARD_NO_BEACON = '1';
process.env.AGENTGUARD_TELEMETRY = '0';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
const burn = require('./dependencies.cjs').loadDependency('@agentguard-run/burn');
const { OwnedLogStore } = require('./owned-log.cjs');
const { locations, allow, deny, SPAWN } = require('./common.cjs');
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
  const configs = [policy, ...Object.values(policy.sessions ?? {})];
  for (const config of configs) {
    if (!config || typeof config !== 'object') throw new Error('policy_invalid');
    if (config.maxCapability !== undefined && !tiers.includes(config.maxCapability)) throw new Error('policy_invalid');
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
  constructor() {
    this.loc = locations(); this.spendStore = new sdk.InMemorySpendStore(); this.pending = new Map(); this.completed = new Map(); this.failures = new Set();
    this.outcomes = new sdk.SpendGuard({ policy: basePolicy, spendStore: this.spendStore, licensePostJson: offline });
    this.guards = new Map();
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
    this.logStore = new OwnedLogStore('ledger', { home: this.loc.data, publicKeyHex: this.publicKey.toString('hex') });
    const file = path.join(this.loc.data, 'ledger', 'decisions.ndjson');
    let entries = [];
    try { entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!(await sdk.verifyChain(entries, this.publicKey)).ok) throw new Error('invalid_existing_chain');
    this.logStore.initializeHead(entries, this.publicKey.toString('hex'));
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
    // Import deferred events only after validating the existing chain.
    await this.drainSpool();
  }
  policy() {
    const filename = process.env.AGENTGUARD_PLUGIN_POLICY || path.join(this.loc.data, 'policy.json');
    let text;
    try { text = fs.readFileSync(filename, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT' || process.env.AGENTGUARD_PLUGIN_POLICY) throw e; text = fs.readFileSync(path.join(__dirname, '..', 'config', 'default-policy.json'), 'utf8'); }
    if (text !== this.policyText) { this.policyValue = validatePolicy(JSON.parse(text)); this.policyText = text; this.guards.clear(); }
    return this.policyValue;
  }
  basic(meta, action, reasonCode, actor = { tenantId: 'local', sessionId: meta.sessionId, agentId: meta.agentId ?? meta.sessionId }) {
    return { decisionId: crypto.randomUUID(), timestamp: new Date().toISOString(), action, actor,
      triggeredCap: null, triggeredScopeKey: null, projectedCents: 0, windowSpendBefore: 0, windowSpendAfter: 0,
      provider: 'codex', modelRequested: meta.toolName, modelResolved: meta.toolName, policyId: basePolicy.id,
      policyVersion: 1, enforcementMode: 'enforce', reasons: [reasonCode], plugin: { ...meta, event: 'decision', reasonCode } };
  }
  async append(decision) {
    const entry = await sdk.signDecision({ sequence: this.sequence, decision, previousHash: this.previousHash, privateKey: this.privateKey, publicKey: this.publicKey });
    await this.logStore.append(entry); this.sequence++; this.previousHash = entry.entryHash;
    return decision;
  }
  async failure(meta, reasonCode) {
    const key = `${meta.gate}:${callKey(meta)}`;
    if (this.failures.has(key)) return { output: meta.gate === 'receipt' ? {} : allow(), warning: true };
    const decision = this.basic(meta, 'allow', reasonCode);
    decision.plugin.event = 'fail_open';
    await this.append(decision);
    this.failures.add(key);
    if (governs(meta)) { this.pending.set(callKey(meta), decision); this.completed.set(key, decision); }
    return { output: meta.gate === 'receipt' ? {} : allow(), warning: true };
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
    const meta = message.meta;
    try {
      await this.drainSpool();
      if (meta.gate === 'receipt') return await this.receipt(meta);
      if (meta.gate === 'spend' && SPAWN.has(meta.toolName)) return { output: allow() };
      const previous = this.completed.get(`${meta.gate}:${callKey(meta)}`);
      if (previous) return { output: previous.action === 'block' ? deny(previous.reasons.join('; ')) : allow() };
      if (meta.gate === 'burn') return await this.burn(meta, message.transcriptPath);
      return await this.spend(meta);
    } catch { return await this.failure(meta, 'policy_or_runtime_error'); }
  }
  async burn(meta, transcriptPath) {
    if (!this.gateway) this.gateway = new burn.Gateway(process.env.AGENTGUARD_HOME || path.join(os.homedir(), '.agentguard'));
    let decision;
    const original = this.gateway.beforeSpawn;
    this.gateway.beforeSpawn = (...args) => { decision = original.apply(this.gateway, args); return decision; };
    let output, observationFailed = false;
    const stderrWrite = process.stderr.write;
    process.stderr.write = () => { observationFailed = true; return true; };
    try { output = burn.handleCodexHook({ session_id: meta.sessionId, tool_name: meta.toolName,
      tool_use_id: meta.toolUseId, hook_event_name: 'PreToolUse', transcript_path: transcriptPath }, this.gateway); }
    finally { this.gateway.beforeSpawn = original; process.stderr.write = stderrWrite; }
    if (decision?.failedClosed || observationFailed) throw new Error('burn_internal_error');
    if (decision) {
      const mirror = this.basic(meta, decision.blocked ? 'block' : 'allow', `burn_${decision.verdict.toLowerCase()}`);
      mirror.enforcementMode = decision.mode;
      mirror.plugin.burnReceiptId = decision.receipt?.receiptId ?? decision.decisionId;
      await this.append(mirror); this.completed.set(`burn:${callKey(meta)}`, mirror);
      if (!decision.blocked) this.pending.set(callKey(meta), mirror);
    }
    if (output.hookSpecificOutput?.permissionDecision === 'deny') return { output: deny(output.hookSpecificOutput.permissionDecisionReason) };
    return { output: { ...allow(), ...(output.systemMessage ? { systemMessage: output.systemMessage.replace(/[\r\n]+/g, ' ') } : {}) } };
  }
  async spend(meta) {
    const config = this.policy(), session = config.sessions?.[meta.sessionId] ?? {};
    const match = /^mcp__(.+?)__(.+)$/.exec(meta.toolName);
    const provider = match?.[1] ?? 'codex', model = match?.[2] ?? meta.toolName;
    const actor = { tenantId: config.tenantId ?? 'local', sessionId: meta.sessionId, agentId: meta.agentId ?? session.agentId ?? meta.sessionId,
      ...((session.matterId ?? config.defaultMatterId) ? { taskId: session.matterId ?? config.defaultMatterId } : {}), provider };
    let capability = /^(Bash|apply_patch|Edit|Write)$/i.test(meta.toolName) ? 'data_write' : 'read_only';
    const payment = new RegExp(config.paymentPattern ?? 'payment|pay_|charge|transfer|checkout|purchase', 'i').test(`${provider} ${model}`);
    if (payment) capability = 'payment_initiate';
    const minimumClassification = capability;
    let unitCostCents = 0, requiredCapability;
    for (const rule of config.toolRules ?? []) if (new RegExp(rule.pattern, 'i').test(meta.toolName)) {
      capability = rule.capability ?? capability; unitCostCents = rule.unitCostCents ?? unitCostCents;
      requiredCapability = rule.requiredCapability ?? requiredCapability;
    }
    if (tiers.indexOf(capability) < tiers.indexOf(minimumClassification)) capability = minimumClassification;
    let reason;
    for (const scope of [config, session]) {
      if (scope.allowedTools && !matches(scope.allowedTools, meta.toolName)) reason = 'tool_not_allowlisted';
      if (matches(scope.deniedTools, meta.toolName)) reason = 'tool_denied';
      if (matches(scope.ethicalWall, meta.toolName)) reason = 'ethical_wall';
      if (scope.maxCapability && tiers.indexOf(capability) > tiers.indexOf(scope.maxCapability)) reason = 'capability_tier_exceeded';
    }
    let decision;
    const caps = [...(config.caps ?? []), ...(session.caps ?? []).map(cap => ({ ...cap, selector: { ...cap.selector, sessionId: meta.sessionId } }))]
      .map(cap => ({ ...cap, action: cap.action ?? 'block' }));
    const policy = { ...basePolicy, scope: { tenantId: actor.tenantId }, mode: config.mode ?? 'enforce', caps, ...(requiredCapability ? { requiredCapability } : {}) };
    if (reason) decision = this.basic(meta, 'block', reason, actor);
    else {
      sdk.setCostOverride(model, { inputCentsPerKtok: unitCostCents, outputCentsPerKtok: 0 });
      const cacheKey = JSON.stringify(policy);
      let guard = this.guards.get(cacheKey);
      if (!guard) { guard = new sdk.SpendGuard({ policy, spendStore: this.spendStore, licensePostJson: offline }); this.guards.set(cacheKey, guard); }
      ({ decision } = await guard.decide({ scope: actor, provider, model, inputTokens: 1000, outputTokens: 0, capabilityClaim: capability }));
      // Only operator identifiers and numeric pricing metadata reach the ledger.
      decision.reasons = [decision.action === 'block' ? 'spend_or_capability_policy_blocked' : decision.action === 'shadow' ? 'shadow_policy_would_block' : 'tool_policy_allowed'];
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
    await this.append(decision); this.completed.set(`spend:${callKey(meta)}`, decision);
    if (decision.action !== 'block') this.pending.set(callKey(meta), decision);
    return { output: decision.action === 'block' ? deny(decision.reasons.join('; ')) : allow() };
  }
  async receipt(meta) {
    const original = this.pending.get(callKey(meta));
    if (!original) return this.failure(meta, 'outcome_without_decision');
    const durationMs = meta.durationMs ?? Math.max(0, Date.now() - Date.parse(original.timestamp));
    const { decision } = await this.outcomes.recordOutcomeReceipt({ flow: 'codex-tool', decisionId: original.decisionId,
      status: meta.success === null ? 'unknown' : meta.success ? 'completed' : 'failed', durationMs, outputBytes: meta.outputBytes,
      totalCostCents: original.plugin.unitCostCents ?? 0 });
    decision.originalDecisionId = original.decisionId; decision.actor = original.actor;
    decision.plugin = { ...meta, event: 'outcome', decisionId: original.decisionId, durationMs, durationSource: meta.durationSource ?? 'elapsed_since_decision' };
    await this.append(decision); this.pending.delete(callKey(meta));
    return { output: {} };
  }
}
module.exports = { Engine, validatePolicy };
