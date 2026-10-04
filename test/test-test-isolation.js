const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-isolation-'));
try {
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  // Any accidental storage load would attempt recovery and fail on this marker.
  const journal = path.join(data, '.snapshot-transaction.json');
  fs.writeFileSync(journal, 'must never be read or recovered');
  for (const file of ['test-calculator.js', 'test-performance-settlement.js']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
      encoding: 'utf8', env: { ...process.env, FUND_DATA_DIR: data, FUND_BACKUP_DIR: path.join(root, 'backups') }
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(fs.readdirSync(data), ['.snapshot-transaction.json']);
    assert.strictEqual(fs.readFileSync(journal, 'utf8'), 'must never be read or recovered');
    assert(!fs.existsSync(path.join(root, 'backups')));
  }
  assert.strictEqual(require('../package.json').scripts.test, 'node scripts/run-tests.js');
  console.log('Pure calculation tests do not load storage or recover a ledger.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
