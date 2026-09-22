// Full host suites exercise STOPs on macOS without showing desktop notifications.
const child = require('node:child_process');
const original = child.execFile;
child.execFile = function (file, ...args) {
  if (file === '/usr/bin/osascript') { const callback = args.at(-1); if (typeof callback === 'function') callback(null, '', ''); return {}; }
  return original.call(this, file, ...args);
};
