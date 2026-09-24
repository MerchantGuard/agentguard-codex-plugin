'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const json = name => JSON.parse(read(name));

test('Claude marketplace installs the shared root without renaming the public package', () => {
  const manifest = json('.claude-plugin/plugin.json');
  const portable = json('plugin.json');
  for (const field of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license']) assert.deepEqual(manifest[field], portable[field]);
  assert.equal(manifest.hooks, undefined, 'default hooks must not also be declared as an additional source');
  const market = json('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'agentguard');
  assert.equal(market.owner.name, 'MerchantGuardOps');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].source, './');
  assert.equal(market.plugins[0].version, manifest.version);
  assert.equal(json('package.json').name, '@agentguard-run/codex-plugin');
  for (const file of ['.claude-plugin', '.mcp.json']) assert.ok(json('package.json').files.includes(file));
  assert.deepEqual(json('.mcp.json').mcpServers.agentguard, {command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/runtime/mcp.cjs']});
});

test('Claude failure receipts and Codex hooks use the same scripts with host-native roots', () => {
  const claude = json('hooks/hooks.json').hooks;
  const codex = json('hooks/codex-hooks.json').hooks;
  assert.deepEqual(claude.PostToolUseFailure, claude.PostToolUse);
  assert.equal(codex.PostToolUseFailure, undefined);
  for (const [event, groups] of Object.entries(claude)) {
    for (const group of groups) {
      if (event.includes('ToolUse')) assert.equal(group.matcher, '.*');
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command');
        assert.equal(hook.timeout, 2);
        assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
        const script = hook.command.match(/\/hooks\/([a-z-]+\.cjs)/)?.[1];
        assert.ok(script && fs.existsSync(path.join(root, 'hooks', script)));
      }
    }
  }
  assert.deepEqual(Buffer.from(read('hooks/codex-hooks.json')), require('../scripts/build-compat.cjs').codexHooks());
});

test('README offers three commands per host while sharing all four skills', () => {
  const intro = read('README.md').split('\n## Details\n')[0];
  const blocks = [...intro.matchAll(/```sh\n([\s\S]*?)\n```/g)].map(match => match[1].split('\n').filter(line => line && !line.startsWith('#')));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1], ['claude plugin marketplace add MerchantGuard/agentguard-codex-plugin', 'claude plugin install agentguard@agentguard', 'npm ci']);
  for (const skill of ['agentguard-policy', 'agentguard-score', 'agentguard-status', 'agentguard-verify']) {
    const file = `skills/${skill}/SKILL.md`;
    assert.equal(read(file), read(`compat/codex-0.154/agentguard/${file}`));
  }
  assert.match(read('skills/agentguard-status/SKILL.md'), /Report `host`/);
});
