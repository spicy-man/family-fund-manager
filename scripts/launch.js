// The visible console owns this process. The server uses a separate session so
// Windows console-close cannot kill it before it releases the NAS ledger lock.
// IPC closes even if this launcher is forcibly killed; the server then exits.
const path = require('path');
const { spawn } = require('child_process');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'),
  '--launcher-child', ...process.argv.slice(2)], {
  detached: true,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc']
});

child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
// A disappearing terminal can close its output before delivering the signal.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => { if (child.connected) child.disconnect(); });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { if (child.connected) child.disconnect(); });
}
child.on('error', error => {
  console.error('[启动失败]', error.message);
  process.exit(1);
});
child.on('exit', (code, signal) => { process.exit(code ?? (signal ? 1 : 0)); });
