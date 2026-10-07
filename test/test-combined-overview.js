const assert = require('assert');
const { calculateStateFromDb } = require('../lib/calculator');
const { combineLedgers } = require('../lib/combined-overview');

function ledger(id, deposit, value, withdraw = 0, name = '卜梵') {
  return { id, name: id, state: calculateStateFromDb({ cnhRate: 7.2, indexCache: {},
    members: [{ id: '679582', name }, { id: id + '-other', name: '同名成员' }], events: [
      { id: 'd', type: 'deposit', member: '679582', amount: deposit, cnhAmount: deposit * 7, date: '2026-01-01', createdAt: 1 },
      { id: 'v', type: 'valuation', totalNAV: value, date: '2026-01-02', createdAt: 2 },
      ...(withdraw ? [{ id: 'w', type: 'withdraw', member: '679582', amount: withdraw, cnhAmount: withdraw * 7.1, date: '2026-01-03', createdAt: 3 }] : [])
    ] }) };
}
const entries = [ledger('default', 1000, 1200, 120), ledger('ledger-2', 3000, 3300, 0, '卜梵别名')];
const result = combineLedgers(entries);
assert.strictEqual(result.summary.totalNAV, 4380);
assert.strictEqual(result.summary.profit, 500);
assert.strictEqual(result.summary.profitRate, 12.5, 'recompute from cash flows rather than averaging rates');
assert.strictEqual(result.summary.remainingPrincipal, 3900);
assert.strictEqual(result.summary.activeProfit, 480);
assert.strictEqual(result.summary.activeProfitRate, 12.31);
assert.strictEqual(result.members.length, 3, 'same ID merges; same name with different IDs stays separate');
const member = result.members.find(item => item.id === '679582');
assert.deepStrictEqual(member.names, ['卜梵', '卜梵别名']);
assert.strictEqual(member.breakdown.length, 2);
assert.strictEqual(member.currentValue, 4380);
assert.strictEqual(member.profitRate, 12.5);
assert.strictEqual(member.cnhProfitRate, Number((member.cnhProfit / member.cnhDeposit * 100).toFixed(2)));
assert(!('shares' in member));
assert(!('navPerShare' in result.summary));
const single = combineLedgers([entries[0]]);
for (const key of ['totalNAV', 'remainingPrincipal', 'activeProfit', 'profit', 'cnhTotalNAV', 'cnhProfit', 'activeProfitRate']) {
  assert.strictEqual(single.summary[key], entries[0].state.summary[key], `single-ledger parity: ${key}`);
}
const empty = combineLedgers([]);
assert.strictEqual(empty.summary.activeProfitRate, null);
assert.strictEqual(empty.summary.profitRate, null);
assert.strictEqual(result.members.find(item => item.id === 'default-other').profitRate, 0);
// Decimal summation must not accumulate binary floating-point noise.
assert.strictEqual(combineLedgers([ledger('a', .1, .1), ledger('b', .2, .2)]).summary.totalNAV, .3);
const tiny = ledger('tiny', .03, .031);
const tinyCombined = combineLedgers([tiny]);
assert.strictEqual(tinyCombined.summary.activeProfitRate, tiny.state.summary.activeProfitRate);
assert.strictEqual(tinyCombined.members.find(item => item.id === '679582').profitRate, tiny.state.members['679582'].profitRate,
  'a member in one ledger retains the original pre-rounding return');
const orderingEntries = [
  { id: 'default', name: 'A', state: { summary: {}, members: {
    '100001': { name: '未有记录' }, '100002': { name: '后记录' }, '100003': { name: '跨账本成员' }
  }, events: [
    { type: 'deposit', member: '100002', date: '2026-02-01' },
    { type: 'deposit', member: '100003', date: '2026-03-01' }
  ] } },
  { id: 'ledger-2', name: 'B', state: { summary: {}, members: {
    '100003': { name: '跨账本成员' }, '100004': { name: '转让接收者' }, '100005': { name: 'GP' }
  }, events: [
    { type: 'deposit', member: '100003', date: '2026-01-01' },
    { type: 'transfer', fromMember: '100003', toMember: '100004', date: '2026-01-02' },
    { type: 'performance_settlement', gpMember: '100005', lpMembers: ['100003'], date: '2026-01-02' }
  ] } }
];
assert.deepStrictEqual(combineLedgers(orderingEntries).members.map(member => member.id),
  ['100003', '100004', '100005', '100002', '100001'],
  'sort by first record across ledgers, respect same-day event order and keep unrecorded members last');
console.log('Combined overview identity, USD/CNH cash-flow return and dashboard parity tests passed.');
