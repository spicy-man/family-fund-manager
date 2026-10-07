const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-ledger-startup-'));
process.env.FUND_DATA_DIR = path.join(root, 'data');
process.env.FUND_BACKUP_DIR = path.join(root, 'backups');
process.env.FUND_EXTERNAL_SYNC = '1';
const fetched = [];
const yahoo = require('../lib/yahoo');
yahoo.fetchCnhRateFromApi = async () => null;
yahoo.fetchYahooPrices = async ticker => {
  fetched.push(ticker);
  return { '2026-03-02': 100 };
};
const storage = require('../lib/storage');
const dir = path.join(root, 'data', 'ledger-2');
const seed = storage.createStorage({ dataDir: dir, backupDir: path.join(root, 'backups', 'ledger-2') });
const db = seed.readDb();
db.events = [{ id: 'existing-deposit', type: 'deposit', member: db.members[0].id, amount: 100, cnhAmount: 720, date: '2026-03-03', sequenceNumber: 1 }];
db.lastEventSequence = 1;
seed.writeSnapshot(db, storage.readConfig(), seed.readSettlements());
seed.atomicWriteFile(path.join(dir, 'ledger.json'), JSON.stringify({ id: 'ledger-2', name: '已有账本' }));
seed.releaseDataDirectoryLock();
const { startServer } = require('../server');
const server = startServer({ port: 0 });
function state() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/state?ledger=ledger-2' }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}
(async () => {
  try {
    await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
    assert.deepStrictEqual(fetched, [], 'an empty default ledger has no benchmark dates');
    assert.strictEqual((await state()).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(fetched.sort(), ['QQQM', 'VOO'], 'opening an existing child ledger must refresh its benchmarks');
    assert.strictEqual(storage.readIndexCache()['2026-03-03'].spx, 100);
    assert.strictEqual((await state()).status, 200);
    assert.strictEqual(fetched.length, 2, 'requests to an initialized ledger must not repeat startup synchronization');
    assert.strictEqual(storage.readDb().events.length, 0, 'opening a child ledger must leave the default ledger empty');
    console.log('Existing child-ledger benchmark synchronization after startup passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    process.emit('exit', 0);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
