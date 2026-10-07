const assert = require('assert');
const { makeApi, request, clone } = require('./helpers/api-harness');
const { calculateStateFromDb } = require('../lib/calculator');
(async () => {
  const original = {
    members: [{ id: '123456', name: 'A' }, { id: '234567', name: 'B' }],
    performanceFee: { gpMemberId: '234567', annualRate: .06, feeRate: .25 },
    events: [{ id: 'd', type: 'deposit', member: '123456', amount: 100,
      cnhAmount: 700, date: '2025-01-01' }]
  };
  let db = clone(original), ledger = { version: 1, records: [] }, writes = 0, fail = false;
  const api = makeApi(undefined, db, {
    readBaseDb: () => clone(db), readDb: () => clone(db), readSettlements: () => clone(ledger),
    normalizeMemberName: value => { if (typeof value !== 'string' || !value.trim()) throw new Error('姓名无效'); return value.trim(); },
    writeSnapshot: (next, config, settlements) => {
      if (fail) throw new Error('disk unavailable');
      db = clone(next); ledger = clone(settlements); writes++;
    }
  });
  const save = changes => request(api.routes['put:/api/members'], { changes });
  const edits = [{ id: '123456', name: 'A2', memberId: '345678' },
    { id: '234567', name: 'B2', memberId: 'bad' }];
  assert.strictEqual((await save(edits)).body.success, false);
  assert.deepStrictEqual(db, original); assert.strictEqual(writes, 0);
  edits[1].memberId = '456789'; fail = true;
  assert.strictEqual((await save(edits)).body.success, false);
  assert.deepStrictEqual(db, original); assert.strictEqual(writes, 0);
  fail = false; assert.strictEqual((await save(edits)).body.success, true);
  assert.strictEqual(writes, 1); assert.strictEqual(db.events[0].member, '345678');
  assert.strictEqual(db.performanceFee.gpMemberId, '456789');
  assert.deepStrictEqual(calculateStateFromDb(db).summary, calculateStateFromDb(original).summary);
  assert.strictEqual((await save([
    { id: '345678', name: 'B2', memberId: '456789' },
    { id: '456789', name: 'A2', memberId: '345678' }
  ])).body.success, true, 'names and IDs can swap in a single atomic update');
  const before = clone(db);
  assert.strictEqual((await save([
    { id: '456789', name: 'A3', memberId: '567890' },
    { id: '345678', name: 'A3', memberId: '678901' }
  ])).body.success, false);
  assert.deepStrictEqual(db, before);
  const fs = require('fs'), path = require('path'), os = require('os');
  const { spawnSync } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-script-'));
  try {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(path.join(dataDir, 'ledger-2'), { recursive: true });
    const legacy = { members: [{ id: 'me', name: 'A' }], events: [],
      performanceFee: { gpMemberId: 'me', annualRate: .06, feeRate: .25 } };
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(legacy));
    fs.writeFileSync(path.join(dataDir, 'ledger-2', 'ledger.json'), '{}');
    fs.writeFileSync(path.join(dataDir, 'ledger-2', 'db.json'), JSON.stringify({ ...legacy,
      members: [{ id: '123456', name: 'Other' }, { id: 'mother', name: 'B' }],
      performanceFee: { ...legacy.performanceFee, gpMemberId: '123456' } }));
    const preload = path.join(root, 'draw.js');
    fs.writeFileSync(preload, "const draws=[123456,234567,345678]; require('crypto').randomInt=()=>draws.shift();");
    const run = spawnSync(process.execPath, ['-r', preload, path.join(__dirname, '../scripts/migrate-member-identifiers.js')], {
      env: { ...process.env, FUND_DATA_DIR: dataDir, FUND_BACKUP_DIR: path.join(root, 'backups') }, encoding: 'utf8'
    });
    assert.strictEqual(run.status, 0, run.stderr);
    const a = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json')));
    const b = JSON.parse(fs.readFileSync(path.join(dataDir, 'ledger-2', 'db.json')));
    assert.strictEqual(a.members[0].id, '234567');
    assert.deepStrictEqual(b.members.map(m => m.id), ['123456','345678']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('Atomic member updates and failure retry regressions passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
