'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createReader, handleRpc, TOOLS} = require('../runtime/mcp.cjs');
const {INTRO, QUESTIONS, validateAnswers} = require('../runtime/agent-score-questions.cjs');

const GOOD = {agent_type: 'Customer service agent', human_sponsor: true, wallet_type: 'Custodial (Circle, Coinbase)', transaction_limits: true, audit_trail: false};
const SERVICE = {ok: true, score: 72, tier: 'GOOD', breakdown: {risk: 100, compliance: 82, infrastructure: 100, history: 100}, factors: [
  {factor: 'human_sponsor', impact: 'positive', points: 15, recommendation: 'GuardGate verified - trusted agent'},
  {factor: 'audit_trail', impact: 'negative', points: -15, recommendation: 'Implement audit logging for all agent actions'},
], isAgent: true, shareToken: 'abc', shareUrl: 'https://www.merchantguard.ai/agentscore/abc', scoredAt: '2026-09-24T15:00:00.000Z', validUntil: '2026-12-23T15:00:00.000Z', patent: 'ignored'};

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-score-'));
  t.after(() => fs.rmSync(dataDir, {recursive: true, force: true}));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    if (options.fail === 'network') throw new Error('ECONNREFUSED');
    if (options.fail === 'status') return {ok: false, status: 500, json: async () => ({error: 'boom'})};
    if (options.fail === 'shape') return {ok: true, status: 200, json: async () => ({ok: true, score: 'high'})};
    return {ok: true, status: 200, json: async () => SERVICE};
  };
  const reader = createReader({dataDir, fetch, scoreUrl: 'https://score.example/'});
  const ledger = () => fs.existsSync(reader.filePath) ? fs.readFileSync(reader.filePath, 'utf8') : null;
  return {dataDir, reader, calls, ledger};
}

test('the questions tool returns the intro and every published question offline', async t => {
  const f = fixture(t);
  const result = await f.reader.call('agent_score_questions');
  assert.equal(result.intro, INTRO);
  assert.deepEqual(result.questions, QUESTIONS);
  assert.deepEqual(result.questions.map(question => question.id), ['agent_type', 'human_sponsor', 'wallet_type', 'transaction_limits', 'audit_trail']);
  for (const question of result.questions) {
    assert.ok(['select', 'boolean'].includes(question.type));
    if (question.type === 'select') assert.ok(question.options.length >= 2);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.ledger(), null);
});

test('missing or false consent refuses before any network call and never touches the ledger', async t => {
  const f = fixture(t);
  await assert.rejects(f.reader.call('agent_score', {answers: GOOD}), /consent are required/);
  const refused = await f.reader.call('agent_score', {answers: GOOD, consent: false});
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'consent_required');
  assert.match(refused.message, /hosted AgentGuard Score service/);
  assert.equal(refused.score, undefined);
  assert.equal(f.calls.length, 0);
  assert.equal(f.ledger(), null);
});

test('unknown question ids and off-list options are rejected before any network call', async t => {
  const f = fixture(t);
  const unknown = await f.reader.call('agent_score', {answers: {...GOOD, favourite_colour: 'blue'}, consent: true});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'invalid_answers');
  assert.match(unknown.problems.join(' '), /favourite_colour/);
  const offList = await f.reader.call('agent_score', {answers: {...GOOD, wallet_type: 'Hardware wallet'}, consent: true});
  assert.equal(offList.reason, 'invalid_answers');
  const wrongType = await f.reader.call('agent_score', {answers: {...GOOD, human_sponsor: 'yes'}, consent: true});
  assert.equal(wrongType.reason, 'invalid_answers');
  const empty = await f.reader.call('agent_score', {answers: {}, consent: true});
  assert.equal(empty.reason, 'invalid_answers');
  assert.deepEqual(validateAnswers(GOOD), []);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.reader.call('agent_score', {answers: GOOD, consent: true, url: 'https://invalid.example/'}), /Unexpected argument/);
  await assert.rejects(f.reader.call('agent_score', {answers: GOOD, consent: true, email: 'not-an-email'}), /email must be a valid address/);
  assert.equal(f.calls.length, 0);
});

test('valid answers with consent post to the hosted service and return the mapped score', async t => {
  const f = fixture(t);
  const result = await f.reader.call('agent_score', {answers: GOOD, consent: true, email: 'agent@example.com'});
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://score.example/api/v2/agentscore/calculate');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {answers: GOOD, tier: 'tier1', email: 'agent@example.com'});
  assert.deepEqual(result, {ok: true, score: 72, tier: 'GOOD', breakdown: SERVICE.breakdown, factors: SERVICE.factors, shareUrl: SERVICE.shareUrl, scoredAt: SERVICE.scoredAt, validUntil: SERVICE.validUntil});
  assert.equal(Object.hasOwn(result, 'patent'), false);
  assert.equal(f.ledger(), null);
  const noEmail = await f.reader.call('agent_score', {answers: GOOD, consent: true});
  assert.equal(noEmail.ok, true);
  assert.equal(Object.hasOwn(JSON.parse(f.calls[1].init.body), 'email'), false);
});

test('network failure, a service error and a malformed response return an error object with no score', async t => {
  for (const [fail, reason] of [['network', 'network'], ['status', 'service_error'], ['shape', 'service_error']]) {
    const f = fixture(t, {fail});
    const result = await f.reader.call('agent_score', {answers: GOOD, consent: true});
    assert.equal(result.ok, false, fail);
    assert.equal(result.reason, reason, fail);
    assert.equal(result.score, undefined, fail);
    assert.match(result.message, /No score was produced/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.ledger(), null);
  }
});

test('the tool list, annotations and JSON-RPC surface include the score tools', async t => {
  const f = fixture(t);
  const score = TOOLS.find(tool => tool.name === 'agent_score');
  const questions = TOOLS.find(tool => tool.name === 'agent_score_questions');
  assert.deepEqual(score.annotations, {readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true});
  assert.deepEqual(questions.annotations, {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
  assert.match(score.description, /transmits anything off the machine/);
  assert.deepEqual(score.inputSchema.required, ['answers', 'consent']);
  const listed = await handleRpc({jsonrpc: '2.0', id: 1, method: 'tools/list'}, f.reader);
  assert.equal(listed.result.tools.length, 6);
  const refused = await handleRpc({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'agent_score', arguments: {answers: GOOD, consent: false}}}, f.reader);
  assert.equal(refused.result.structuredContent.reason, 'consent_required');
  const scored = await handleRpc({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'agent_score', arguments: {answers: GOOD, consent: true}}}, f.reader);
  assert.equal(scored.result.structuredContent.score, 72);
  assert.equal(f.ledger(), null);
});
