const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-launcher-'));
const dataDir = path.join(root, 'data');
const lockPath = path.join(dataDir, '.fund-manager.lock');
const children = [];
const serverPids = [];
const sockets = [];
const preload = path.join(root, 'signal.js');
fs.writeFileSync(preload, "process.on('message', signal => process.emit(signal));\n");
const env = { ...process.env, FUND_DATA_DIR: dataDir,
  FUND_BACKUP_DIR: path.join(root, 'backups'), FUND_EXTERNAL_SYNC: '0', PORT: '0' };
async function until(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${description}`);
}
function dead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}
function start() {
  const child = spawn(process.execPath, ['--require', preload,
    path.join(__dirname, '..', 'scripts', 'launch.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  children.push(child);
  child.output = '';
  child.stdout.on('data', data => { child.output += data; });
  child.stderr.on('data', data => { child.output += data; });
  return child;
}
async function ready(child) {
  await until(() => {
    if (child.exitCode !== null) throw new Error(child.output);
    return /http:\/\/localhost:\d+/.test(child.output);
  }, 'server listening');
  const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json')));
  serverPids.push(owner.pid);
  const port = Number(child.output.match(/http:\/\/localhost:(\d+)/)[1]);
  const status = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/members`, res => { res.resume(); resolve(res.statusCode); })
      .on('error', reject);
  });
  assert.strictEqual(status, 200);
  return { pid: owner.pid, port };
}
async function waitExit(child) {
  let timer;
  try {
    return await Promise.race([once(child, 'exit'), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Launcher did not exit: ${child.output}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}
(async () => {
  try {
    for (const signal of ['SIGINT', 'SIGHUP', 'SIGKILL']) {
      const launcher = start();
      const { pid, port } = await ready(launcher);
      const before = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
      if (signal === 'SIGINT') {
        const second = start();
        const [code] = await waitExit(second);
        assert.notStrictEqual(code, 0);
        assert.match(second.output, /FUND_DATA_DIRECTORY_LOCKED/);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'))).pid, pid);
      }
      if (signal === 'SIGHUP') {
        // A client stalled mid-request must not retain the lock indefinitely.
        const socket = net.connect(port, '127.0.0.1');
        sockets.push(socket);
        socket.on('error', () => {});
        await once(socket, 'connect');
        socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const exited = waitExit(launcher);
      if (signal === 'SIGKILL') launcher.kill(signal);
      else launcher.send(signal); // Exercise handlers on Windows as well as POSIX.
      await exited;
      await until(() => !fs.existsSync(lockPath) && dead(pid), `${signal} releases lock and exits server`);
      assert.strictEqual(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), before);
    }
    const worker = spawn(process.execPath, ['-e', `
      const { runFile } = require(${JSON.stringify(require.resolve('../lib/runtime-children'))});
      const child = runFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], () => {});
      process.send(child.pid);
      process.on('message', () => process.exit(0));
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(worker);
    const [helperPid] = await once(worker, 'message');
    serverPids.push(helperPid);
    const exited = waitExit(worker);
    worker.send('exit');
    await exited;
    await until(() => dead(helperPid), 'pending helper exits with service');
    console.log('Launcher close, forced launcher death, restart, exclusivity, and helper cleanup passed.');
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    for (const pid of serverPids) { try { process.kill(pid); } catch (_) { /* exited */ } }
    await until(() => serverPids.every(dead), 'test workers cleaned up');
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
