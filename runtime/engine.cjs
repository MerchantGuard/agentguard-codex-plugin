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
const {readSessionLicense} = require('./license.cjs');
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
const CHARGE_FOLD = 2048;
const BUILT_IN = {plugin_state: 'AgentGuard protects its own policy, approval and worker files.', policy_cli: 'Policy changes and approvals belong to the operator, in the operator\'s own terminal.'};

const {validatePolicy} = require('./policy-schema.cjs');

class Engine {
  constructor(options = {}) {
    this.licenseReader = options.licenseReader ?? readSessionLicense;
    this.stopNotifier = options.stopNotifier ?? notifyStop;
    this.logOptions = options.logOptions ?? {};
    this.loc = locations(); this.spendStore = new sdk.InMemorySpendStore(); this.pending = new Map(); this.completed = new Map(); this.failures = new Set(); this.computedBlocks = new Map();
    this.outcomes = new sdk.SpendGuard({ policy: basePolicy, spendStore: this.spendStore, licensePostJson: offline });
    this.sessionCharges = new Map(); this.guards = new Map(); this.orgPolicyDigests = new Map(); this.sessionFailures = new Map();
  }
  // Session charges are folded per session so a long session cannot grow the
  // worker without bound or slow every later cap check.
  addCharge(actor, cents) {
    const list = this.sessionCharges.get(actor.sessionId) ?? [];
    list.push({actor, cents});
    if (list.length > CHARGE_FOLD) {
      const folded = new Map();
      for (const charge of list) { const key = JSON.stringify(charge.actor); folded.set(key, {actor: charge.actor, cents: (folded.get(key)?.cents ?? 0) + charge.cents}); }
      list.length = 0; list.push(...folded.values());
    }
    this.sessionCharges.set(actor.sessionId, list);
  }
  chargeCount(sessionId) { return this.sessionCharges.get(sessionId)?.length ?? 0; }
  charges(sessionId) { return this.sessionCharges.get(sessionId) ?? []; }
  // A worker-side policy sync failure for a Solo license is written to the
  // status file so the hook and the worker read one state; Team failures stay
  // in memory, where a stale ready file must never override them.
  recordOrgFailure(sessionId, reason) {
    this.setSessionFailure(sessionId, 'org', reason);
    try {
      const source = require('./policy-file.cjs').readPolicy(this.loc.data);
      const license = this.licenseReader({data: this.loc.data, sessionId, policy: source.policy, personalPolicy: source.personal});
      if (require('./org-policy.cjs').soloEnabled(license)) require('./org-policy-refresh.cjs').recordSyncFailure(this.loc.data, source.policy, reason);
    } catch { /* The in-memory failure still applies to this worker. */ }
  }
  decorate(output, license) {
    // A display-only upgrade moment can never turn a deny into an allow.
    try { return require('./upgrade-moments.cjs').stopMoment(output, license); } catch { return output; }
  }
  async init() {
    fs.mkdirSync(this.loc.data, { recursive: true, mode: 0o700 });
    require('./upgrade-moments.cjs').registerLedger(this.loc.data);
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
        if (meta.gate === 'spend' && decision.action !== 'block' && meta.chargedCents) this.addCharge(decision.actor, meta.chargedCents);
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
    const failures = this.sessionFailures.get(meta.sessionId);
    const state = require('./policy-state.cjs').policyState(this.loc.data, meta.sessionId, {licenseReader: this.licenseReader});
    let {config: selected, license} = state;
    const org = state.orgPolicy ? {envelope: state.orgPolicy} : null;
    // A Guard Pack scan the hook could not finish keeps enforce mode: raw-text
    // matches still stop, and command rules, caps and the built-in stops apply.
    // A branch the hook could not read warns only for the branch-dependent
    // history rules (GP003, GP004); nothing else is softened silently.
    if (meta.guardScanReason && !['guard_branch_unknown', 'guard_scan_incomplete'].includes(meta.guardScanReason)) throw new Error('guard_scan_reason_invalid');
    const text = JSON.stringify(selected);
    if (text !== this.policyText) { this.policyValue = validatePolicy(selected); this.policyText = text; this.guards.clear(); }
    if (org?.envelope) this.orgPolicyDigests.set(meta.sessionId, org.envelope.sha256);
    // The worker can retain a failure even when disk writes themselves fail.
    // A stale ready file must never override the most recent failed refresh.
    let failure = this.preferredSessionFailure(meta.sessionId);
    if (require('./org-policy.cjs').soloEnabled(license) && failures instanceof Map) {
      const reasons = [...failures].filter(([source]) => source !== 'org').map(([, reason]) => reason);
      failure = reasons.includes('seat_revoked') ? 'seat_revoked' : reasons.at(-1);
    }
    if (failure) license = {...license, mode: 'shadow', reason: license.reason === 'seat_revoked' ? 'seat_revoked' : failure,
      ...((failure === 'seat_revoked' || license.reason === 'seat_revoked') ? {seatRevoked: true} : {})};
    const mode = (license.paid || license.mode === 'enforce') && license.mode !== 'shadow' ? (this.policyValue.mode ?? 'enforce') : 'shadow';
    return {config: this.policyValue, license, orgPolicy: org?.envelope ?? null, mode};
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
    catch (error) {
      // A policy file that fails validation is recorded as exactly that, so a
      // fail-open row never reads as a licensing problem.
      const reason = /policy|pattern|rule|quantif|ENOENT|EACCES|EISDIR|readable/i.test(error?.message ?? '') ? 'policy_invalid' : 'license_required';
      this.licenseMetadata(decision, {paid: false, reason, tier: 'free'}, 'shadow');
    }
    return decision;
  }
  basic(meta, action, reasonCode, actor = { tenantId: 'local', sessionId: meta.sessionId, agentId: meta.agentId ?? meta.sessionId }) {
    return { decisionId: crypto.randomUUID(), timestamp: new Date().toISOString(), action, actor,
      triggeredCap: null, triggeredScopeKey: null, projectedCents: 0, windowSpendBefore: 0, windowSpendAfter: 0,
      provider: meta.host ?? hostContext().host, modelRequested: meta.toolName, modelResolved: meta.toolName, policyId: basePolicy.id,
      policyVersion: 1, enforcementMode: 'enforce', reasons: [reasonCode], plugin: { host: hostContext().host, ...meta, event: 'decision', reasonCode } };
  }
  // Operator consent for a benchmark run: one signed ledger row, and a small
  // file naming that row so the benchmark hook can find and verify it. A later
  // row with granted false revokes it. Only the daemon writes here.
  async benchmarkConsent(runId, granted = true) {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(runId)) throw new Error('benchmark_run_id_invalid');
    const decision = this.basic({toolName: 'benchmark', sessionId: 'operator', toolUseId: runId, gate: 'control'}, 'allow', granted ? 'benchmark_consent' : 'benchmark_consent_revoked');
    decision.plugin = {...decision.plugin, event: 'benchmark_consent', runId, granted: granted === true};
    const sequence = this.sequence;
    await this.append(decision);
    const file = path.join(this.loc.data, 'benchmark-consent.json');
    if (granted) {
      const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({version: 1, run_id: runId, sequence, entry_hash: this.previousHash, issued_at: decision.timestamp}) + '\n', {flag: 'wx', mode: 0o600});
      fs.renameSync(temporary, file);
    } else { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return {sequence, entryHash: this.previousHash, granted: granted === true};
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
    // A policy the worker could not read or validate, or a scan it could not
    // run, falls back to the built-in guard pack at its defaults in enforce:
    // a definite STOP match still stops, everything else is allowed with the
    // failure recorded. Unknown branch evidence softens only the history rules.
    let guard;
    try { guard = guardResult(meta.guardRuleIds ?? [], {}, meta.gate === 'receipt' ? 'shadow' : 'enforce', meta.guardScanReason === 'guard_branch_unknown' ? ['GP003', 'GP004'] : []); } catch { guard = {matches: [], warning: false, stop: false}; }
    const output = meta.gate === 'receipt' ? {} : guard.stop ? deny(guard.message) : {...allow(), ...(guard.warning ? {systemMessage: guard.message} : {})};
    if (this.failures.has(key)) return { output, warning: true, cause: reasonCode };
    const decision = this.basic(meta, guard.stop ? 'block' : 'allow', reasonCode);
    decision.plugin.event = guard.stop ? 'fail_closed' : 'fail_open';
    if (guard.stop) decision.reasons = [reasonCode, guard.message];
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
      // A command scan the hook could not run at all is recorded as exactly that.
      if (meta.commandScanFailed) return await this.failure(meta, 'scan_incomplete');
      const previous = this.completed.get(`${meta.gate}:${callKey(meta)}`);
      if (previous && !previous.plugin.approvalNeeded) {
        if (previous.action !== 'block') return {output: {...(previous.plugin.approvalRuleId ? {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `AgentGuard ${previous.plugin.approvalRuleId} requires your approval for this call.`}} : allow()), ...(previous.plugin.guardPackMessage ? {systemMessage: previous.plugin.guardPackMessage} : {})}};
        // A prior denial must not survive a switch to shadow mode.
        const {mode} = this.context(meta);
        if (mode === 'enforce') return {output: deny(previous.reasons.join('; '))};
      }
      if (meta.gate === 'burn') return await this.burn(meta, message.transcriptPath, message.workingDirectory);
      return await this.spend(meta);
    } catch {
      // A block the worker had already decided is returned as that block even
      // when the ledger append that followed it failed; the row is kept aside.
      const computed = this.computedBlocks.get(`${meta.gate}:${callKey(meta)}`);
      if (computed) { this.computedBlocks.delete(`${meta.gate}:${callKey(meta)}`); this.keepAside(computed.decision); return {output: this.decorate(computed.output, computed.license), warning: true, cause: 'ledger_append_failed'}; }
      return await this.failure(meta, 'policy_or_runtime_error');
    }
  }
  // Rows the ledger refused (a full disk, a file changed outside the worker)
  // are kept beside it so the audit trail shows the gap; they carry no
  // signature because the chain could not take them.
  keepAside(decision) {
    try {
      const file = path.join(this.loc.data, 'ledger', 'unrecorded.ndjson');
      fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      fs.appendFileSync(file, JSON.stringify({keptAsideAt: new Date().toISOString(), decision}) + '\n', {mode: 0o600});
    } catch { /* Nothing else can be done for this row. */ }
  }
  async burn(meta, transcriptPath, workingDirectory) {
    const {config, license, mode} = this.context(meta);
    const guard = guardResult(meta.guardRuleIds ?? [], config.guardPack, mode, meta.guardScanReason === 'guard_branch_unknown' ? ['GP003', 'GP004'] : []);
    if (guard.stop) {
      const blocked = this.basic(meta, 'block', 'guard_pack'); blocked.reasons = [guard.message];
      blocked.plugin.guardPack = guard.matches; blocked.plugin.guardPackMessage = guard.message;
      this.licenseMetadata(blocked, license, mode);
      this.computedBlocks.set(`burn:${callKey(meta)}`, {decision: blocked, output: deny(guard.message), license: {...license, mode}});
      await this.append(blocked); this.computedBlocks.delete(`burn:${callKey(meta)}`);
      this.completed.set(`burn:${callKey(meta)}`, blocked);
      this.notifyStop(config, blocked, guard.matches.filter(rule => rule.action === 'stop').map(rule => rule.id));
      return {output: this.decorate(deny(guard.message), {...license, mode})};
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
    if (output.hookSpecificOutput?.permissionDecision === 'deny') return { output: this.decorate(deny(output.hookSpecificOutput.permissionDecisionReason), {...license, mode}) };
    const messages = [output.systemMessage, guard.warning ? guard.message : null].filter(Boolean);
    return { output: { ...allow(), ...(messages.length ? { systemMessage: messages.join(' ').replace(/[\r\n]+/g, ' ') } : {}) } };
  }
  async spend(meta) {
    const {config, license, mode} = this.context(meta), session = config.sessions?.[meta.sessionId] ?? {};
    const guard = guardResult(meta.guardRuleIds ?? [], config.guardPack, mode, meta.guardScanReason === 'guard_branch_unknown' ? ['GP003', 'GP004'] : []);
    if (meta.builtInStop !== undefined && !Object.hasOwn(BUILT_IN, meta.builtInStop)) throw new Error('built_in_stop_invalid');
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
    const command = require('./command-policy.cjs').commandResult(config, meta);
    // The built-in stop is not a configurable rule: no layer can turn it off.
    let reason = guard.stop ? guard.message : meta.builtInStop ? `built_in:${meta.builtInStop}` : command?.action === 'block' ? `command_rule:${command.id}` : undefined;
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
    const sessionCap = caps.find(cap => cap.window === 'per_session' && cap.action !== 'allow'
      && !Object.entries(cap.selector ?? {}).some(([key, value]) => actor[key] !== value)
      && this.charges(meta.sessionId).filter(charge => charge.actor.tenantId === actor.tenantId
        && Object.entries(cap.selector ?? {}).every(([key, value]) => charge.actor[key] === value)).reduce((sum, charge) => sum + charge.cents, 0) + unitCostCents > cap.amountCents);
    if (sessionCap && sessionCap.action === 'block') reason ||= 'cap:per_session';
    let approvalOutput;
    if (!reason && command?.action === 'ask' && mode === 'enforce') {
      if (meta.host === 'claude-code') approvalOutput = {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `AgentGuard ${command.id} requires your approval for this call.`}};
      else if (!require('./policy-approval.cjs').consume(this.loc.data, meta, config)) {
        // The token never reaches the model or the ledger. The operator lists
        // held calls with `policy-cli pending` in their own terminal.
        require('./policy-approval.cjs').requestApproval(this.loc.data, meta, config, Date.now(), command.id);
        const message = `AgentGuard ${command.id} requires operator confirmation. The operator runs node runtime/policy-cli.cjs pending in their own terminal, approves this exact call, and then this call can be retried within five minutes.`;
        const held = this.basic(meta, 'block', `approval_required:${command.id}`, actor); held.plugin.approvalNeeded = true;
        if (meta.guardScanReason) held.reasons.push(`guard_scan:${meta.guardScanReason}`);
        this.licenseMetadata(held, license, mode); await this.append(held); this.completed.set(`spend:${callKey(meta)}`, held);
        return {output: deny(message)};
      }
    }
    const policy = { ...basePolicy, scope: { tenantId: actor.tenantId }, mode, caps: caps.filter(cap => cap.window !== 'per_session'), ...(requiredCapability ? { requiredCapability } : {}) };
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
      if ((guard.warning || sessionCap) && decision.action === 'allow') decision.action = 'shadow';
    }
    const windows = new Map();
    if (decision.action !== 'block') for (const cap of caps) {
      if (['per_call', 'per_session'].includes(cap.window) || Object.entries(cap.selector ?? {}).some(([key, value]) => actor[key] !== value)) continue;
      const scopeKey = sdk.buildScopeKey({ ...policy.scope, ...cap.selector });
      windows.set(`${scopeKey}:${cap.window}`, { scopeKey, window: cap.window, windowStart: startWindow(cap.window) });
    }
    decision.plugin = { ...meta, event: 'decision', capabilityTier: capability, unitCostCents,
      chargedCents: decision.action === 'block' ? 0 : unitCostCents, chargedWindows: [...windows.values()],
      ...(reason ? { reasonCode: reason } : {}) };
    if (guard.matches.length) { decision.plugin.guardPack = guard.matches; decision.plugin.guardPackMessage = guard.message; decision.reasons.push(...guard.matches.filter(item => item.action !== 'off').map(item => `guard_pack:${item.id}:${item.action}`)); }
    if (sessionCap) decision.reasons.push('cap:per_session');
    if (meta.guardScanReason) decision.reasons.push(`guard_scan:${meta.guardScanReason}`);
    if (meta.commandScanIncomplete) decision.reasons.push('scan_incomplete');
    if (approvalOutput && decision.action !== 'block') decision.plugin.approvalRuleId = command.id;
    this.licenseMetadata(decision, license, mode);
    const explanation = meta.builtInStop && reason === `built_in:${meta.builtInStop}` ? ` ${BUILT_IN[meta.builtInStop]}` : '';
    if (decision.action === 'block') this.computedBlocks.set(`spend:${callKey(meta)}`, {decision, output: deny(decision.reasons.join('; ') + explanation), license: {...license, mode}});
    await this.append(decision); this.computedBlocks.delete(`spend:${callKey(meta)}`);
    if (decision.action !== 'block' && unitCostCents) this.addCharge(actor, unitCostCents);
    this.completed.set(`spend:${callKey(meta)}`, decision);
    if (decision.action === 'block' && mode === 'enforce') {
      const ids = guard.matches.filter(rule => rule.action === 'stop').map(rule => rule.id);
      this.notifyStop(config, decision, ids.length ? ids : [decision.triggeredCap ? `cap:${decision.triggeredCap.window}` : reason || 'tool_policy']);
    }
    if (decision.action !== 'block') this.pending.set(callKey(meta), decision);
    return { output: decision.action === 'block' ? this.decorate(deny(decision.reasons.join('; ') + explanation), {...license, mode}) : {...(approvalOutput ?? allow()), ...(guard.warning ? {systemMessage: guard.message} : {})} };
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
