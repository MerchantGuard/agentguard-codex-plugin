#!/usr/bin/env node
'use strict';
const net = require('node:net');
const { locations } = require('./common.cjs');
if (process.argv[2] !== 'stop') { process.stderr.write('Usage: node runtime/control.cjs stop\n'); process.exitCode = 1; }
else {
  // Ask the private socket to stop; a stale PID file must never kill an unrelated process.
  const socket = net.createConnection(locations().socket);
  socket.setTimeout(1000, () => socket.destroy());
  socket.on('connect', () => socket.write('{"control":"stop"}\n'));
  socket.on('data', () => socket.destroy());
  socket.on('error', error => { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) process.exitCode = 1; });
}
