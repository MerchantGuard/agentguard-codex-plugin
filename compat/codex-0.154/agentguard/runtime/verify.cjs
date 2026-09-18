#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const {createReader} = require('./mcp.cjs');
async function run(args, options = {}) {
  const reader = options.reader || createReader(options);
  const exporting = ['export', '--export'].includes(args[0]);
  if (args.length && (!exporting || args.length !== 2)) throw new Error('Use verify.cjs or verify.cjs export FILE.');
  const verification = await reader.call('verify_chain');
  if (!verification.ok) throw new Error('Chain verification failed.');
  if (!exporting) return verification;
  let fromSequence = 0, bundle, entries = [];
  do {
    bundle = await reader.call('export_receipts', {fromSequence, limit: 200});
    entries.push(...bundle.entries);
    fromSequence = bundle.nextSequence;
  } while (fromSequence !== null);
  const sdk = require('./dependencies.cjs').loadDependency('@agentguard-run/spend');
  if (entries.length && !(await sdk.verifyChain(entries, Buffer.from(bundle.publicKeyHex, 'hex'))).ok) throw new Error('Chain changed during export.');
  const result = {...bundle, entries, complete: true, nextSequence: null, totalEntries: entries.length};
  fs.writeFileSync(args[1], JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return {ok: true, entries: entries.length, exported: args[1]};
}
module.exports = {run};
if (require.main === module) run(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value) + '\n'))
  .catch(error => {process.stderr.write(error.code === 'license_required' || error.code === 'seat_limit'
    ? `agentguard: ${error.code}; verification is free, receipt export requires a paid license.\n`
    : 'agentguard: verification or export failed; check the ledger and destination.\n');process.exitCode = 1;});
