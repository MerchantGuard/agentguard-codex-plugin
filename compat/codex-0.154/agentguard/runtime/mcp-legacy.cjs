'use strict';
const path = require('node:path');

// Codex 0.154's legacy MCP parser roots cwd but does not expand plugin env vars.
// Match its PluginStore::plugin_data_root using only its installed cache layout.
function legacyDataDirectory(pluginRoot) {
  const versionRoot = path.resolve(pluginRoot);
  const nameRoot = path.dirname(versionRoot);
  const marketplaceRoot = path.dirname(nameRoot);
  const cacheRoot = path.dirname(marketplaceRoot);
  const pluginsRoot = path.dirname(cacheRoot);
  const marketplace = path.basename(marketplaceRoot);
  if (path.basename(nameRoot) !== 'agentguard' || path.basename(cacheRoot) !== 'cache'
    || path.basename(pluginsRoot) !== 'plugins' || !/^[A-Za-z0-9_-]+$/.test(marketplace)
    || !/^[A-Za-z0-9._-]+$/.test(path.basename(versionRoot))) {
    throw new Error('Set PLUGIN_DATA explicitly when running the legacy MCP server outside the Codex plugin cache.');
  }
  return path.join(pluginsRoot, 'data', `agentguard-${marketplace}`);
}

function start() {
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = legacyDataDirectory(path.resolve(__dirname, '..'));
  require('./mcp.cjs').startServer();
}
module.exports = {legacyDataDirectory, start};
if (require.main === module) {
  try { start(); } catch {
    process.stderr.write('agentguard: legacy MCP requires valid cache/data configuration and provisioned dependencies.\n');
    process.exitCode = 1;
  }
}
