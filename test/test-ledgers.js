const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const AdmZip = require('adm-zip');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-ledgers-'));
process.env.FUND_DATA_DIR = path.join(root, 'data');
process.env.FUND_BACKUP_DIR = path.join(root, 'backups');
process.env.FUND_EXTERNAL_SYNC = '0';
const { startServer } = require('../server');
const storage = require('../lib/storage');
const server = startServer({ port: 0 });
function request(method, url, ledger, body, binary = false) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: url,
      headers: { ...(ledger === undefined ? {} : { 'X-Ledger-Id': ledger }),
        ...(payload ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json', 'Content-Length': payload.length } : {}) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const value = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: binary ? value : JSON.parse(value) });
      });
    });
    req.on('error', reject); req.end(payload);
  });
}
(async () => {
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  try {
    const initial = await request('GET', '/api/ledgers');
    assert.deepStrictEqual(initial.body.data, [{ id: 'default', name: '账本1', isDefault: true }]);
    await request('POST', '/api/members', 'default', { name: 'Only default' });
    const before = fs.readFileSync(path.join(root, 'data/db.json'));
    const originalCreateStorage = storage.createStorage;
    const failedDir = path.join(root, 'data', 'ledger-2');
    const failedBackups = path.join(root, 'backups', 'ledger-2');
    for (const stage of ['storage', 'snapshot', 'metadata']) {
      storage.createStorage = options => {
        if (stage === 'storage') throw new Error('simulated storage initialization failure');
        const store = originalCreateStorage(options);
        if (stage === 'snapshot') {
          const write = store.writeSnapshot;
          store.writeSnapshot = (...args) => { write(...args); throw new Error('simulated snapshot failure'); };
        } else {
          const write = store.atomicWriteFile;
          store.atomicWriteFile = (file, ...args) => {
            if (path.basename(file) === 'ledger.json') throw new Error('simulated metadata failure');
            return write(file, ...args);
          };
        }
        return store;
      };
      try {
        assert.strictEqual((await request('POST', '/api/ledgers', 'default', { name: '失败创建' })).status, 500);
        assert(!fs.existsSync(failedDir), `${stage} failure must not leave an invisible ledger directory`);
        assert(!fs.existsSync(failedBackups), `${stage} failure must clean up its newly created backups`);
        assert.strictEqual((await request('GET', '/api/ledgers')).body.data.length, 1);
        assert(before.equals(fs.readFileSync(path.join(root, 'data/db.json'))));
      } finally { storage.createStorage = originalCreateStorage; }
    }
    // Historical backups are not owned by a failed creation and must survive.
    fs.mkdirSync(failedBackups, { recursive: true });
    fs.writeFileSync(path.join(failedBackups, 'existing-backup.zip'), 'historical backup');
    const historyNames = Array.from({ length: 15 }, (_, index) => `snapshot_backup_2020-01-01T00-00-00-000Z_${String(index).padStart(6, '0')}.zip`);
    const historicZip = new AdmZip();
    historicZip.addFile('data/db.json', before);
    historicZip.addFile('data/config.json', fs.readFileSync(path.join(root, 'data/config.json')));
    historicZip.addFile('data/settlements.json', fs.readFileSync(path.join(root, 'data/settlements.json')));
    const historicBytes = historicZip.toBuffer();
    historyNames.forEach(name => fs.writeFileSync(path.join(failedBackups, name), historicBytes));
    storage.createStorage = () => { throw new Error('simulated storage failure with existing backups'); };
    try {
      assert.strictEqual((await request('POST', '/api/ledgers', 'default', { name: '失败重试' })).status, 500);
      assert(!fs.existsSync(failedDir));
      assert.strictEqual(fs.readFileSync(path.join(failedBackups, 'existing-backup.zip'), 'utf8'), 'historical backup');
    } finally { storage.createStorage = originalCreateStorage; }
    for (const stage of ['snapshot', 'metadata']) {
      storage.createStorage = options => {
        const store = originalCreateStorage(options);
        if (stage === 'snapshot') {
          const write = store.writeSnapshot;
          store.writeSnapshot = (...args) => { write(...args); throw new Error('simulated failure after backup rotation'); };
        } else {
          const write = store.atomicWriteFile;
          store.atomicWriteFile = (file, ...args) => {
            if (path.basename(file) === 'ledger.json') throw new Error('simulated publication failure');
            return write(file, ...args);
          };
        }
        return store;
      };
      try {
        assert.strictEqual((await request('POST', '/api/ledgers', 'default', { name: '保护历史备份' })).status, 500);
        assert(!fs.existsSync(failedDir));
        assert.deepStrictEqual(fs.readdirSync(failedBackups).sort(), [...historyNames, 'existing-backup.zip'].sort(), 'failed creation must not add or rotate historical backups');
        historyNames.forEach(name => assert(historicBytes.equals(fs.readFileSync(path.join(failedBackups, name))), 'all historical snapshot bytes must survive failed initialization'));
      } finally { storage.createStorage = originalCreateStorage; }
    }
    const created = await request('POST', '/api/ledgers', 'default', { name: '第二本' });
    assert.strictEqual(created.status, 201);
    const second = created.body.data.id;
    assert.strictEqual(second, 'ledger-2');
    historyNames.forEach(name => assert(historicBytes.equals(fs.readFileSync(path.join(failedBackups, name))), 'publishing a new ledger must preserve historical backups'));
    assert(before.equals(fs.readFileSync(path.join(root, 'data/db.json'))));
    const configBeforeRename=fs.readFileSync(path.join(root,'data/config.json'));
    const dbBeforeRename=fs.readFileSync(path.join(root,'data',second,'db.json'));
    assert.strictEqual((await request('PATCH','/api/ledgers/'+second,undefined,{name:'个人投资'})).status,200);
    assert.strictEqual((await request('PATCH','/api/ledgers/default',undefined,{name:'家庭基金'})).status,200);
    assert.strictEqual((await request('GET','/api/ledgers')).body.data[0].name,'家庭基金');
    assert.strictEqual((await request('GET','/api/ledgers')).body.data[1].name,'个人投资');
    assert(configBeforeRename.equals(fs.readFileSync(path.join(root,'data/config.json'))));
    assert(dbBeforeRename.equals(fs.readFileSync(path.join(root,'data',second,'db.json'))));
    assert.strictEqual((await request('PATCH','/api/ledgers/ledger-999',undefined,{name:'missing'})).status,404);
    assert.strictEqual((await request('PATCH','/api/ledgers/default',undefined,{name:' '})).status,400);
    const third = (await request('POST', '/api/ledgers', second, { name: '第三本' })).body.data.id;
    assert.strictEqual(third, 'ledger-3');
    await Promise.all([
      request('POST', '/api/members', second, { name: 'Only second' }),
      request('POST', '/api/members', third, { name: 'Only third' })
    ]);
    for (const [id, expected] of [['default','Only default'], [second,'Only second'], [third,'Only third']]) {
      const members = (await request('GET', '/api/members', id)).body.data;
      assert(members.some(m => m.name === expected));
      assert.strictEqual(members.filter(m => m.name.startsWith('Only ')).length, 1);
    }
    assert.strictEqual((await request('GET','/api/state','../data')).status,404);
    assert.strictEqual((await request('POST','/api/members','ledger-999',{name:'wrong'})).status,404);
    assert.strictEqual((await request('GET','/api/state?ledger=ledger-3',second)).status,400);
    assert.strictEqual((await request('GET','/api/state?ledger=',undefined)).status,400);
    assert.strictEqual((await request('POST','/api/ledgers',undefined,{name:' '})).status,400);
    const tickers = [{ ticker: 'MSFT' }];
    assert.strictEqual((await request('POST','/api/settings/tickers',second,{tickers})).status,200);
    assert.deepStrictEqual((await request('GET','/api/settings/tickers','default')).body.data,
      (await request('GET','/api/settings/tickers',third)).body.data);
    await request('POST','/api/members',second,{name:'Backup config check'});
    const backupDir = path.join(root, 'backups', second);
    assert(!fs.existsSync(path.join(root, 'data', second, 'backups')), 'backups must stay outside ledger data');
    assert(fs.existsSync(path.join(root, 'backups', third)), 'each ledger needs its own backup directory');
    const newestBackup = fs.readdirSync(backupDir).filter(name=>name.endsWith('.zip')).sort().at(-1);
    const autoConfig = JSON.parse(new AdmZip(path.join(backupDir,newestBackup)).readAsText('data/config.json'));
    assert.deepStrictEqual(autoConfig.tickers,tickers,'automatic backups must use current shared settings');
    const baselineState = await request('GET','/api/state','default');
    assert.strictEqual((await request('POST','/api/settings',second,{cnhRate:8})).status,200);
    assert.strictEqual((await request('GET','/api/state','default')).body.data.summary.cnhRate,8);
    assert.strictEqual((await request('GET','/api/state',third)).body.data.summary.cnhRate,8);
    assert.strictEqual(baselineState.status,200);
    const secondMemberId = (await request('GET','/api/members',second)).body.data[0].id;
    assert.strictEqual((await request('POST','/api/transaction',second,{type:'deposit',member:secondMemberId,amount:1234,date:'2026-03-01'})).status,200);
    assert.strictEqual((await request('GET','/api/state',second)).body.data.summary.totalNAV,1234);
    assert.strictEqual((await request('GET','/api/state',third)).body.data.summary.totalNAV,0);
    assert.strictEqual((await request('GET','/api/state','default')).body.data.summary.totalNAV,0);
    assert.strictEqual((await request('POST','/api/valuation',second,{totalNAV:1500,date:'2026-03-03'})).status,200);
    assert.strictEqual((await request('PUT','/api/members/'+secondMemberId+'/roles',second,{gp:true})).status,200);
    const exported = await request('GET','/api/backup/export?ledger='+second,undefined,undefined,true);
    assert.strictEqual(exported.status,200);
    const zip = new AdmZip(exported.body);
    const snapshot = JSON.parse(zip.readAsText('data/db.json'));
    assert(snapshot.members.some(m => m.name === 'Only second'));
    assert(!snapshot.members.some(m => m.name === 'Only default'));
    assert.strictEqual((await request('POST','/api/backup/import',third,exported.body)).status,200);
    assert((await request('GET','/api/members',third)).body.data.some(m=>m.name==='Only second'));
    assert((await request('GET','/api/members','default')).body.data.some(m=>m.name==='Only default'));
    const preview = await request('POST','/api/performance-settlement/preview',second,{date:'2026-03-03'});
    assert.strictEqual(preview.status,200);
    assert.strictEqual((await request('POST','/api/performance-settlement',third,{date:'2026-03-03',previewToken:preview.body.data.previewToken})).status,409,'settlement approval cannot cross ledgers');
    assert.strictEqual((await request('POST','/api/performance-settlement',second,{date:'2026-03-03',previewToken:preview.body.data.previewToken})).status,200);
    assert.strictEqual((await request('GET','/api/state',third)).body.data.events.filter(e=>e.type==='performance_settlement').length,0);
    const originalRecords = JSON.parse(fs.readFileSync(path.join(root, 'data', second, 'settlements.json'))).records;
    const beforeRename = (await request('GET', '/api/state', second)).body.data;
    const member = (await request('GET', '/api/members', second)).body.data.find(m => m.id === secondMemberId);
    assert.strictEqual((await request('PUT', '/api/members/' + secondMemberId, second,
      { name: member.name, memberId: '__proto__' })).status, 400);
    const conflictingId = (await request('GET', '/api/members', third)).body.data.find(m => m.id !== secondMemberId).id;
    assert.strictEqual((await request('PUT', '/api/members/' + secondMemberId, second,
      { name: member.name, memberId: conflictingId })).status, 400);
    assert.strictEqual((await request('PUT', '/api/members/' + secondMemberId, second,
      { name: member.name, memberId: '654321' })).status, 200);
    const afterRename = (await request('GET', '/api/state', second)).body.data;
    assert.deepStrictEqual(afterRename.summary, beforeRename.summary);
    assert(afterRename.members['654321']);
    assert(!afterRename.members[secondMemberId]);
    assert.strictEqual(afterRename.events.find(e => e.type === 'performance_settlement').gpMember, '654321');
    const savedLedger = JSON.parse(fs.readFileSync(path.join(root, 'data', second, 'settlements.json')));
    assert.strictEqual(savedLedger.records.length, originalRecords.length, 'ID edits must preserve all independent settlement records');
    assert.deepStrictEqual(savedLedger.records.map(r => r.id), originalRecords.map(r => r.id));
    assert.strictEqual(savedLedger.records.find(e => e.type === 'performance_settlement').gpMember, '654321');
    assert.strictEqual((await request('GET', '/api/state', third)).status, 200);
    const thirdMember = (await request('GET', '/api/members', third)).body.data.find(m => m.id === secondMemberId);
    assert.strictEqual((await request('PUT', '/api/members/' + thirdMember.id, third, { name: thirdMember.name, memberId: '654321' })).status, 200, 'the same person may use the same ID across ledgers');


    const combined = await request('GET', '/api/ledgers/combined', second);
    assert.strictEqual(combined.status, 200);
    const ledgerList = (await request('GET', '/api/ledgers')).body.data;
    const states = await Promise.all(ledgerList.map(async ledger => ({ ...ledger,
      state: (await request('GET', '/api/state', ledger.id)).body.data })));
    assert.deepStrictEqual(combined.body.data, require('../lib/combined-overview').combineLedgers(states),
      'combined API must use the same snapshots as each dashboard, irrespective of selected ledger');
    assert.strictEqual(combined.body.data.members.find(member => member.id === '654321').breakdown.length, 2);
    assert.deepStrictEqual((await request('GET', '/api/ledgers/combined', 'default')).body.data, combined.body.data);

    // Unknown selections must never silently fall back to the default ledger.
    assert(before.equals(fs.readFileSync(path.join(root, 'data/db.json'))));
    console.log('Multi-ledger isolation, shared settings and backup tests passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    // Every path is under the unique temporary root created above.
    process.emit('exit', 0);
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
