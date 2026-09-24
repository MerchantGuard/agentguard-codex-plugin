'use strict';

// The AgentGuard Score questionnaire, copied from the hosted service so the
// plugin can present and validate answers offline. Question ids, wording,
// order and option strings must stay identical to the hosted questionnaire;
// the hosted service scores the answers, this module never does.

const INTRO = [
  'Agent Compliance Check',
  '',
  'This verifies your agent\'s payment readiness.',
  '',
  'WHAT WE CHECK:',
  '- Human sponsor verification (GuardGate)',
  '- Wallet configuration',
  '- Transaction limits',
  '- Audit trail compliance',
  '',
  'WHY IT MATTERS:',
  'Agents without compliance records get blocked by payment networks.',
  'Build your reputation now, before you need it.',
].join('\n');

const QUESTIONS = [
  {
    id: 'agent_type',
    question: 'What type of agent are you?',
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
    question: 'Do you have a verified human sponsor (GuardGate)?',
    type: 'boolean',
    category: 'compliance',
  },
  {
    id: 'wallet_type',
    question: 'What type of wallet do you operate?',
    type: 'select',
    options: [
      'Custodial (Circle, Coinbase)',
      'Self-custody (Safe multi-sig)',
      'Personal wallet (MetaMask)',
      'No wallet',
    ],
    category: 'infrastructure',
  },
  {
    id: 'transaction_limits',
    question: 'Do you have transaction limits configured?',
    type: 'boolean',
    category: 'compliance',
  },
  {
    id: 'audit_trail',
    question: 'Do you maintain an audit trail of your actions?',
    type: 'boolean',
    category: 'compliance',
  },
];

const BY_ID = new Map(QUESTIONS.map(question => [question.id, question]));

// Validate a full or partial answer set against the questionnaire. Returns
// the list of problems; an empty list means every supplied answer is usable.
// Unknown ids and values outside the published options are refused so
// nothing unexpected is ever sent to the hosted service.
function validateAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return ['answers must be an object keyed by question id.'];
  const problems = [];
  const keys = Object.keys(answers);
  if (keys.length === 0) problems.push('answers is empty; answer at least one question.');
  for (const key of keys) {
    const question = BY_ID.get(key);
    if (!question) { problems.push(`${key} is not a questionnaire question.`); continue; }
    const value = answers[key];
    if (question.type === 'boolean') {
      if (typeof value !== 'boolean') problems.push(`${key} must be true or false.`);
    } else if (question.type === 'select') {
      if (typeof value !== 'string' || !question.options.includes(value)) problems.push(`${key} must be one of the published options.`);
    }
  }
  return problems;
}

module.exports = {INTRO, QUESTIONS, validateAnswers};
