#!/usr/bin/env node
'use strict';

// Public transcripts are inert data. The only subprocess this file launches is
// curl, with fixed hosts and argument arrays. No transcript command is executed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createRequire} = require('node:module');
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const SOURCE = 'https://github.com/vercel/next-evals-oss';
const API = 'https://api.github.com/repos/vercel/next-evals-oss';
const RAW = 'https://raw.githubusercontent.com/vercel/next-evals-oss';
const MODEL_ALIASES = Object.freeze({'claude-opus-5.5': 'claude-opus-5-5', 'claude-fable-5.1': 'claude-fable-5-1'});
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const blobHash = value => crypto.createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
const fail = code => { throw new Error(code); };
const json = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('invalid_json_artifact'); } };
const RUN_FILE = /^(results\/.+)\/(agent-[A-Za-z0-9_.-]+)\/(run-\d+)\/(result\.json|transcript-raw\.jsonl)$/;

function resultSet(value) {
  let text = value.replace(/^https:\/\/github\.com\/vercel\/next-evals-oss\/tree\/[^/]+\//, '').replace(/\/$/, '');
  if (!text.startsWith('results/')) text = 'results/' + text;
  if (!/^results\/[A-Za-z0-9_.-]+\/.+$/.test(text) || text.split('/').some(piece => !piece || piece === '.' || piece === '..') || /[\x00-\x20\\#]/.test(text)) fail('invalid_result_set');
  if (!/\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/.test(text)) fail('invalid_result_set_timestamp');
  return text;
}

async function curlFile(url, destination, expected, runner = run) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname)) fail('invalid_download_host');
  if (expected && fs.existsSync(destination) && blobHash(fs.readFileSync(destination)) === expected) return;
  fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
  const temporary = destination + '.' + crypto.randomUUID() + '.part';
  try {
    await runner('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '--max-time', '90', '--proto', '=https', '--proto-redir', '=https', url, '--output', temporary], {maxBuffer: 1024 * 1024});
    const data = fs.readFileSync(temporary);
    if (expected && blobHash(data) !== expected) fail('download_hash_mismatch');
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, {force: true});
    fail(error.message === 'download_hash_mismatch' ? error.message : 'download_failed');
  }
}

async function inventory(cache, revision = 'main') {
  if (!/^(?:main|[a-f0-9]{40})$/.test(revision)) fail('invalid_revision');
  let commit = revision;
  if (revision === 'main') {
    const file = path.join(cache, 'current-commit.json'); await curlFile(`${API}/commits/main`, file);
    commit = json(file).sha;
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('invalid_source_commit');
  const directory = path.join(cache, commit), treeFile = path.join(directory, 'tree.json');
  if (!fs.existsSync(treeFile)) await curlFile(`${API}/git/trees/${commit}?recursive=1`, treeFile);
  const tree = json(treeFile);
  if (tree.truncated || !Array.isArray(tree.tree)) fail('incomplete_source_inventory');
  const entries = new Map(tree.tree.filter(item => item.type === 'blob').map(item => [item.path, item]));
  const fetch = async relative => {
    const item = entries.get(relative); if (!item) fail('missing_source_artifact');
    const destination = path.join(directory, relative);
    await curlFile(`${RAW}/${commit}/${relative.split('/').map(encodeURIComponent).join('/')}`, destination, item.sha);
    return destination;
  };
  const license = fs.readFileSync(await fetch('LICENSE'), 'utf8');
  if (!/^MIT License\s/.test(license) || !/Copyright \(c\) 2025 Vercel/.test(license)) fail('source_license_changed');
  const metadata = json(await fetch('agent-results.json')).metadata;
  return {commit, directory, entries, metadata, fetch, licenseSha256: sha256(license)};
}

function selectSets(entries, metadata, requested, allCurrent = false) {
  const available = [...new Set([...entries.keys()].map(name => RUN_FILE.exec(name)?.[1]).filter(Boolean))];
  const chosen = requested.map(resultSet);
  if (allCurrent) {
    const models = new Set(metadata.experiments.filter(item => ['Claude Code', 'Codex'].includes(item.agentHarness)).map(item => item.name));
    chosen.push(...available.filter(set => models.has(set.split('/')[1].replace(/--agents-md$/, ''))));
  }
  for (const set of chosen) if (!available.includes(set)) fail('result_set_not_found');
  if (!chosen.length) fail('result_set_required');
  return [...new Set(chosen)].sort();
}

function parseTranscript(text) {
  const rows = []; let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (!row || typeof row !== 'object' || Array.isArray(row)) malformed++; else rows.push(row); }
    catch { malformed++; }
  }
  const format = rows.some(row => row.type === 'assistant' && row.message) ? 'claude-code'
    : rows.some(row => row.type === 'thread.started' || row.item?.type === 'command_execution') ? 'codex-exec'
      : rows.some(row => row.type === 'tool_use' && row.part) ? 'opencode' : 'unknown';
  const actions = [], seen = new Map(); let unsupported = 0;
  const add = (id, tool, input, row, category = 'other') => {
    const key = typeof id === 'string' ? id : `row-${row}-${actions.length}`;
    if (seen.has(key)) return seen.get(key);
    const action = {id: key, tool, input: input ?? {}, category, row};
    seen.set(key, action); actions.push(action); return action;
  };
  for (const [index, row] of rows.entries()) {
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) if (block.type === 'tool_use') add(block.id, block.name, block.input, index, /^(?:Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/.test(block.name) ? 'command_or_edit' : 'other');
    }
    const item = row.item;
    if (row.type === 'item.started' && item?.type === 'command_execution') add(item.id, 'Bash', {command: item.command}, index, 'command_or_edit');
    if (row.type === 'item.completed' && item?.type === 'file_change') add(item.id, 'apply_patch', {changes: item.changes}, index, 'command_or_edit');
    if (['item.started', 'item.completed'].includes(row.type) && item?.type === 'web_search') {
      const action = add(item.id, 'WebSearch', {query: item.query, action: item.action}, index);
      // Starts can contain a placeholder. Completion exposes the requested
      // query or URL, without search results. Count and scan the call once.
      if (row.type === 'item.completed') action.input = {query: item.query ?? action.input.query, action: item.action ?? action.input.action};
    }
    if (row.type === 'item.started' && item?.type === 'todo_list') add(item.id, 'TodoWrite', {todos: item.items}, index);
    if (row.type === 'item.started' && item?.type === 'collab_tool_call') add(item.id, item.tool, {prompt: item.prompt, receivers: item.receiver_thread_ids}, index);
    if (row.type === 'item.started' && item?.type === 'mcp_tool_call') add(item.id, `mcp__${item.server}__${item.tool}`, item.arguments, index);
    if (row.type === 'item.started' && item && !['command_execution', 'file_change', 'web_search', 'todo_list', 'collab_tool_call', 'mcp_tool_call'].includes(item.type)) unsupported++;
    if (row.type === 'tool_use' && row.part?.type === 'tool') {
      const names = {bash: 'Bash', write: 'Write', edit: 'Edit', read: 'Read', task: 'Task', apply_patch: 'apply_patch'};
      const tool = names[row.part.tool] ?? row.part.tool;
      add(row.part.callID ?? row.part.id, tool, row.part.state?.input, index, /^(?:Bash|Write|Edit|apply_patch)$/.test(tool) ? 'command_or_edit' : 'other');
    }
  }
  return {format, actions, malformed, unsupported};
}

function loadBurn() {
  const dependency = createRequire(path.join(__dirname, 'public-evals-deps/package.json'));
  const pkg = dependency('@agentguard-run/burn/package.json');
  if (pkg.name !== '@agentguard-run/burn' || pkg.version !== '0.3.5') fail('burn_version_mismatch');
  const directory = path.dirname(dependency.resolve('@agentguard-run/burn'));
  return {api: dependency('@agentguard-run/burn'), ...require(path.join(directory, 'insights/transcript.js')),
    ...require(path.join(directory, 'insights/pricing.js')), ...require(path.join(directory, 'insights/render.js'))};
}
function providerModel(value) {
  if (typeof value !== 'string') return undefined;
  const model = value.replace(/^(?:anthropic|openai|xai)\//, '').split('?')[0];
  return /^[A-Za-z0-9_.-]+$/.test(model) ? MODEL_ALIASES[model] ?? model : undefined;
}
function openCodeUsage(file, resultModel) {
  const turns = [], diagnostics = {malformedLines: 0, unsupportedUsageRecords: 0};
  for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { diagnostics.malformedLines++; continue; }
    if (row?.type !== 'step_finish' || !row.part?.tokens) continue;
    const tokens = row.part.tokens;
    if (![tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write].every(n => Number.isSafeInteger(n) && n >= 0)) { diagnostics.unsupportedUsageRecords++; continue; }
    // OpenCode records noncached input and separates reasoning from output.
    // Feed those numeric categories to Burn pricing without the host's cost field.
    turns.push({id: row.part.id ?? `row-${index}`, at: row.timestamp, model: providerModel(resultModel), uncertainties: [],
      inputTokens: tokens.input, cacheReadTokens: tokens.cache.read, cacheWriteTokens: tokens.cache.write, outputTokens: tokens.output + tokens.reasoning});
  }
  return {turns, diagnostics};
}
function usageFor(file, format, resultModel, burn = loadBurn()) {
  if (!['claude-code', 'codex-exec', 'opencode'].includes(format)) return null;
  const parsed = format === 'opencode' ? openCodeUsage(file, resultModel) : burn.readInsightTranscript(file, {host: format === 'claude-code' ? 'claude' : 'codex'});
  const turns = burn.deduplicateTurns(parsed.turns);
  const prices = turns.map(turn => {
    const pricedTurn = {...turn, model: providerModel(turn.model ?? resultModel)};
    const price = burn.priceTurn(pricedTurn), rate = burn.MODEL_PRICING[pricedTurn.model];
    const input = turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens;
    // Exec usage sums a whole turn, which can contain several API requests.
    // A large sum does not establish any individual request's context tier.
    // Use the SDK at both rate tiers to bound the unavailable request split.
    if (format !== 'codex-exec' || !price.usd || !rate?.longContext || input <= rate.longContext.aboveInputTokens) return price;
    const {longContext, ...baseRate} = rate;
    const base = burn.priceTurn(pricedTurn, {[pricedTurn.model]: baseRate});
    return {...price, usd: {min: base.usd.min, max: price.usd.max}, aggregateContextRange: true};
  });
  const replay = format === 'claude-code' ? burn.api.replaySession(file, burn.api.DEFAULT_THRESHOLDS) : null;
  return {turns: turns.length, total_tokens: turns.reduce((n, turn) => n + burn.totalTokens(turn), 0),
    cache_read_tokens: turns.reduce((n, turn) => n + turn.cacheReadTokens, 0),
    spawns: replay?.spawns ?? null, replay_tokens: replay?.totalTokens ?? null, replay_cache_read_share: replay?.cacheReadRatio ?? null,
    list_cost_usd: turns.length ? burn.sumPrices(prices.map(price => price.usd)) : null,
    known_list_cost_usd: burn.sumPrices(prices.flatMap(price => price.usd ? [price.usd] : [])),
    unpriced_turns: prices.filter(price => price.usd === null).length,
    aggregate_context_ranges: prices.filter(price => price.aggregateContextRange).length,
    unpriced_models: [...new Set(prices.filter(price => !price.usd).map(price => price.model ?? 'unknown'))].sort(),
    malformed_usage_rows: parsed.diagnostics.malformedLines, unsupported_usage_rows: parsed.diagnostics.unsupportedUsageRecords};
}

function counters() {
  return {runs: 0, passed_runs: 0, transcripts: 0, missing_transcripts: 0, unknown_formats: 0, malformed_rows: 0, unsupported_actions: 0,
    actions_scanned: 0, commands_and_edits: 0, would_stop: 0, would_warn: 0, incomplete_scans: 0, stops_on_passing_runs: 0, engine_fail_open: 0, observed_spawns: 0};
}
function totals(reports) {
  const result = counters(); for (const report of reports) for (const key of Object.keys(result)) result[key] += report.counts[key]; return result;
}
function aggregateUsage(rows) {
  const available = rows.filter(Boolean), claude = available.filter(row => row.spawns !== null);
  const totalTokens = available.reduce((n, row) => n + row.total_tokens, 0), cacheTokens = available.reduce((n, row) => n + row.cache_read_tokens, 0);
  const sumCost = values => values.some(value => value === null) ? null : values.reduce((sum, value) => ({min: sum.min + value.min, max: sum.max + value.max}), {min: 0, max: 0});
  const replayTokens = claude.reduce((n, row) => n + (row.replay_tokens ?? 0), 0);
  return {burn_version: '0.3.5', available_transcripts: available.length, claude_replays: claude.length,
    spawns: claude.length ? claude.reduce((n, row) => n + row.spawns, 0) : null,
    total_tokens: available.length ? totalTokens : null, cache_read_tokens: available.length ? cacheTokens : null,
    cache_read_share: totalTokens ? cacheTokens / totalTokens : null,
    replay_cache_read_share: replayTokens ? claude.reduce((n, row) => n + Math.round(row.replay_cache_read_share * row.replay_tokens), 0) / replayTokens : null,
    list_cost_usd: available.length ? sumCost(available.map(row => row.list_cost_usd)) : null,
    known_list_cost_usd: available.length ? sumCost(available.map(row => row.known_list_cost_usd)) : null,
    unpriced_turns: available.reduce((n, row) => n + row.unpriced_turns, 0),
    aggregate_context_ranges: available.reduce((n, row) => n + row.aggregate_context_ranges, 0),
    unpriced_models: [...new Set(available.flatMap(row => row.unpriced_models))].sort(),
    malformed_usage_rows: available.reduce((n, row) => n + row.malformed_usage_rows, 0),
    unsupported_usage_rows: available.reduce((n, row) => n + row.unsupported_usage_rows, 0)};
}

async function withEngine(callback) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-public-evals-engine-'));
  const environment = {PLUGIN_DATA: data, AGENTGUARD_HOME: path.join(data, 'burn'), AGENTGUARD_PLUGIN_POLICY: '', AGENTGUARD_LICENSE_KEY: '',
    AGENTGUARD_NOTIFY_SUPPRESS: '1', AGENTGUARD_NO_BEACON: '1', AGENTGUARD_TELEMETRY: '0', CLAUDE_CONFIG_DIR: path.join(data, 'claude'), CLAUDE_PROJECT_DIR: data};
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let engine;
  try {
    fs.copyFileSync(path.join(ROOT, 'config/default-policy.json'), path.join(data, 'policy.json'));
    const {Engine} = require('../runtime/engine.cjs'); engine = new Engine(); await engine.init();
    return await callback(engine);
  } finally {
    if (engine) await engine.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(data, {recursive: true, force: true});
  }
}
async function evaluateAction(engine, action, session, format) {
  const {scanGuardPack} = require('../runtime/guard-pack.cjs');
  const {metadata, SPAWN} = require('../runtime/common.cjs');
  const guard = scanGuardPack(action.tool, action.input, {sharedBranch: false});
  const gate = SPAWN.has(action.tool) ? 'burn' : 'spend';
  const meta = metadata({tool_name: action.tool, tool_input: {}, session_id: session, tool_use_id: sha256(action.id)}, gate);
  const input = JSON.stringify(action.input);
  Object.assign(meta, {host: format === 'claude-code' ? 'claude-code' : 'codex', inputSha256: sha256(input), inputBytes: Buffer.byteLength(input), inputKeys: Object.keys(action.input ?? {}).length, guardRuleIds: guard.ruleIds});
  if (guard.reason) meta.guardScanReason = guard.reason;
  const context = engine.context(meta);
  if (context.mode !== 'enforce' || context.license.tier !== 'free') fail('default_free_policy_not_active');
  const outcome = await engine.handle({meta});
  const stop = outcome.output.hookSpecificOutput?.permissionDecision === 'deny';
  const decision = engine.completed.get(`${gate}:${JSON.stringify([session, meta.toolUseId])}`);
  const ids = decision?.plugin.guardPack?.filter(rule => rule.action === 'stop').map(rule => rule.id) ?? [];
  return {stop, warn: !stop && Boolean(outcome.output.systemMessage), incomplete: Boolean(guard.reason),
    failOpen: engine.failures.has(`${gate}:${JSON.stringify([session, meta.toolUseId])}`) || !decision && gate === 'spend',
    rules: ids.length ? ids : stop ? ['PLUGIN_POLICY'] : [], spawn: SPAWN.has(action.tool)};
}

async function scoreSet(set, files, engine, burn) {
  const counts = counters(), stops = [], usage = [], formats = new Set();
  const runFiles = [...files.keys()].filter(file => file.startsWith(set + '/') && file.endsWith('/result.json')).sort();
  for (const name of runFiles) {
    const match = RUN_FILE.exec(name); if (!match || match[1] !== set) continue;
    const result = json(files.get(name)); counts.runs++; const passed = result.status === 'passed'; if (passed) counts.passed_runs++;
    const transcript = files.get(name.replace(/result\.json$/, 'transcript-raw.jsonl'));
    if (!transcript) { counts.missing_transcripts++; continue; }
    counts.transcripts++;
    const parsed = parseTranscript(fs.readFileSync(transcript, 'utf8')); formats.add(parsed.format);
    if (parsed.format === 'unknown') counts.unknown_formats++;
    counts.malformed_rows += parsed.malformed; counts.unsupported_actions += parsed.unsupported;
    const session = sha256(name);
    for (const action of parsed.actions) {
      counts.actions_scanned++; if (action.category === 'command_or_edit') counts.commands_and_edits++;
      const outcome = await evaluateAction(engine, action, session, parsed.format);
      if (outcome.stop) {
        counts.would_stop++; if (passed) counts.stops_on_passing_runs++;
        stops.push({eval: match[2], run: match[3], passed, rule_ids: outcome.rules});
      }
      if (outcome.warn) counts.would_warn++;
      if (outcome.incomplete) counts.incomplete_scans++;
      if (outcome.failOpen) counts.engine_fail_open++;
      if (outcome.spawn) counts.observed_spawns++;
    }
    usage.push(usageFor(transcript, parsed.format, result.model, burn));
  }
  return {set, formats: [...formats].sort(), counts, stops, usage_rows: usage};
}

const percent = value => value === null ? 'unavailable' : `${(value * 100).toFixed(2)}%`;
const dollars = value => value === null ? 'unpriced' : value.min === value.max ? `$${value.min.toFixed(4)}` : `$${value.min.toFixed(4)} to $${value.max.toFixed(4)}`;
function markdown(report) {
  const c = report.counts, u = report.usage;
  return [`# ${report.model}`, '', `Data: [Vercel next-evals-oss](${SOURCE}/tree/${report.source.commit}). [MIT license](${SOURCE}/blob/${report.source.commit}/LICENSE), Copyright (c) 2025 Vercel.`, '',
    '| Metric | Count or value |', '| :--- | ---: |', ...Object.entries(c).map(([key, value]) => `| ${key.replaceAll('_', ' ')} | ${value} |`),
    `| Burn Claude spawns | ${u.spawns ?? 'unavailable'} |`, `| Cache-read share | ${percent(u.cache_read_share)} |`, `| Burn replay share | ${percent(u.replay_cache_read_share)} |`,
    `| API list cost for available transcripts | ${dollars(u.list_cost_usd)} |`, `| Known priced subset | ${dollars(u.known_list_cost_usd)} |`, `| Unpriced turns | ${u.unpriced_turns} |`, `| Aggregate turns with unknown context tier | ${u.aggregate_context_ranges} |`, '',
    'Stops on passing runs are false positives under this report definition.', '', '| Eval | Rule IDs |', '| :--- | :--- |',
    ...(report.false_positives.length ? report.false_positives.map(row => `| ${row.eval} | ${row.rule_ids.join(', ')} |`) : ['| None | None |']), '',
    'Each action uses the real scanner and its owning Engine gate with the default Free enforce policy and nonshared branch context. Burn 0.3.5 supplies transcript usage and Claude replay metrics. These are replay decisions; native hook coverage depends on the host.', '',
    'Usage covers the published parent transcripts. Missing transcripts and unsupported prices remain explicit. Cache-read share uses cache-read tokens divided by all observed input, cache-write, cache-read and output tokens. Codex file-change records expose paths without patch bodies. OpenCode tool inputs and numeric step usage are adapted; unknown prices stay unpriced.', '',
    'Codex turn totals can span several API requests. When those totals exceed a model context-price threshold, cost spans the base and long-context SDK rates because the individual request contexts are unavailable. Model identity comes from result.json when the transcript omits it.', '',
    'No transcript text, command text, patches, prompts or tool outputs appear in this report.', ''].join('\n');
}

function modelReports(setReports, source) {
  const groups = new Map();
  for (const report of setReports) { const model = report.set.split('/')[1].replace(/--agents-md$/, ''); if (!groups.has(model)) groups.set(model, []); groups.get(model).push(report); }
  return [...groups].map(([model, reports]) => ({schema: 'agentguard.public-evals.v1', model, source,
    plugin: {version: require('../package.json').version, scanner_sha256: sha256(fs.readFileSync(path.join(ROOT, 'runtime/guard-pack.cjs'))), policy_sha256: sha256(fs.readFileSync(path.join(ROOT, 'config/default-policy.json'))), mode: 'enforce', tier: 'free', shared_branch: false},
    pricing_model_aliases: MODEL_ALIASES, counts: totals(reports), usage: aggregateUsage(reports.flatMap(report => report.usage_rows)),
    false_positives: reports.flatMap(report => report.stops.filter(stop => stop.passed).map(stop => ({result_set: report.set, ...stop}))),
    result_sets: reports.map(({usage_rows, ...report}) => ({...report, usage: aggregateUsage(usage_rows)}))}));
}

async function main(argv = process.argv.slice(2)) {
  const options = {cache: path.join(os.tmpdir(), 'agentguard-public-evals-cache'), output: path.resolve('public-eval-reports'), revision: 'main', allCurrent: false}, requested = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--all-current') options.allCurrent = true;
    else if (['--cache', '--output', '--revision'].includes(value)) { if (!argv[index + 1] || argv[index + 1].startsWith('--')) fail('option_value_required'); options[value.slice(2)] = argv[++index]; }
    else if (value.startsWith('--')) fail('unknown_option'); else requested.push(value);
  }
  const source = await inventory(path.resolve(options.cache), options.revision);
  const sets = selectSets(source.entries, source.metadata, requested, options.allCurrent);
  const needed = [...source.entries.keys()].filter(name => { const match = RUN_FILE.exec(name); return match && sets.includes(match[1]); });
  const files = new Map(); let cursor = 0;
  await Promise.all(Array.from({length: 8}, async () => { while (cursor < needed.length) { const name = needed[cursor++]; files.set(name, await source.fetch(name)); } }));
  const burn = loadBurn();
  const reports = await withEngine(async engine => {
    const output = [];
    for (const set of sets) { output.push(await scoreSet(set, files, engine, burn)); process.stdout.write(`Scored ${output.length}/${sets.length} result sets\n`); }
    return modelReports(output, {repository: SOURCE, commit: source.commit, license: 'MIT', copyright: 'Copyright (c) 2025 Vercel', license_sha256: source.licenseSha256});
  });
  const output = path.resolve(options.output); fs.mkdirSync(output, {recursive: true});
  for (const report of reports) {
    fs.writeFileSync(path.join(output, `${report.model}.json`), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(output, `${report.model}.md`), markdown(report));
  }
  const summary = {schema: 'agentguard.public-evals-summary.v1', source: reports[0].source, result_sets: sets.length, models: reports.length, counts: totals(reports), reports: reports.map(report => ({model: report.model, counts: report.counts, usage: report.usage}))};
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'README.md'), [`# Public eval reports`, '', `Data source: [Vercel next-evals-oss](${SOURCE}/tree/${source.commit}), [MIT license](${SOURCE}/blob/${source.commit}/LICENSE), Copyright (c) 2025 Vercel.`, '',
    `${sets.length} result sets. ${reports.length} model reports. ${summary.counts.actions_scanned} tool actions. ${summary.counts.stops_on_passing_runs} stops on passing runs.`, '',
    '| Model | Runs | Passed | Actions | Stop | Warn | Incomplete | Passing-run stops |', '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...reports.map(report => `| [${report.model}](${report.model}.md) | ${['runs', 'passed_runs', 'actions_scanned', 'would_stop', 'would_warn', 'incomplete_scans', 'stops_on_passing_runs'].map(key => report.counts[key]).join(' | ')} |`), '',
    'Current means all published timestamps for model families listed with the Claude Code or Codex harness in the pinned source metadata. Explicitly requested sets are included too. Base and docs variants are aggregated per model and remain separate in each JSON report.', '',
    'Reports contain counts, eval names, rule IDs and provenance. Raw inputs remain in the separate local download cache and are never executed.', ''].join('\n'));
  process.stdout.write(JSON.stringify({models: reports.length, result_sets: sets.length, ...summary.counts}) + '\n');
  return reports;
}

module.exports = {resultSet, curlFile, selectSets, parseTranscript, usageFor, aggregateUsage, withEngine, evaluateAction, scoreSet, modelReports, markdown, main, blobHash};
if (require.main === module) main().catch(error => { process.stderr.write(`Public eval scoring failed: ${/^[a-z_]+$/.test(error.message) ? error.message : 'scoring_error'}\n`); process.exitCode = 1; });
