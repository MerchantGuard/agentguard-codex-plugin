'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('directory metadata keeps public publisher links and existing icons in both manifests', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json')));
  const ui = manifest.extensions['com.openai'].interface;
  assert.equal(ui.privacyPolicyURL, 'https://agentguard.run/legal/privacy');
  assert.equal(ui.termsOfServiceURL, 'https://agentguard.run/legal/terms-of-service');
  assert.equal(ui.supportURL, 'https://agentguard.run/help');
  assert.equal(ui.developerName, manifest.author.name);
  assert.equal(ui.composerIcon, './assets/icon-128.png');
  assert.equal(ui.logo, './assets/logo-512.png');
  assert.ok(ui.shortDescription.length <= 30);
  assert.equal(ui.defaultPrompt.length, 3, 'three selected portal starters, further candidates in the review document');
  assert.deepEqual(ui.defaultPrompt, require('../docs/DIRECTORY_FIXTURES.json').starterCandidates.filter(item => item.selected).map(item => item.prompt));
  assert.ok(ui.defaultPrompt.every(text => text.length <= 128));
  const legacy = JSON.parse(fs.readFileSync(path.join(root, 'compat/codex-0.154/agentguard/.codex-plugin/plugin.json')));
  assert.deepEqual(legacy.interface, ui);
});
test('review document preserves the local runtime limits and domain setup instructions', () => {
  const text = fs.readFileSync(path.join(root, 'docs/DIRECTORY_SUBMISSION.md'), 'utf8');
  for (const value of ['Apps Management', 'verified', 'stdio', 'fail open', 'OPENAI_APPS_CHALLENGE_TOKEN', '/.well-known/openai-apps-challenge']) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /[\u2013\u2014\u00ae\u2122]|Agent Guard/);
});
