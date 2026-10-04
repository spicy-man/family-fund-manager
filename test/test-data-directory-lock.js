const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const { acquireDataDirectoryLock, LOCK_NAME } = require('../lib/data-directory-lock');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-directory-lock-'));
const storageModule = require.resolve('../lib/storage');
const children = [];
function options(dataDir, port = '0') {
  return { env: { ...process.env, FUND_DATA_DIR: dataDir, FUND_BACKUP_DIR: path.join(dataDir, 'backups'), FUND_EXTERNAL_SYNC: '0', PORT: port }, encoding: 'utf8' };
}
function run(dataDir, script) {
  return spawnSync(process.execPath, ['-e', script], options(dataDir));
}
const readScript = `const storage = require(${JSON.stringify(storageModule)}); storage.readDb();`;

(async () => {
  try {
    const dataDir = path.join(root, 'contended');
    const worker = spawn(process.execPath, ['-e', `${readScript} process.send('ready'); process.on('message', () => process.exit(0));`], {
      ...options(dataDir, '3000'), stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    children.push(worker);
    await Promise.race([
      once(worker, 'message'),
      once(worker, 'exit').then(([code]) => { throw new Error(`Lock owner exited before ready: ${code}`); })
    ]);
    const before = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
    const contender = run(dataDir, readScript);
    assert.notStrictEqual(contender.status, 0);
    assert.match(contender.stderr, /FUND_DATA_DIRECTORY_LOCKED/);
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), before);
    const exited = once(worker, 'exit');
    worker.send('exit');
    await exited;
    assert(!fs.existsSync(path.join(dataDir, LOCK_NAME)), 'normal exit releases directory');
    assert.strictEqual(run(dataDir, readScript).status, 0, 'next process can acquire after release');

    // Closing a Windows terminal forcibly kills Node without its exit hook.
    const forcedDir = path.join(root, 'forced-exit');
    const lockModule = require.resolve('../lib/data-directory-lock');
    const holdScript = `const { acquireDataDirectoryLock } = require(${JSON.stringify(lockModule)});
      acquireDataDirectoryLock(process.env.FUND_DATA_DIR);
      process.send('ready'); process.on('message', () => process.exit(0));`;
    const forced = spawn(process.execPath, ['-e', holdScript], {
      ...options(forcedDir), stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    children.push(forced);
    await once(forced, 'message');
    const forcedExited = once(forced, 'exit');
    forced.kill('SIGKILL');
    await forcedExited;
    const forcedLock = path.join(forcedDir, LOCK_NAME);
    assert(fs.existsSync(forcedLock), 'forced exit leaves a lease for recovery');
    const contenderScript = `try {
      const { acquireDataDirectoryLock } = require(${JSON.stringify(lockModule)});
      acquireDataDirectoryLock(process.env.FUND_DATA_DIR);
      process.send('acquired'); process.on('message', () => process.exit(0));
    } catch (error) {
      if (error.code !== 'FUND_DATA_DIRECTORY_LOCKED') throw error;
      process.send('denied', () => process.exit(0));
    }`;
    const contenders = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, ['-e', contenderScript], {
        ...options(forcedDir), stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      children.push(child);
      return child;
    });
    const results = await Promise.all(contenders.map(child => once(child, 'message')));
    assert.strictEqual(results.filter(([result]) => result === 'acquired').length, 1,
      'concurrent recovery grants exactly one lease');
    const winner = contenders[results.findIndex(([result]) => result === 'acquired')];
    const winnerExited = once(winner, 'exit');
    winner.send('exit');
    await winnerExited;
    assert(!fs.existsSync(forcedLock), 'recovered lease releases normally');
    assert(!fs.existsSync(`${forcedLock}.recovery`), 'recovery guard releases');
    assert.strictEqual(run(forcedDir, readScript).status, 0, 'restart after forced exit succeeds');

    const serverDir = path.join(root, 'cli-server');
    const serverModule = require.resolve('../server');
    const preload = path.join(root, 'signal-preload.js');
    // Windows child.kill('SIGTERM') forcibly terminates the process, so use IPC
    // to exercise the installed JS signal handler on every supported platform.
    fs.writeFileSync(preload, "process.on('message', () => process.emit('SIGTERM'));\n");
    const cli = spawn(process.execPath, ['--require', preload, serverModule], {
      ...options(serverDir), stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    children.push(cli);
    let cliOutput = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${cliOutput}`)), 15000);
      cli.stdout.on('data', chunk => {
        cliOutput += chunk;
        if (cliOutput.includes('http://localhost:')) { clearTimeout(timer); resolve(); }
      });
      cli.stderr.on('data', chunk => { cliOutput += chunk; });
      cli.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited before listening: ${code}: ${cliOutput}`)); });
    });
    const secondCli = spawnSync(process.execPath, [serverModule], options(serverDir, '3001'));
    assert.notStrictEqual(secondCli.status, 0);
    assert.match(secondCli.stderr, /FUND_DATA_DIRECTORY_LOCKED/, 'different listening ports cannot share a ledger');
    const cliExited = once(cli, 'exit');
    cli.send('terminate');
    const [cliExitCode] = await cliExited;
    assert.strictEqual(cliExitCode, 0);
    assert(!fs.existsSync(path.join(serverDir, LOCK_NAME)), 'CLI signal shutdown releases its lock');

    const staleDir = path.join(root, 'stale');
    const lockPath = path.join(staleDir, LOCK_NAME);
    fs.mkdirSync(lockPath, { recursive: true });
    // Even a known-dead PID must not permit stealing a lock on a shared host.
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 2147483647, hostname: 'another-host' }));
    const journalPath = path.join(staleDir, '.snapshot-transaction.json');
    const journal = JSON.stringify({ version: 1, previous: { db: null, config: null, settlements: null, marker: null } });
    fs.writeFileSync(journalPath, journal);
    fs.writeFileSync(path.join(staleDir, 'db.json'), 'interrupted content');
    const stale = run(staleDir, readScript);
    assert.match(stale.stderr, /FUND_DATA_DIRECTORY_LOCKED/);
    assert.strictEqual(fs.readFileSync(journalPath, 'utf8'), journal, 'no recovery before exclusive ownership');
    assert.strictEqual(fs.readFileSync(path.join(staleDir, 'db.json'), 'utf8'), 'interrupted content');
    assert(!fs.existsSync(path.join(staleDir, 'backups')), 'no backup creation before ownership');
    fs.unlinkSync(path.join(lockPath, 'owner.json'));
    assert.match(run(staleDir, readScript).stderr, /FUND_DATA_DIRECTORY_LOCKED/, 'ownerless lock also fails closed');
    fs.rmdirSync(lockPath); // all workers on this temporary directory have exited
    assert.strictEqual(run(staleDir, readScript).status, 0);
    assert(!fs.existsSync(journalPath), 'manual recovery permits journal recovery on restart');

    const reloadDir = path.join(root, 'reload');
    const reload = run(reloadDir, `${readScript}
      delete require.cache[require.resolve(${JSON.stringify(storageModule)})];
      require('assert').throws(() => require(${JSON.stringify(storageModule)}),
        error => error.code === 'FUND_DATA_DIRECTORY_LOCKED');
      const firstDb = storage.readDb();
      firstDb.auditMarker = 'preserved';
      storage.writeDb(firstDb);
      storage.releaseDataDirectoryLock();
      const again = require(${JSON.stringify(storageModule)});
      require('assert').strictEqual(again.readDb().auditMarker, 'preserved');
      require('assert').throws(() => storage.readDb(), /locked/);
      require('assert').throws(() => storage.atomicWriteFile(storage.DB_FILE, '{}'), /locked/);
      again.releaseDataDirectoryLock();
    `);
    assert.strictEqual(reload.status, 0, reload.stderr);

    const writeErrorDir = path.join(root, 'metadata-error');
    const originalWrite = fs.writeFileSync;
    try {
      fs.writeFileSync = (file, ...args) => {
        if (path.basename(file) === 'owner.json') throw new Error('injected metadata failure');
        return originalWrite(file, ...args);
      };
      assert.throws(() => acquireDataDirectoryLock(writeErrorDir), /cannot be verified/);
    } finally { fs.writeFileSync = originalWrite; }
    assert(!fs.existsSync(path.join(writeErrorDir, LOCK_NAME)));
    const handle = acquireDataDirectoryLock(writeErrorDir);
    assert.throws(() => acquireDataDirectoryLock(writeErrorDir), /locked/);
    fs.writeFileSync(path.join(handle.lockPath, 'owner.json'), '{}');
    assert.throws(() => handle.assertOwned(), /locked/);
    assert.throws(() => handle.release(), /locked/);
    assert(fs.existsSync(handle.lockPath), 'lost ownership cannot remove another owner lock');

    const badRecoveryDir = path.join(root, 'bad-recovery');
    fs.mkdirSync(badRecoveryDir);
    fs.writeFileSync(path.join(badRecoveryDir, '.snapshot-transaction.json'), '{}');
    assert.match(run(badRecoveryDir, readScript).stderr, /cannot be recovered/);
    assert(!fs.existsSync(path.join(badRecoveryDir, LOCK_NAME)), 'failed initialization releases its own lock');
    console.log('Data directory exclusivity, lock release, stale-owner refusal, and guarded recovery assertions passed.');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
