'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Read-only snapshots include contents and modification metadata. Access time
// is excluded because reading the snapshot itself can update it. Follow links
// without recursing through a directory cycle, so aliases cannot hide changes.
function snapshot(directory) {
  const entries = new Map();
  function visit(file, relative, ancestors) {
    let link;
    try { link = fs.lstatSync(file, {bigint: true}); }
    catch (error) { if (error.code === 'ENOENT') { entries.set(relative, null); return; } throw error; }
    const fields = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    const value = {metadata: fields(link)};
    let stat = link;
    if (link.isSymbolicLink()) {
      value.link = fs.readlinkSync(file);
      try { stat = fs.statSync(file, {bigint: true}); value.target = fields(stat); }
      catch (error) { if (error.code === 'ENOENT') { entries.set(relative, value); return; } throw error; }
    }
    if (stat.isFile()) {
      const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try { for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, count)); }
      finally { fs.closeSync(fd); }
      value.sha256 = hash.digest('hex');
    }
    entries.set(relative, value);
    if (!stat.isDirectory()) return;
    const identity = `${stat.dev}:${stat.ino}`;
    if (ancestors.has(identity)) return;
    const next = new Set([...ancestors, identity]);
    for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name), next);
  }
  visit(directory, '.', new Set());
  return entries;
}

function assertUnchanged(directory, before) {
  const after = snapshot(directory);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter(name => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)));
  if (changed.length) throw new Error(`Test isolation failed: protected AgentGuard home changed (${changed.slice(0, 10).join(', ')}).`);
}

module.exports = {snapshot, assertUnchanged};
