const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const LOCK_NAME = '.fund-manager.lock';
const locks = new Map();

function lockError(lockPath, cause) {
  const error = new Error(`Data directory is locked or its owner cannot be verified: ${lockPath}. Stop every process using this ledger before manually removing the lock directory.`, { cause });
  error.code = 'FUND_DATA_DIRECTORY_LOCKED';
  return error;
}

function acquireDataDirectoryLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const canonicalDir = fs.realpathSync(dataDir);
  const key = process.platform === 'win32' ? canonicalDir.toLowerCase() : canonicalDir;
  const existing = locks.get(key);
  if (existing) {
    // A fresh storage module has independent caches even inside one process.
    // Sharing its lease would permit stale writes to overwrite another module.
    throw lockError(existing.lockPath);
  }
  const lockPath = path.join(canonicalDir, LOCK_NAME);
  const ownerPath = path.join(lockPath, 'owner.json');
  const token = randomUUID();
  try {
    fs.mkdirSync(lockPath);
  } catch (cause) {
    throw lockError(lockPath, cause);
  }
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch (cause) {
    // Only the directory just created by this invocation is eligible for cleanup.
    try { fs.unlinkSync(ownerPath); } catch (_) { /* fail closed if cleanup fails */ }
    try { fs.rmdirSync(lockPath); } catch (_) { /* leave unverifiable lock in place */ }
    throw lockError(lockPath, cause);
  }
  let released = false;
  const handle = {
    lockPath,
    assertOwned() {
      try {
        if (released || JSON.parse(fs.readFileSync(ownerPath, 'utf8')).token !== token) throw new Error('Lock ownership lost');
      } catch (cause) {
        throw lockError(lockPath, cause);
      }
    },
    release() {
      if (released) return;
      handle.assertOwned();
      fs.unlinkSync(ownerPath);
      fs.rmdirSync(lockPath);
      released = true;
      locks.delete(key);
    }
  };
  locks.set(key, handle);
  return handle;
}

// SIGKILL, power loss, and crashes may leave a lock behind. Never steal it based
// on a PID: the directory can be shared by hosts with unrelated PID spaces.
process.once('exit', () => {
  for (const handle of locks.values()) {
    try { handle.release(); } catch (_) { /* retain lock on ambiguous ownership */ }
  }
});

module.exports = { acquireDataDirectoryLock, LOCK_NAME };
