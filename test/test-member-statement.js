const assert = require('assert');
const { calculateStateFromDb } = require('../lib/calculator');
const { mergeSettlementLedger } = require('../lib/settlement-ledger');
const { build, periods } = require('../public/js/member-statement');
const db = {
  members: [{ id: 'lp', name: '甲' }, { id: 'gp', name: '乙', roles: { lp: true, gp: true } }],
  events: [
    { id: 'd', type: 'deposit', member: 'lp', amount: 1000, date: '2025-01-04' },
    { id: 'v', type: 'valuation', totalNAV: 1200, date: '2025-12-30' },
    { id: 'v2', type: 'valuation', totalNAV: 1500, date: '2026-02-06' },
    { id: 't', type: 'transfer', fromMember: 'lp', toMember: 'gp', amount: 150, date: '2026-02-08' },
    { id: 'w', type: 'withdraw', member: 'lp', amount: 100, date: '2026-02-15', disposalVersion: 2,
      performanceFee: { gpMember: 'gp', annualRate: 0, feeRate: 0.2 } },
    { id: 'later', type: 'deposit', member: 'lp', amount: 75, date: '2026-03-01' }
  ]
};
const first = { id: 's1', type: 'performance_settlement', date: '2026-01-01', gpMember: 'gp', lpMembers: ['lp', 'gp'], annualRate: 0, feeRate: 0.2, algorithmVersion: 3 };
const second = { ...first, id: 's2', date: '2026-02-28' };
const state = calculateStateFromDb(mergeSettlementLedger(db, { records: [first, second] }));
const asOf = '2026-03-05';
assert.deepEqual(periods(state, asOf).map(item => item.id), ['since-last-settlement', 's2', 's1']);
assert.deepEqual(periods(state, '2026-01-01').map(item => item.id), ['since-last-settlement', 's1']);
assert.deepEqual(periods(calculateStateFromDb(db), asOf), []);
const opening = build(state, 'lp', 's1', asOf);
const closed = build(state, 'lp', 's2', asOf);
const current = build(state, 'lp', 'since-last-settlement', asOf);
assert.equal(opening.start, '2025-01-04');
assert.equal(opening.end, '2026-01-01');
assert.equal(opening.opening, 0);
assert.equal(opening.deposits, 1000);
assert(opening.feesPaid > 0);
assert.equal(opening.openingNAV, 1);
assert.equal(opening.closingNAV, 1.2);
assert.equal(closed.opening, opening.closing);
assert.equal(closed.openingNAV, opening.closingNAV);
assert.equal(closed.end, '2026-02-28');
assert.equal(closed.transfersOut, 150);
assert.equal(closed.withdrawals, 100);
assert.equal(closed.navReturn, 25);
assert.equal(current.opening, closed.closing);
assert.equal(current.deposits, 75);
assert.equal(current.feesPaid, 0);
assert.equal(current.ongoing, true);
assert.equal(current.navReturn, 0);
assert.equal(current.end, asOf);
for (const member of ['lp', 'gp']) {
  for (const id of ['s1', 's2', 'since-last-settlement']) {
    const report = build(state, member, id, asOf);
    const movements = report.rows.reduce((sum, row) => sum + row.amount, 0);
    assert(Math.abs(report.opening + movements + report.investmentProfit - report.closing) < 1e-8);
    for (const key of ['deposits', 'withdrawals', 'transfersIn', 'transfersOut', 'feesPaid', 'feesReceived', 'investmentProfit', 'change']) {
      assert(Math.abs(report[key] - report.months.reduce((sum, month) => sum + month[key], 0)) < 1e-8, key);
    }
    assert(report.rows.filter(row => /^(向 |出金)/.test(row.label)).every(row => row.amount <= 0));
    assert(report.rows.filter(row => /^(由 |入金)/.test(row.label)).every(row => row.amount >= 0));
  }
}
const reversed = calculateStateFromDb(mergeSettlementLedger(db, { records: [first, second, { id: 'r', type: 'performance_settlement_reversal', settlementId: 's2', date: '2026-03-01' }] }));
assert.deepEqual(periods(reversed, asOf).map(item => item.id), ['since-last-settlement', 's1']);
assert.throws(() => build(reversed, 'lp', 's2', asOf));
assert.equal(build(reversed, 'lp', 'since-last-settlement', asOf).opening, opening.closing);
assert.throws(() => build(state, 'lp', '2026', asOf));
assert.throws(() => build(state, 'missing', 's1', asOf));

// A later entrant cannot select completed periods before their participation.
const laterDb = JSON.parse(JSON.stringify(db));
laterDb.members.push({ id: 'late', name: '丙' }, { id: 'empty', name: '丁' });
laterDb.events.push({ id: 'late-deposit', type: 'deposit', member: 'late', amount: 200, date: '2026-03-02' });
const laterState = calculateStateFromDb(mergeSettlementLedger(laterDb, { records: [first, second] }));
assert.deepEqual(periods(laterState, asOf, 'late').map(item => item.id), ['since-last-settlement']);
assert.deepEqual(periods(laterState, asOf, 'empty'), []);
assert.throws(() => build(laterState, 'late', 's2', asOf));
assert.deepEqual(periods(laterState, asOf, 'gp').map(item => item.id), ['since-last-settlement', 's2', 's1']);

// A member who deposited and fully exited within a period still has a report.
const exitedDb = JSON.parse(JSON.stringify(laterDb));
exitedDb.events.push({ id: 'late-exit', type: 'withdraw', member: 'late', amount: 200, date: '2026-03-03' });
const exitedState = calculateStateFromDb(mergeSettlementLedger(exitedDb, { records: [first, second] }));
assert.equal(build(exitedState, 'late', 'since-last-settlement', asOf).closingShares, 0);
assert.deepEqual(periods(exitedState, asOf, 'late').map(item => item.id), ['since-last-settlement']);

// Same-day events after the settlement belong to the next period.
const sameDayDb = JSON.parse(JSON.stringify(db));
sameDayDb.events.at(-1).date = '2026-02-28';
sameDayDb.events.at(-1).sequenceNumber = 999;
const sameDay = calculateStateFromDb(mergeSettlementLedger(sameDayDb, { records: [{ ...first, sequenceNumber: 100 }, { ...second, sequenceNumber: 101 }] }));
assert.equal(build(sameDay, 'lp', 's2', asOf).deposits, 0);
assert.equal(build(sameDay, 'lp', 'since-last-settlement', asOf).deposits, 75);
assert.equal(build(sameDay, 'lp', 'since-last-settlement', '2026-02-28').opening, build(sameDay, 'lp', 's2', asOf).closing);

// Display-rounded chart NAVs must not erase a small gain or become a zero
// denominator when the actual positive NAV is below four decimal places.
for (const [initialValue, finalValue] of [[100005, 100014.9], [4, 6]]) {
  const preciseState = calculateStateFromDb({
    members: db.members,
    events: [
      { id: 'pd', type: 'deposit', member: 'lp', amount: 100000, date: '2025-01-01' },
      { id: 'pv1', type: 'valuation', totalNAV: initialValue, date: '2025-01-02' },
      { ...first, id: 'ps1', date: '2025-01-03', feeRate: 0 },
      { id: 'pv2', type: 'valuation', totalNAV: finalValue, date: '2025-02-02' },
      { ...first, id: 'ps2', date: '2025-02-03', feeRate: 0 }
    ]
  });
  const preciseReport = build(preciseState, 'lp', 'ps2', '2025-02-04');
  assert(Math.abs(preciseReport.navReturn - (finalValue / initialValue - 1) * 100) < 1e-8);
  assert.equal(preciseReport.openingNAV, initialValue / 100000);
  assert.equal(preciseReport.closingNAV, finalValue / 100000);
  assert(Math.abs(preciseReport.months.at(-1).navReturn - preciseReport.navReturn) < 1e-8);
}
console.log('Settlement-period selection, NAV, signs, monthly reconciliation, reversals and same-day boundaries passed.');
