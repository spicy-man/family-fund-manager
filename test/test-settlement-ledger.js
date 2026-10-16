const assert = require('assert');
const { calculateStateFromDb } = require('../lib/calculator');
const {
  mergeSettlementLedger,
  migrateSettlementLedger
} = require('../lib/settlement-ledger');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseDb() {
  return {
    cnhRate: 7.2,
    members: [
      { id: 'lp', name: 'LP', roles: { lp: true, gp: false } },
      { id: 'gp', name: 'GP', roles: { lp: false, gp: true } }
    ],
    indexCache: {},
    events: [
      { id: 'd1', type: 'deposit', member: 'lp', amount: 100, cnhAmount: 720, date: '2025-01-01', createdAt: 1 },
      { id: 'v1', type: 'valuation', totalNAV: 120, date: '2025-06-01', createdAt: 2 },
      { id: 'd2', type: 'deposit', member: 'lp', amount: 100, cnhAmount: 720, date: '2025-06-01', createdAt: 3 },
      { id: 'v2', type: 'valuation', totalNAV: 220, date: '2026-01-01', createdAt: 4 }
    ]
  };
}

function settlement(version, id = `s${version}`) {
  return {
    id,
    type: 'performance_settlement',
    date: '2026-01-01',
    createdAt: 5,
    gpMember: 'gp',
    lpMembers: ['lp'],
    algorithmVersion: version,
    annualRate: 0.06,
    feeRate: 0.25,
    remark: 'fixture'
  };
}

function withSnapshot(db, record) {
  const state = calculateStateFromDb({ ...clone(db), events: [...clone(db.events), clone(record)] });
  const computed = state.events.find(event => event.id === record.id);
  return {
    ...record,
    snapshot: {
      breakdown: computed._breakdown,
      totalFee: computed._totalFee,
      feeShares: computed._feeShares,
      navPerShare: computed._navAtTx
    }
  };
}

for (const version of [1, 2]) {
  const db = baseDb();
  const saved = withSnapshot(db, settlement(version));
  const unversioned = clone(saved);
  delete unversioned.algorithmVersion;
  const migrated = migrateSettlementLedger(db, { version: 1, records: [unversioned] });
  assert.strictEqual(migrated.migratedCount, 1);
  assert.strictEqual(migrated.ledger.records[0].algorithmVersion, version);
}

// A legacy full disposal leaves a zero-share audit lot. A later deposit and
// v1 settlement must still match its snapshot after a JSON save/load cycle.
const exhaustedDb = baseDb();
exhaustedDb.events = [
  { id: 'old-d', type: 'deposit', member: 'lp', amount: 100, date: '2025-01-01', createdAt: 1 },
  { id: 'old-w', type: 'withdraw', member: 'lp', amount: 100, date: '2025-01-02', createdAt: 2,
    performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 1 } },
  { id: 'new-d', type: 'deposit', member: 'lp', amount: 200, date: '2025-01-03', createdAt: 3 }
];
const exhaustedRecord = withSnapshot(exhaustedDb, settlement(1, 'after-exhausted-lot'));
assert.strictEqual(exhaustedRecord.snapshot.breakdown[0].lots[0].entryNav, null);
const exhaustedLedger = { version: 1, records: [clone(exhaustedRecord)] };
assert.doesNotThrow(() => migrateSettlementLedger(exhaustedDb, exhaustedLedger));
const exhaustedMetrics = {};
calculateStateFromDb(exhaustedDb, { metrics: exhaustedMetrics });
assert.strictEqual(exhaustedMetrics.finalActiveLotCount, 1, 'exhausted audit lots are not active lots');

const currentDb = baseDb();
const currentSettlement = withSnapshot(currentDb, settlement(3, 'period-high-water'));
const currentMigration = migrateSettlementLedger(currentDb, {
  version: 1,
  records: [currentSettlement]
});
assert.strictEqual(currentMigration.migrated, false);
assert.strictEqual(currentMigration.ledger.records[0].algorithmVersion, 3);
assert.throws(
  () => migrateSettlementLedger(currentDb, {
    version: 1,
    records: [currentSettlement],
    lastEventSequence: Number.NaN
  }),
  /事件顺序号高水位/
);

const versionComparisonDb = baseDb();
const v1 = withSnapshot(versionComparisonDb, settlement(1, 'legacy'));
const v2 = withSnapshot(versionComparisonDb, settlement(2, 'current'));
assert.notStrictEqual(v1.snapshot.totalFee, v2.snapshot.totalFee, 'fixture must distinguish aggregate and independent-lot fees');

const tampered = clone(v2);
tampered.snapshot.totalFee += 1;
assert.throws(
  () => migrateSettlementLedger(versionComparisonDb, { version: 1, records: [tampered] }),
  /锁定快照与历史算法重放结果不一致/
);

const unsupported = clone(v2);
unsupported.algorithmVersion = 999;
assert.throws(
  () => migrateSettlementLedger(versionComparisonDb, { version: 1, records: [unsupported] }),
  /不支持的算法版本/
);

// Reversing a settlement unlocks its historical period. Later edits can make
// the old snapshot impossible to reproduce, but its immutable snapshot shape
// still identifies v1 and the reversed record must never affect balances.
const reversedLegacy = clone(v1);
delete reversedLegacy.algorithmVersion;
const reversal = {
  id: 'r1', type: 'performance_settlement_reversal', settlementId: reversedLegacy.id,
  settlementDate: reversedLegacy.date, date: '2026-02-01', createdAt: 6
};
const editedDb = baseDb();
editedDb.events[0].amount = 90;
editedDb.events[0].cnhAmount = 648;
const reversedMigration = migrateSettlementLedger(editedDb, {
  version: 1,
  records: [reversedLegacy, reversal]
});
assert.strictEqual(reversedMigration.ledger.records[0].algorithmVersion, 1);
const merged = mergeSettlementLedger(editedDb, reversedMigration.ledger);
assert(!merged.events.some(event => event.id === reversedLegacy.id));
assert(merged.events.some(event => event.id === reversal.id));

console.log('Settlement algorithm version migration and snapshot validation assertions passed.');
