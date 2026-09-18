'use strict';
const fs = require('node:fs');
const path = require('node:path');
function readPolicy(data) {
  const local = path.join(data, 'policy.json');
  let personal;
  try { personal = JSON.parse(fs.readFileSync(local, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; personal = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/default-policy.json'), 'utf8')); }
  const teamFile = process.env.AGENTGUARD_PLUGIN_POLICY || personal.teamPolicyFile;
  if (!teamFile || path.resolve(data, teamFile) === path.resolve(local)) return {policy: personal, personal, team: false};
  const shared = JSON.parse(fs.readFileSync(path.resolve(data, teamFile), 'utf8'));
  return {policy: {...personal, ...shared, ...(personal.licenseKey ? {licenseKey: personal.licenseKey} : {})}, personal, team: true};
}
module.exports = {readPolicy};
