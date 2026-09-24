'use strict';

// The AgentGuard Score questionnaire, copied from the hosted service so the
// plugin can present and validate a complete answer set offline. Question
// ids, wording, order and option strings must stay identical to the hosted
// questionnaire; the hosted service scores the answers, this module never does.

const INTRO = [
  'AgentGuard Score',
  'Five questions about the controls around an agent that moves money: an accountable human, where the funds sit, transaction limits and an audit trail. It scores what you report and verifies nothing. Use it as a checklist and a starting point for a conversation with a payment provider.',
].join('\n\n');

const QUESTIONS = [
  {
    id: 'agent_type',
    question: 'What kind of agent is this?',
    type: 'select',
    options: [
      'Autonomous commerce agent (makes purchases)',
      'Customer service agent',
      'Data processing agent',
      'Financial advisor agent',
      'Content creation agent',
      'Other',
    ],
    category: 'risk',
  },
  {
    id: 'human_sponsor',
    question: 'Is a named human accountable for this agent, and can a third party verify who that is?',
    type: 'boolean',
    category: 'compliance',
  },
  {
    id: 'wallet_type',
    question: 'Where does the agent\'s money sit?',
    type: 'select',
    options: [
      'Custodial account (Circle, Coinbase, a processor balance)',
      'Self-custody with multi-sig (Safe)',
      'Virtual card or card-issuing API',
      'Bank account the agent can draw on',
      'Personal wallet or personal card',
      'None yet',
    ],
    category: 'infrastructure',
  },
  {
    id: 'transaction_limits',
    question: 'Are per-transaction and daily limits enforced somewhere the agent cannot change them?',
    type: 'boolean',
    category: 'compliance',
  },
  {
    id: 'audit_trail',
    question: 'Is every payment action logged with a timestamp the agent cannot edit?',
    type: 'boolean',
    category: 'compliance',
  },
];

const BY_ID = new Map(QUESTIONS.map(question => [question.id, question]));

// Validate a complete answer set against the questionnaire. Returns the list
// of problems; an empty list means every question has a usable answer. A
// missing answer is a problem because a partial set would score differently
// from a complete one. Unknown ids and values outside the published options
// are refused so nothing unexpected is ever sent to the hosted service.
function validateAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return ['answers must be an object keyed by question id.'];
  const problems = [];
  for (const key of Object.keys(answers)) {
    const question = BY_ID.get(key);
    if (!question) { problems.push(`${key} is not a questionnaire question.`); continue; }
    const value = answers[key];
    if (question.type === 'boolean') {
      if (typeof value !== 'boolean') problems.push(`${key} must be true or false.`);
    } else if (question.type === 'select') {
      if (typeof value !== 'string' || !question.options.includes(value)) problems.push(`${key} must be one of the published options.`);
    }
  }
  for (const question of QUESTIONS) {
    if (!Object.hasOwn(answers, question.id)) problems.push(`${question.id} is unanswered; every question must be answered.`);
  }
  return problems;
}

module.exports = {INTRO, QUESTIONS, validateAnswers};
