'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createReader, handleRpc, TOOLS, resolveScoreOrigin, parseScorePayload} = require('../runtime/mcp.cjs');
const {INTRO, QUESTIONS, validateAnswers} = require('../runtime/agent-score-questions.cjs');
const {dismiss} = require('../runtime/upgrade-moments.cjs');

const ORIGIN = 'https://score.example';
const GOOD = {agent_type: 'Customer service agent', human_sponsor: true, wallet_type: 'Custodial account (Circle, Coinbase, a processor balance)', transaction_limits: true, audit_trail: false};
const SERVICE = {ok: true, score: 75, tier: 'GOOD', breakdown: {compliance: 67, infrastructure: 100}, factors: [
  {factor: 'Is a named human accountable for this agent, and can a third party verify who that is?', impact: 'positive', points: 0, recommendation: 'Accountable human on record'},
  {factor: 'Is every payment action logged with a timestamp the agent cannot edit?', impact: 'negative', points: -20, recommendation: 'Log every payment action with a timestamp the agent cannot edit'},
], isAgent: true, shareToken: 'abc', shareUrl: `${ORIGIN}/score/abc`, scoredAt: '2026-09-24T15:00:00.000Z', validUntil: '2026-12-23T15:00:00.000Z', assessmentType: 'self_report', questionnaireVersion: 'agent-payment-five-v1', rubricVersion: 'reported-controls-v1', patent: 'ignored'};
const MAPPED = {ok: true, score: 75, tier: 'GOOD', breakdown: {compliance: 67, infrastructure: 100}, factors: SERVICE.factors, shareUrl: null, scoredAt: SERVICE.scoredAt, validUntil: SERVICE.validUntil, serviceOrigin: ORIGIN, assessmentType: 'self_report', questionnaireVersion: 'agent-payment-five-v1', rubricVersion: 'reported-controls-v1'};
const NETWORK_MESSAGE = 'No usable result was received. The service may have processed the request. I have not retried it or invented a result.';
const UNUSABLE_MESSAGE = 'The service returned an unusable result. No result is available to display.';

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-score-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-score-home-'));
  const previous = {home: process.env.AGENTGUARD_HOME, url: process.env.AGENTGUARD_SCORE_URL};
  process.env.AGENTGUARD_HOME = home;
  if (Object.hasOwn(options, 'env')) { if (options.env === undefined) delete process.env.AGENTGUARD_SCORE_URL; else process.env.AGENTGUARD_SCORE_URL = options.env; }
  t.after(() => {
    fs.rmSync(dataDir, {recursive: true, force: true}); fs.rmSync(home, {recursive: true, force: true});
    for (const [key, value] of [['AGENTGUARD_HOME', previous.home], ['AGENTGUARD_SCORE_URL', previous.url]]) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    if (options.fail === 'network') throw new TypeError('fetch failed');
    if (options.fail === 'redirect') { assert.equal(init.redirect, 'error'); throw new TypeError('fetch failed: unexpected redirect'); }
    if (options.fail === 'redirect-object') return new Response('', {status: 302, headers: {location: 'https://elsewhere.example/'}});
    if (options.fail === 'status') return new Response(JSON.stringify({error: 'boom'}), {status: 500});
    if (options.fail === 'unreadable') return new Response('not json', {status: 200});
    if (options.fail === 'oversized') return new Response('x'.repeat(70 * 1024), {status: 200});
    if (options.fail === 'hang') return new Response(new ReadableStream({pull() { return new Promise(() => {}); }}), {status: 200});
    return new Response(JSON.stringify(options.service || SERVICE), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const reader = createReader({dataDir, fetch, scoreUrl: Object.hasOwn(options, 'scoreUrl') ? options.scoreUrl : `${ORIGIN}/`, timeoutMs: options.timeoutMs});
  const ledger = () => fs.existsSync(reader.filePath) ? fs.readFileSync(reader.filePath, 'utf8') : null;
  const rpc = args => handleRpc({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'agent_score', arguments: args}}, reader);
  return {dataDir, home, reader, calls, ledger, rpc};
}

test('the questions tool returns the intro, every published question and the validated service origin, offline', async t => {
  const f = fixture(t);
  const result = await f.reader.call('agent_score_questions');
  assert.equal(result.intro, INTRO);
  assert.match(INTRO, /verifies nothing/);
  assert.deepEqual(result.questions, QUESTIONS);
  assert.deepEqual(result.questions.map(question => question.id), ['agent_type', 'human_sponsor', 'wallet_type', 'transaction_limits', 'audit_trail']);
  assert.equal(result.questions.find(question => question.id === 'wallet_type').options.length, 6);
  assert.equal(result.serviceOrigin, ORIGIN);
  assert.equal(Object.hasOwn(result, 'serviceOriginError'), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.ledger(), null);
  const env = fixture(t, {scoreUrl: undefined, env: 'https://staging.example/'});
  assert.equal((await env.reader.call('agent_score_questions')).serviceOrigin, 'https://staging.example');
  const defaults = fixture(t, {scoreUrl: undefined, env: undefined});
  assert.equal((await defaults.reader.call('agent_score_questions')).serviceOrigin, 'https://agentguard.run');
  assert.deepEqual(resolveScoreOrigin({}), {origin: 'https://agentguard.run'});
});

test('an unusable configured origin is reported by the questions tool and refuses the score before any request, with no fallback', async t => {
  for (const bad of ['http://score.example', 'https://user:secret@score.example', 'https://score.example/api', 'https://score.example/?x=1', 'https://score.example/#report', 'ftp://score.example', 'score.example', '']) {
    const f = fixture(t, {scoreUrl: bad || 'https://score.example/', env: bad === '' ? '' : undefined});
    if (bad === '') continue;
    const questions = await f.reader.call('agent_score_questions');
    assert.equal(questions.serviceOrigin, null, bad);
    assert.equal(questions.serviceOriginError, 'invalid_origin', bad);
    assert.deepEqual(questions.questions, QUESTIONS);
    const refused = await f.reader.call('agent_score', {answers: GOOD, consent: true, createShare: true});
    assert.equal(refused.ok, false, bad);
    assert.equal(refused.reason, 'invalid_origin', bad);
    assert.match(refused.message, /Nothing was sent/, bad);
    assert.equal(refused.score, undefined);
    assert.equal(f.calls.length, 0, bad);
    assert.deepEqual(resolveScoreOrigin({scoreUrl: bad}), {origin: null}, bad);
  }
  const env = fixture(t, {scoreUrl: undefined, env: 'http://plain.example'});
  assert.equal((await env.reader.call('agent_score', {answers: GOOD, consent: true})).reason, 'invalid_origin');
  assert.equal(env.calls.length, 0);
});

test('missing, false or non-boolean consent refuses before any request with a score-specific message naming the origin', async t => {
  const f = fixture(t);
  for (const args of [{answers: GOOD}, {answers: GOOD, consent: false}, {answers: GOOD, consent: 'yes'}]) {
    const refused = await f.reader.call('agent_score', args);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'consent_required');
    assert.match(refused.message, /AgentGuard Score service at https:\/\/score\.example/);
    assert.match(refused.message, /Nothing was sent/);
    assert.equal(refused.score, undefined);
  }
  const response = await f.rpc({answers: GOOD});
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.reason, 'consent_required');
  assert.doesNotMatch(response.result.content[0].text, /ledger/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.ledger(), null);
});

test('unknown ids, off-list options, wrong types, a missing answer and unexpected arguments are rejected before any request', async t => {
  const f = fixture(t);
  const unknown = await f.reader.call('agent_score', {answers: {...GOOD, favourite_colour: 'blue'}, consent: true});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'invalid_answers');
  assert.match(unknown.problems.join(' '), /favourite_colour/);
  assert.match(unknown.message, /Nothing was sent/);
  assert.equal((await f.reader.call('agent_score', {answers: {...GOOD, wallet_type: 'Hardware wallet'}, consent: true})).reason, 'invalid_answers');
  assert.equal((await f.reader.call('agent_score', {answers: {...GOOD, human_sponsor: 'yes'}, consent: true})).reason, 'invalid_answers');
  assert.equal((await f.reader.call('agent_score', {answers: 'all good', consent: true})).reason, 'invalid_answers');
  const {audit_trail, ...partial} = GOOD;
  const missing = await f.reader.call('agent_score', {answers: partial, consent: true});
  assert.deepEqual(missing.problems, ['audit_trail is unanswered; every question must be answered.']);
  const empty = await f.reader.call('agent_score', {answers: {}, consent: true});
  assert.equal(empty.problems.length, QUESTIONS.length);
  assert.deepEqual(validateAnswers(GOOD), []);
  const invalid = await f.rpc({answers: partial, consent: true});
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.structuredContent.reason, 'invalid_answers');
  await assert.rejects(f.reader.call('agent_score', {answers: GOOD, consent: true, url: 'https://invalid.example/'}), /Unexpected argument/);
  await assert.rejects(f.reader.call('agent_score', {answers: GOOD, consent: true, email: 'agent@example.com'}), /Unexpected argument/);
  await assert.rejects(f.reader.call('agent_score', {answers: GOOD, consent: true, createShare: 'yes'}), /createShare must be true or false/);
  const unexpected = await f.rpc({answers: GOOD, consent: true, email: 'agent@example.com'});
  assert.equal(unexpected.result.isError, true);
  assert.match(unexpected.result.content[0].text, /agent_score accepts answers, consent and an optional createShare boolean only/);
  assert.match(unexpected.result.content[0].text, /Nothing was sent/);
  assert.doesNotMatch(unexpected.result.content[0].text, /ledger/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.ledger(), null);
});

test('a complete answer set with consent posts the answers and the share choice with hardened request options and returns the mapped result', async t => {
  const f = fixture(t);
  const result = await f.reader.call('agent_score', {answers: GOOD, consent: true});
  assert.equal(f.calls.length, 1);
  const {url, init} = f.calls[0];
  assert.equal(url, `${ORIGIN}/api/score`);
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), {answers: GOOD, tier: 'tier1', createShare: false});
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, {'Content-Type': 'application/json', Accept: 'application/json'});
  assert.deepEqual(result, MAPPED);
  assert.equal(Object.hasOwn(result, 'patent'), false);
  assert.equal(Object.hasOwn(result, 'isAgent'), false);
  assert.equal(f.ledger(), null);
  const response = await f.rpc({answers: GOOD, consent: true});
  assert.equal(Object.hasOwn(response.result, 'isError'), false);
  assert.deepEqual(response.result.structuredContent, MAPPED);
  const bare = fixture(t, {service: {...SERVICE, scoredAt: undefined, validUntil: null, assessmentType: 7}});
  const mapped = await bare.reader.call('agent_score', {answers: GOOD, consent: true});
  assert.equal(mapped.ok, true);
  assert.equal(mapped.scoredAt, null);
  assert.equal(mapped.validUntil, null);
  assert.equal(Object.hasOwn(mapped, 'assessmentType'), false);
});

test('a report link is a separate choice: it is requested only with createShare and shown only on the consented origin', async t => {
  const f = fixture(t);
  const shared = await f.reader.call('agent_score', {answers: GOOD, consent: true, createShare: true});
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {answers: GOOD, tier: 'tier1', createShare: true});
  assert.equal(shared.shareUrl, `${ORIGIN}/score/abc`);
  const declined = await f.reader.call('agent_score', {answers: GOOD, consent: true, createShare: false});
  assert.equal(declined.shareUrl, null);
  for (const shareUrl of ['https://elsewhere.example/score/abc', 'http://score.example/score/abc', 'https://score.example.evil/score/abc', `${ORIGIN}`, 42]) {
    const other = fixture(t, {service: {...SERVICE, shareUrl}});
    const result = await other.reader.call('agent_score', {answers: GOOD, consent: true, createShare: true});
    assert.equal(result.ok, true, String(shareUrl));
    assert.equal(result.shareUrl, null, String(shareUrl));
  }
  const override = fixture(t, {scoreUrl: 'https://staging.example', service: {...SERVICE, shareUrl: 'https://staging.example/score/abc'}});
  const result = await override.reader.call('agent_score', {answers: GOOD, consent: true, createShare: true});
  assert.equal(result.shareUrl, 'https://staging.example/score/abc');
  assert.equal(result.serviceOrigin, 'https://staging.example');
  assert.equal(override.calls[0].url, 'https://staging.example/api/score');
});

test('a refused redirect, an unreachable service and a stalled body are network failures that never claim nothing was sent', async t => {
  for (const [fail, options] of [['network', {}], ['redirect', {}], ['hang', {timeoutMs: 50}]]) {
    const f = fixture(t, {fail, ...options});
    const started = Date.now();
    const result = await f.reader.call('agent_score', {answers: GOOD, consent: true});
    assert.ok(Date.now() - started < 5000, fail);
    assert.equal(result.ok, false, fail);
    assert.equal(result.reason, 'network', fail);
    assert.equal(result.message, NETWORK_MESSAGE, fail);
    assert.equal(result.score, undefined, fail);
    assert.equal(f.calls.length, 1, fail);
    assert.equal(f.ledger(), null, fail);
    assert.equal((await f.rpc({answers: GOOD, consent: true})).result.isError, true, fail);
  }
});

test('an error status, a redirect response, an unreadable body and an oversized body are service errors with no result to display', async t => {
  for (const [fail, status, message] of [['status', 500, /error status/], ['redirect-object', 302, /error status/], ['unreadable', undefined, UNUSABLE_MESSAGE], ['oversized', undefined, /size limit/]]) {
    const f = fixture(t, {fail});
    const result = await f.reader.call('agent_score', {answers: GOOD, consent: true});
    assert.equal(result.ok, false, fail);
    assert.equal(result.reason, 'service_error', fail);
    if (status) assert.equal(result.status, status, fail);
    if (typeof message === 'string') assert.equal(result.message, message, fail); else assert.match(result.message, message, fail);
    assert.match(result.message, /No result is available to display/, fail);
    assert.equal(result.score, undefined, fail);
    assert.equal(f.calls.length, 1, fail);
    const response = await f.rpc({answers: GOOD, consent: true});
    assert.equal(response.result.isError, true, fail);
    assert.equal(response.result.structuredContent.reason, 'service_error', fail);
  }
});

test('every malformed 2xx payload is refused as an unusable result rather than filtered into a partial score', async t => {
  const {ok, ...withoutOk} = SERVICE;
  const variants = {
    'ok false': {...SERVICE, ok: false},
    'ok missing': withoutOk,
    'score string': {...SERVICE, score: 'high'},
    'score 101': {...SERVICE, score: 101},
    'score negative': {...SERVICE, score: -1},
    'score fraction': {...SERVICE, score: 75.5},
    'tier unknown': {...SERVICE, tier: 'SUPER'},
    'breakdown array': {...SERVICE, breakdown: [67]},
    'breakdown string value': {...SERVICE, breakdown: {compliance: 'a'}},
    'breakdown fraction': {...SERVICE, breakdown: {compliance: 67.5}},
    'breakdown null': {...SERVICE, breakdown: null},
    'factors string': {...SERVICE, factors: 'none'},
    'factor null': {...SERVICE, factors: [null]},
    'factor without text': {...SERVICE, factors: [{impact: 'positive', points: 0}]},
    'factor impact unknown': {...SERVICE, factors: [{factor: 'x', impact: 'meh', points: 0}]},
    'factor points fraction': {...SERVICE, factors: [{factor: 'x', impact: 'positive', points: 1.5}]},
    'factor recommendation number': {...SERVICE, factors: [{factor: 'x', impact: 'positive', points: 0, recommendation: 5}]},
    'scoredAt unparseable': {...SERVICE, scoredAt: 'yesterday'},
    'validUntil number': {...SERVICE, validUntil: 12345},
    'payload array': [SERVICE],
  };
  for (const [label, service] of Object.entries(variants)) {
    const f = fixture(t, {service});
    const result = await f.reader.call('agent_score', {answers: GOOD, consent: true});
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, 'service_error', label);
    assert.equal(result.message, UNUSABLE_MESSAGE, label);
    assert.equal(result.score, undefined, label);
    assert.equal(parseScorePayload(service, {origin: ORIGIN, createShare: false}), null, label);
  }
  assert.deepEqual(parseScorePayload(SERVICE, {origin: ORIGIN, createShare: false}), MAPPED);
});

test('get_status reports the local quiet display preference without writing anything', async t => {
  const f = fixture(t);
  const before = await f.reader.call('get_status');
  assert.deepEqual(before.displayPreferences, {quiet: false});
  dismiss(f.home);
  const after = await f.reader.call('get_status');
  assert.deepEqual(after.displayPreferences, {quiet: true});
  assert.equal(f.calls.length, 0);
  assert.equal(f.ledger(), null);
});

test('the tool list, annotations, schema and JSON-RPC surface describe the score tools accurately', async t => {
  const f = fixture(t);
  const score = TOOLS.find(tool => tool.name === 'agent_score');
  const questions = TOOLS.find(tool => tool.name === 'agent_score_questions');
  assert.deepEqual(score.annotations, {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true});
  assert.deepEqual(questions.annotations, {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
  assert.match(score.description, /only MCP tool in this server that makes a hosted request/);
  assert.match(score.description, /does not include local policy, the decision ledger or the signing key/);
  assert.match(score.description, /agentguard\.run/);
  assert.match(questions.description, /serviceOrigin/);
  assert.deepEqual(score.inputSchema.required, ['answers', 'consent']);
  assert.equal(score.inputSchema.properties.createShare.type, 'boolean');
  assert.equal(Object.hasOwn(score.inputSchema.properties, 'email'), false);
  const listed = await handleRpc({jsonrpc: '2.0', id: 1, method: 'tools/list'}, f.reader);
  assert.equal(listed.result.tools.length, 6);
  const scored = await f.rpc({answers: GOOD, consent: true, createShare: true});
  assert.equal(scored.result.structuredContent.score, 75);
  assert.equal(scored.result.structuredContent.shareUrl, `${ORIGIN}/score/abc`);
  assert.equal(f.ledger(), null);
});
