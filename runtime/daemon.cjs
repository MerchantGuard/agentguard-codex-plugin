'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { locations, writeWorkerPid } = require('./common.cjs');
const loc = locations();
let server, idle, queue = Promise.resolve();
function stop() {
  clearTimeout(idle);
  server?.close();
  try { if (fs.readFileSync(loc.lock, 'utf8') === String(process.pid)) { fs.unlinkSync(loc.lock); try { fs.unlinkSync(loc.socket); } catch {} } } catch {}
  process.exit(0);
}
function touch() { clearTimeout(idle); idle = setTimeout(stop, 300000); }
async function main() {
  const owner = Number(fs.readFileSync(loc.lock, 'utf8'));
  if (owner !== process.pid && owner !== process.ppid) return;
  writeWorkerPid(loc.lock, process.pid);
  const { Engine } = require('./engine.cjs');
  const engine = new Engine(); await engine.init();
  try { fs.unlinkSync(loc.socket); } catch {}
  server = net.createServer(socket => {
    touch(); let text = '', accepted = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (accepted) return;
      text += chunk;
      if (text.length > 32768) { socket.destroy(); return; }
      if (!text.includes('\n')) return;
      accepted = true;
      queue = queue.then(async () => {
        try {
          const message = JSON.parse(text.split('\n')[0]);
          if (message.control === 'stop') { socket.end('{}\n', stop); return; }
          socket.end(JSON.stringify(await engine.handle(message)) + '\n');
        }
        catch { socket.destroy(); }
        touch();
      });
    });
  });
  server.listen(loc.socket, () => { fs.chmodSync(loc.socket, 0o600); touch(); });
  server.on('error', stop);
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch(stop);
