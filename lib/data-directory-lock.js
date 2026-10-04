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

// Recover only a verified dead owner on this host. A separate atomic directory
// serializes recovery so two starters cannot remove each other's new lease.
function recoverDeadLocalOwner(lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  try { fs.mkdirSync(recoveryPath); } catch (_) { return false; }
  try {
    const ownerPath = path.join(lockPath, 'owner.json');
    const original = fs.readFileSync(ownerPath, 'utf8');
    const owner = JSON.parse(original);
    if (owner.hostname !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.token !== 'string' || !owner.token) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      // Permission errors and unknown failures do not prove the owner is dead.
      if (error.code !== 'ESRCH') return false;
    }
    if (fs.readFileSync(ownerPath, 'utf8') !== original) return false;
    // Never recursively remove a lock: unexpected files require manual review.
    if (fs.readdirSync(lockPath).some(name => name !== 'owner.json')) return false;
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
    return true;
  } catch (_) {
    return false;
  } finally {
    try { fs.rmdirSync(recoveryPath); } catch (_) { /* fail closed on recovery ambiguity */ }
  }
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
    if (cause.code !== 'EEXIST' || !recoverDeadLocalOwner(lockPath)) throw lockError(lockPath, cause);
    // Another starter can win the lease after recovery. Respect its ownership.
    try { fs.mkdirSync(lockPath); } catch (error) { throw lockError(lockPath, error); }
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

// Normal exits release immediately; forced exits are recovered on next startup
// only when the recorded host matches and its owner is verified dead.
process.once('exit', () => {
  for (const handle of locks.values()) {
    try { handle.release(); } catch (_) { /* retain lock on ambiguous ownership */ }
  }
});

module.exports = { acquireDataDirectoryLock, LOCK_NAME };
