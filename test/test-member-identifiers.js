const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateMemberId } = require('../lib/member-id');
const { migrateMemberIdentifiers, renameMemberIdentifiers } = require('../lib/member-identifiers');
const { calculateStateFromDb } = require('../lib/calculator');
const { mergeSettlementLedger, migrateSettlementLedger } = require('../lib/settlement-ledger');
const db = { benchmarkClosePolicy: 'previous', performanceFee: { gpMemberId: 'me', annualRate: .06, feeRate: .25 },
  members: [{ id: 'me', name: 'GP', roles: { lp: true, gp: true } }, { id: 'mother', name: 'LP', roles: { lp: true, gp: false } }],
  events: [{ id: 'mother', type: 'deposit', member: 'mother', amount: 1000, cnhAmount: 7000, date: '2025-01-01', sequenceNumber: 1, remark: 'mother' },
    { id: 'v', type: 'valuation', totalNAV: 1400, date: '2026-01-01', sequenceNumber: 2 }] };
const event = { id: 's', type: 'performance_settlement', date: '2026-01-01', sequenceNumber: 3,
  gpMember: 'me', lpMembers: ['me','mother'], annualRate: .06, feeRate: .25, algorithmVersion: 3 };
const state = calculateStateFromDb({ ...structuredClone(db), events: [...db.events, event] });
const computed = state.events.find(e => e.id === 's');
event.snapshot = { breakdown: computed._breakdown, totalFee: computed._totalFee, feeShares: computed._feeShares, navPerShare: computed._navAtTx };
const ledger = { version: 1, records: [event] };
const draws = ['123456', '234567'];
assert.strictEqual(generateMemberId(new Set(['123456']), () => draws.shift()), '234567', 'random collisions must retry');
const before = JSON.stringify([db, ledger]);
const result = migrateMemberIdentifiers(db, ledger);
assert.strictEqual(JSON.stringify([db,ledger]), before, 'migration must not mutate input');
assert.notStrictEqual(result.mapping.me, result.mapping.mother);
assert.strictEqual(result.db.events[0].member, result.mapping.mother);
assert.strictEqual(result.db.events[0].id, 'mother');
assert.strictEqual(result.db.events[0].remark, 'mother');
assert.strictEqual(result.ledger.records[0].gpMember, result.mapping.me);
assert.strictEqual(result.ledger.records[0].snapshot.breakdown.find(b => b.fee > 0).member, result.mapping.mother);
assert.strictEqual(migrateMemberIdentifiers(result.db,result.ledger).migrated, false);
const second = migrateMemberIdentifiers(db,ledger);
assert.notStrictEqual(second.mapping.mother, result.mapping.mother, 'same legacy ID in another ledger must be distinct');
const edited = renameMemberIdentifiers(result.db,result.ledger,{[result.mapping.mother]:'LP_002'});
assert.strictEqual(edited.db.members[1].id, 'LP_002');
assert.deepStrictEqual(calculateStateFromDb(mergeSettlementLedger(edited.db,edited.ledger)).summary,
  calculateStateFromDb(mergeSettlementLedger(db,ledger)).summary);
const broken = structuredClone(ledger); broken.records[0].snapshot.totalFee++;
assert.throws(() => migrateMemberIdentifiers(db,broken), /快照/);
// Older numeric-ID snapshots enumerated member keys in numeric order.
const numericDb = structuredClone(db);
numericDb.events.find(e => e.type === 'valuation').totalNAV = 2800;
numericDb.members.push({ id: 'father', name: 'LP2', roles: { lp: true, gp: false } });
numericDb.events.unshift({ id: 'd2', type: 'deposit', member: 'father', amount: 1000,
  cnhAmount: 7000, date: '2025-01-01', sequenceNumber: 0 });
const numericEvent = { ...event, lpMembers: ['me', 'mother', 'father'] };
const numericComputed = calculateStateFromDb({ ...structuredClone(numericDb),
  events: [...numericDb.events, numericEvent] }).events.find(e => e.id === 's');
numericEvent.snapshot = { breakdown: numericComputed._breakdown, totalFee: numericComputed._totalFee,
  feeShares: numericComputed._feeShares, navPerShare: numericComputed._navAtTx };
const numeric = renameMemberIdentifiers(numericDb, { version: 1, records: [numericEvent] },
  { me: '654321', mother: '345678', father: '123456' });
numeric.ledger.records[0].snapshot.breakdown.sort((a,b) => Number(a.member)-Number(b.member));
assert.doesNotThrow(() => migrateSettlementLedger(numeric.db, numeric.ledger));
const tampered = structuredClone(numeric.ledger);
tampered.records[0].snapshot.breakdown[0].fee += 1;
assert.throws(() => migrateSettlementLedger(numeric.db, tampered), /快照/);
const swapped = renameMemberIdentifiers(numeric.db, numeric.ledger, { '345678': '123456', '123456': '345678' });
assert.deepStrictEqual(swapped.db.members.map(m => m.id), ['654321','123456','345678']);
const root = fs.mkdtempSync(path.join(os.tmpdir(),'member-ids-'));
process.env.FUND_DATA_DIR = path.join(root,'default'); process.env.FUND_BACKUP_DIR = path.join(root,'backups');
const storage = require('../lib/storage');
const child = storage.createStorage({dataDir:path.join(root,'second')});
try {
  const firstIds = storage.readDb().members.map(m=>m.id);
  const secondIds = child.readDb().members.map(m=>m.id);
  assert([...firstIds, ...secondIds].every(id => /^[0-9]{6}$/.test(id)));
  assert(firstIds.every(id=>!secondIds.includes(id)), 'new ledgers must not reuse member IDs');
  const legacyDir = path.join(root, 'legacy');
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, 'db.json'), JSON.stringify({ events: [
    { id: 'old', type: 'deposit', member: 'me', amount: 100, cnhAmount: 700, date: '2025-01-01' }
  ] }));
  const legacy = storage.createStorage({ dataDir: legacyDir });
  try {
    const restored = legacy.readDb();
    assert.strictEqual(restored.members[0].id, 'me');
    assert.strictEqual(calculateStateFromDb(restored).summary.totalDeposit, 100);
  } finally { legacy.releaseDataDirectoryLock(); }
} finally { child.releaseDataDirectoryLock(); storage.releaseDataDirectoryLock(); fs.rmSync(root,{recursive:true,force:true}); }
console.log('Member identifier migration tests passed');
