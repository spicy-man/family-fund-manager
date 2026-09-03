const assert = require('assert');
const { calculateStateFromDb } = require('../server');
const { CURRENT_SETTLEMENT_VERSION } = require('../lib/performance-settlement');

function event(id, type, date, createdAt, extra = {}) {
  return {
    id, type, date, createdAt,
    ...(type === 'performance_settlement' ? { algorithmVersion: 2 } : {}),
    ...extra
  };
}

function approximately(actual, expected, tolerance = 1e-9) {
  assert(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

const base = {
  cnhRate: 7.2,
  members: [
    { id: 'lp', name: 'LP' },
    { id: 'gp', name: 'GP' }
  ],
  indexCache: {},
  events: [
    event('d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('v1', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('s1', 'performance_settlement', '2026-01-01', 3, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
};

const state = calculateStateFromDb(base);
const settlement = state.events.find(item => item.id === 's1');
assert.strictEqual(settlement._totalFee, 3.5);
assert.strictEqual(settlement._breakdown[0].hurdle, 106);
assert.strictEqual(settlement._breakdown[0].excess, 14);
assert.strictEqual(settlement._breakdown[0].lots.length, 1);
assert.strictEqual(settlement._breakdown[0].lots[0].basis, 100);
assert.strictEqual(settlement._breakdown[0].lots[0].entryNav, 1);
assert.strictEqual(settlement._breakdown[0].lots[0].holdingDays, 365);
assert.strictEqual(settlement._breakdown[0].lots[0].currentValue, 120);

const unversionedBase = JSON.parse(JSON.stringify(base));
delete unversionedBase.events.find(item => item.type === 'performance_settlement').algorithmVersion;
assert.throws(
  () => calculateStateFromDb(unversionedBase),
  /缺少算法版本/
);
assert.strictEqual(settlement._breakdown[0].lots[0].hurdle, 106);
assert.strictEqual(state.summary.totalNAV, 120, 'share fee must not remove fund assets');
assert.strictEqual(state.members.lp.currentValue, 116.5);
assert.strictEqual(state.members.gp.currentValue, 3.5);

const dualRoleState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'both', name: 'Both', roles: { lp: true, gp: true } }],
  indexCache: {},
  events: [
    event('dual-deposit', 'deposit', '2025-01-01', 1, { member: 'both', amount: 100, cnhAmount: 720 }),
    event('dual-value', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('dual-settle', 'performance_settlement', '2026-01-01', 3, { gpMember: 'both', annualRate: 0.06, feeRate: 0.25 })
  ]
});
assert.strictEqual(dualRoleState.members.both.currentValue, 120);
assert.strictEqual(dualRoleState.members.both.lpCurrentValue, 116.5);
assert.strictEqual(dualRoleState.members.both.gpCarryValue, 3.5);

// A loss-only crystallization must not reset the high-water basis. Recovering
// merely to the old hurdle therefore cannot create a second fee.
const lossState = calculateStateFromDb({
  ...base,
  events: [
    event('d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('loss', 'valuation', '2026-01-01', 2, { totalNAV: 80 }),
    event('no-fee', 'performance_settlement', '2026-01-01', 3, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 }),
    event('recover', 'valuation', '2026-06-01', 4, { totalNAV: 105 }),
    event('still-no-fee', 'performance_settlement', '2026-06-01', 5, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
});
assert.strictEqual(lossState.events.find(item => item.id === 'no-fee')._totalFee, 0);
assert.strictEqual(lossState.events.find(item => item.id === 'still-no-fee')._totalFee, 0);

// A flat 6% cumulative gain after two years is far below a 6% annualized,
// daily-compounded hurdle. It must not become fee-eligible in year three.
const multiYearHurdleState = calculateStateFromDb({
  ...base,
  events: [
    event('multi-d', 'deposit', '2024-01-02', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('multi-v2', 'valuation', '2026-01-01', 2, { totalNAV: 106 }),
    event('multi-s2', 'performance_settlement', '2026-01-01', 3, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 }),
    event('multi-v3', 'valuation', '2027-01-01', 4, { totalNAV: 106 }),
    event('multi-s3', 'performance_settlement', '2027-01-01', 5, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
});
assert.strictEqual(multiYearHurdleState.events.find(item => item.id === 'multi-s2')._totalFee, 0);
assert.strictEqual(multiYearHurdleState.events.find(item => item.id === 'multi-s3')._totalFee, 0);
assert.strictEqual(multiYearHurdleState.members.lp.lpLedger[0].startDate, '2024-01-02', 'no-fee years must not reset the original hurdle date');

// Current settlements close the measurement period even when no fee is due.
// A 3% first period therefore pays no fee, then a 24% second-period return is
// compared only with that second period's 6% hurdle.
const periodResetState = calculateStateFromDb({
  ...base,
  events: [
    event('period-d', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('period-v1', 'valuation', '2026-01-01', 2, { totalNAV: 103 }),
    event('period-s1', 'performance_settlement', '2026-01-01', 3, {
      algorithmVersion: CURRENT_SETTLEMENT_VERSION,
      gpMember: 'gp', annualRate: 0.06, feeRate: 0.25
    }),
    event('period-v2', 'valuation', '2027-01-01', 4, { totalNAV: 127.72 }),
    event('period-s2', 'performance_settlement', '2027-01-01', 5, {
      algorithmVersion: CURRENT_SETTLEMENT_VERSION,
      gpMember: 'gp', annualRate: 0.06, feeRate: 0.25
    })
  ]
});
const firstPeriod = periodResetState.events.find(item => item.id === 'period-s1');
const secondPeriod = periodResetState.events.find(item => item.id === 'period-s2');
assert.strictEqual(firstPeriod._totalFee, 0);
assert.strictEqual(secondPeriod._breakdown[0].lots[0].startDate, '2026-01-01');
assert.strictEqual(secondPeriod._breakdown[0].lots[0].basis, 103);
assert.strictEqual(secondPeriod._breakdown[0].hurdle, 109.18);
assert.strictEqual(secondPeriod._breakdown[0].excess, 18.54);
assert.strictEqual(secondPeriod._totalFee, 4.64);
assert.strictEqual(periodResetState.members.lp.lpLedger[0].startDate, '2027-01-01');

// Restarting the annual clock must never lower the high-water basis. After a
// 10% loss and a 3% recovery, the third year's 40% gain is still charged only
// above the original 1.00 high-water mark grown by that year's 6% hurdle.
const highWaterState = calculateStateFromDb({
  ...base,
  events: [
    event('hwm-d', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('hwm-v1', 'valuation', '2026-01-01', 2, { totalNAV: 90 }),
    event('hwm-s1', 'performance_settlement', '2026-01-01', 3, {
      algorithmVersion: CURRENT_SETTLEMENT_VERSION,
      gpMember: 'gp', annualRate: 0.06, feeRate: 0.25
    }),
    event('hwm-v2', 'valuation', '2027-01-01', 4, { totalNAV: 92.7 }),
    event('hwm-s2', 'performance_settlement', '2027-01-01', 5, {
      algorithmVersion: CURRENT_SETTLEMENT_VERSION,
      gpMember: 'gp', annualRate: 0.06, feeRate: 0.25
    }),
    event('hwm-v3', 'valuation', '2028-01-01', 6, { totalNAV: 129.78 }),
    event('hwm-s3', 'performance_settlement', '2028-01-01', 7, {
      algorithmVersion: CURRENT_SETTLEMENT_VERSION,
      gpMember: 'gp', annualRate: 0.06, feeRate: 0.25
    })
  ]
});
const highWaterYearOne = highWaterState.events.find(item => item.id === 'hwm-s1');
const highWaterYearTwo = highWaterState.events.find(item => item.id === 'hwm-s2');
const highWaterYearThree = highWaterState.events.find(item => item.id === 'hwm-s3');
assert.strictEqual(highWaterYearOne._totalFee, 0);
assert.strictEqual(highWaterYearTwo._totalFee, 0);
assert.strictEqual(highWaterYearTwo._breakdown[0].lots[0].startDate, '2026-01-01');
assert.strictEqual(highWaterYearTwo._breakdown[0].lots[0].basis, 100);
assert.strictEqual(highWaterYearThree._breakdown[0].lots[0].startDate, '2027-01-01');
assert.strictEqual(highWaterYearThree._breakdown[0].lots[0].basis, 100);
assert.strictEqual(highWaterYearThree._breakdown[0].hurdle, 106);
assert.strictEqual(highWaterYearThree._breakdown[0].excess, 23.78);
assert.strictEqual(highWaterYearThree._totalFee, 5.95);
assert.strictEqual(highWaterState.members.lp.lpLedger[0].basis, 123.84);
assert.strictEqual(highWaterState.members.lp.lpLedger[0].highWaterNav, 1.2978,
  'carry transfers shares without changing the settlement-date NAV used as the new high-water mark');

// Lots can merge after settlement when every lot closes at the current
// high-water NAV, even when only some earned a fee in the closing period.
const periodMergeState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('period-merge-d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('period-merge-v1', 'valuation', '2025-07-01', 2, { totalNAV: 120 }),
    event('period-merge-d2', 'deposit', '2025-07-01', 3, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('period-merge-v2', 'valuation', '2026-01-01', 4, { totalNAV: 220 }),
    event('period-merge-s', 'performance_settlement', '2026-01-01', 5, {
      algorithmVersion: CURRENT_SETTLEMENT_VERSION,
      gpMember: 'gp', annualRate: 0.06, feeRate: 0.25
    })
  ]
});
const periodMergeSettlement = periodMergeState.events.find(item => item.id === 'period-merge-s');
assert.strictEqual(periodMergeSettlement._breakdown[0].lots[0].fee, 3.5);
assert.strictEqual(periodMergeSettlement._breakdown[0].lots[1].fee, 0);
assert.strictEqual(periodMergeState.members.lp.lpLedger.length, 1);
assert.strictEqual(periodMergeState.members.lp.lpLedger[0].startDate, '2026-01-01');

// A transfer is a new LP acquisition for the recipient at transfer-date NAV;
// the sender's old lots are reduced but never copied into the recipient ledger.
const transferState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('d', 'deposit', '2025-01-01', 1, { member: 'a', amount: 100, cnhAmount: 720 }),
    event('mid', 'valuation', '2025-07-01', 2, { totalNAV: 110 }),
    event('t', 'transfer', '2025-07-01', 3, { fromMember: 'a', toMember: 'b', amount: 55, cnhRate: 7.2 }),
    event('end', 'valuation', '2026-01-01', 4, { totalNAV: 120 }),
    event('settle', 'performance_settlement', '2026-01-01', 5, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
});
const transferSettlement = transferState.events.find(item => item.id === 'settle');
const recipient = transferSettlement._breakdown.find(item => item.member === 'b');
assert.strictEqual(recipient.lots.length, 1);
assert.strictEqual(recipient.lots[0].startDate, '2025-07-01');
assert.strictEqual(recipient.lots[0].basis, 55);
assert.strictEqual(recipient.lots[0].entryNav, 1.1);
assert(transferSettlement._totalFee < 3.5, 'later transfer-date hurdle should reduce the fee');

const crystallizedTransfer = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'seller', name: 'Seller' }, { id: 'buyer', name: 'Buyer' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('capital', 'deposit', '2025-01-01', 1, { member: 'seller', amount: 100, cnhAmount: 720 }),
    event('mark', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('sale', 'transfer', '2026-01-01', 3, {
      fromMember: 'seller', toMember: 'buyer', amount: 60, cnhRate: 7.2,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    })
  ]
});
const sale = crystallizedTransfer.events.find(item => item.id === 'sale');
assert.strictEqual(sale._actualAmount, 60, 'recipient receives the full entered transfer amount');
approximately(sale._performanceFee, 3.5 * (60 / 116.5));
approximately(sale._disposedRatio, 60 / 116.5);
assert.strictEqual(sale._disposedLots.length, 1);
approximately(sale._disposedLots[0].shares, 100 * (60 / 116.5));
assert.strictEqual(sale._disposedLots[0].cashShares, 50);
approximately(sale._disposedLots[0].feeShares, sale._performanceFee / 1.2);
assert.strictEqual(sale._disposedLots[0].cashValue, 60);
assert.strictEqual(sale._disposedLots[0].fee, 1.8);
assert.strictEqual(crystallizedTransfer.members.buyer.lpCurrentValue, 60);
assert.strictEqual(crystallizedTransfer.members.buyer.lpLedger[0].basis, 60);
assert.strictEqual(crystallizedTransfer.members.buyer.lpLedger[0].startDate, '2026-01-01');
assert.strictEqual(crystallizedTransfer.members.gp.gpCarryValue, 1.8);

// Every contribution lot is an independent fee account: a losing later lot
// must not offset an earlier lot that cleared its own hurdle.
const offsetState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('offset-d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('offset-v1', 'valuation', '2025-07-01', 2, { totalNAV: 120 }),
    event('offset-d2', 'deposit', '2025-07-01', 3, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('offset-v2', 'valuation', '2026-01-01', 4, { totalNAV: 220 }),
    event('offset-s', 'performance_settlement', '2026-01-01', 5, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
});
const offsetSettlement = offsetState.events.find(item => item.id === 'offset-s');
const offsetBreakdown = offsetSettlement._breakdown.find(item => item.member === 'lp');
assert.strictEqual(offsetBreakdown.lots.length, 2);
assert.strictEqual(offsetSettlement._totalFee, 3.5, 'each profitable lot must be charged without cross-lot loss offset');
assert.strictEqual(offsetBreakdown.excess, 14);
assert.strictEqual(offsetBreakdown.lots[0].fee, 3.5);
assert.strictEqual(offsetBreakdown.lots[1].fee, 0);
assert.strictEqual(offsetState.members.lp.lpLedger.length, 2, 'settlement must preserve independent lot accounting');
assert.strictEqual(offsetState.members.lp.lpLedger[0].startDate, '2026-01-01', 'profitable lot resets after crystallization');
assert.strictEqual(offsetState.members.lp.lpLedger[1].startDate, '2025-07-01', 'losing lot retains its original hurdle history');

// Once every live lot independently clears its hurdle, all of them share the
// same new settlement date and post-fee NAV, so they can safely become one lot.
const allProfitableState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('profit-d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('profit-v1', 'valuation', '2025-07-01', 2, { totalNAV: 120 }),
    event('profit-d2', 'deposit', '2025-07-01', 3, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('profit-v2', 'valuation', '2026-01-01', 4, { totalNAV: 240 }),
    event('profit-s', 'performance_settlement', '2026-01-01', 5, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
});
const allProfitableSettlement = allProfitableState.events.find(item => item.id === 'profit-s');
assert(allProfitableSettlement._breakdown[0].lots.every(lot => lot.fee > 0));
assert.strictEqual(allProfitableState.members.lp.lpLedger.length, 1, 'all independently crystallized lots should merge');
assert.strictEqual(allProfitableState.members.lp.lpLedger[0].startDate, '2026-01-01');

// Entering the complete pre-fee account value means a true full exit: the GP
// receives carry, the LP receives the net cash and retains no residual shares.
const fullExitState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('exit-d', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('exit-v', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('exit-w', 'withdraw', '2026-01-01', 3, {
      member: 'lp', amount: 120, cnhAmount: 864, fullExit: true,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    })
  ]
});
const fullExit = fullExitState.events.find(item => item.id === 'exit-w');
assert.strictEqual(fullExit._performanceFee, 3.5);
assert.strictEqual(fullExit._actualAmount, 116.5);
assert.strictEqual(fullExit._unpaidPerformanceFeeShares, 0);
assert.strictEqual(fullExitState.members.lp.currentValue, 0);
assert.strictEqual(fullExitState.members.lp.lpShares, 0);
assert.strictEqual(fullExitState.members.lp.lpCurrentValue, 0);
assert.strictEqual(fullExitState.members.lp.gpCarryShares, 0, 'LP exit must not create carry for the withdrawing LP');
assert.strictEqual(fullExitState.members.lp.lpLedger.length, 0, 'full exit must remove zero-share lots');
assert.strictEqual(fullExitState.members.gp.gpCarryValue, 3.5);
assert.strictEqual(fullExitState.summary.totalNAV, 3.5);
assert.strictEqual(fullExitState.summary.remainingPrincipal, 0,
  'a full LP exit must remove all remaining principal even when GP carry stays invested');
assert.strictEqual(fullExitState.summary.activeProfit, 3.5);
assert.strictEqual(fullExitState.summary.activeProfitRate, null,
  'pure carry without remaining contributed principal has no finite active-capital ROI');

const selfGpFullExitState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'both', name: 'LP and GP', roles: { lp: true, gp: true } }],
  indexCache: {},
  events: [
    event('self-d', 'deposit', '2025-01-01', 1, { member: 'both', amount: 100, cnhAmount: 720 }),
    event('self-v', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('self-s', 'performance_settlement', '2026-01-01', 3, { gpMember: 'both', annualRate: 0.06, feeRate: 0.25 }),
    event('self-w', 'withdraw', '2026-01-01', 4, {
      member: 'both', amount: 120, cnhAmount: 864, fullExit: true,
      performanceFee: { gpMember: 'both', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    })
  ]
});
assert.strictEqual(selfGpFullExitState.events.find(item => item.id === 'self-w')._actualAmount, 120);
approximately(
  selfGpFullExitState.events.find(item => item.id === 'self-w')._carrySharesDisposed,
  3.5 / 1.2
);
assert.strictEqual(selfGpFullExitState.members.both.currentValue, 0);
assert.strictEqual(selfGpFullExitState.members.both.lpShares, 0);
assert.strictEqual(selfGpFullExitState.members.both.gpCarryShares, 0);
assert.strictEqual(selfGpFullExitState.summary.totalNAV, 0);

const selfGpMixedPartialState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'both', name: 'LP and GP', roles: { lp: true, gp: true } }],
  indexCache: {},
  events: [
    event('mixed-d', 'deposit', '2025-01-01', 1, { member: 'both', amount: 100, cnhAmount: 720 }),
    event('mixed-v1', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('mixed-s', 'performance_settlement', '2026-01-01', 3, { gpMember: 'both', annualRate: 0.06, feeRate: 0.25 }),
    event('mixed-v2', 'valuation', '2026-01-01', 4, { totalNAV: 140 }),
    event('mixed-w', 'withdraw', '2026-01-01', 5, {
      member: 'both', amount: 133, cnhAmount: 957.6,
      performanceFee: { gpMember: 'both', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    })
  ]
});
const selfGpMixedWithdrawal = selfGpMixedPartialState.events.find(item => item.id === 'mixed-w');
assert.strictEqual(selfGpMixedWithdrawal._actualAmount, 133);
assert.strictEqual(selfGpMixedWithdrawal._unpaidPerformanceFeeShares, 0);
assert(selfGpMixedWithdrawal._carrySharesDisposed > 0, 'cash above LP net value must come from existing GP carry');
assert.strictEqual(selfGpMixedPartialState.members.both.currentValue, 7);
approximately(
  selfGpMixedPartialState.members.both.shares,
  selfGpMixedPartialState.members.both.lpShares + selfGpMixedPartialState.members.both.gpCarryShares,
  1e-4
);

const selfGpMixedTransferState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [
    { id: 'both', name: 'LP and GP', roles: { lp: true, gp: true } },
    { id: 'buyer', name: 'Buyer', roles: { lp: true, gp: false } }
  ],
  indexCache: {},
  events: [
    event('mixed-t-d', 'deposit', '2025-01-01', 1, { member: 'both', amount: 100, cnhAmount: 720 }),
    event('mixed-t-v1', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('mixed-t-s', 'performance_settlement', '2026-01-01', 3, { gpMember: 'both', annualRate: 0.06, feeRate: 0.25 }),
    event('mixed-t-v2', 'valuation', '2026-01-01', 4, { totalNAV: 140 }),
    event('mixed-t', 'transfer', '2026-01-01', 5, {
      fromMember: 'both', toMember: 'buyer', amount: 133, cnhRate: 7.2, cnhAmount: 957.6,
      performanceFee: { gpMember: 'both', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    })
  ]
});
const selfGpMixedTransfer = selfGpMixedTransferState.events.find(item => item.id === 'mixed-t');
assert.strictEqual(selfGpMixedTransfer._actualAmount, 133);
assert.strictEqual(selfGpMixedTransfer._unpaidPerformanceFeeShares, 0);
assert(selfGpMixedTransfer._carrySharesDisposed > 0, 'transfer above LP net value must use existing GP carry');
assert.strictEqual(selfGpMixedTransferState.members.both.currentValue, 7);
assert.strictEqual(selfGpMixedTransferState.members.buyer.lpCurrentValue, 133);
assert.strictEqual(selfGpMixedTransferState.summary.totalNAV, 140);

const fullTransferState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'seller', name: 'Seller' }, { id: 'buyer', name: 'Buyer' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('full-t-d', 'deposit', '2025-01-01', 1, { member: 'seller', amount: 100, cnhAmount: 720 }),
    event('full-t-v', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('full-t', 'transfer', '2026-01-01', 3, {
      fromMember: 'seller', toMember: 'buyer', amount: 120, cnhRate: 7.2, cnhAmount: 864, fullExit: true,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    })
  ]
});
const fullTransfer = fullTransferState.events.find(item => item.id === 'full-t');
assert.strictEqual(fullTransfer._actualAmount, 116.5);
assert.strictEqual(fullTransfer._disposedRatio, 1, 'full transfer must disclose 100% lot disposal before carry');
assert.strictEqual(fullTransferState.members.seller.currentValue, 0);
assert.strictEqual(fullTransferState.members.buyer.lpCurrentValue, 116.5);
assert.strictEqual(fullTransferState.members.gp.gpCarryValue, 3.5);
assert.strictEqual(fullTransferState.summary.totalNAV, 120);

const reentryAfterExitState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('re-d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('re-v1', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('re-w', 'withdraw', '2026-01-01', 3, {
      member: 'lp', amount: 120, cnhAmount: 864, fullExit: true,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    }),
    event('re-d2', 'deposit', '2026-02-01', 4, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('re-v2', 'valuation', '2027-01-01', 5, { totalNAV: 120 }),
    event('re-s', 'performance_settlement', '2027-01-01', 6, { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 })
  ]
});
const reentrySettlement = reentryAfterExitState.events.find(item => item.id === 're-s');
assert.strictEqual(reentrySettlement._breakdown[0].lots.length, 1);
assert(Number.isFinite(reentrySettlement._breakdown[0].lots[0].entryNav));
assert.strictEqual(reentryAfterExitState.members.lp.lpLedger.length, 1);

// Net partial withdrawals must be path-independent: taking cash in two steps
// at the same NAV produces the same total LP cash and GP carry as one full exit.
const stagedExitState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('staged-d', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('staged-v', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('staged-w1', 'withdraw', '2026-01-01', 3, {
      member: 'lp', amount: 60, cnhAmount: 432,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    }),
    event('staged-w2', 'withdraw', '2026-01-01', 4, {
      member: 'lp', amount: 58.197424892704, cnhAmount: 419.021459227469, fullExit: true,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    })
  ]
});
approximately(stagedExitState.members.lp.totalWithdraw, 116.5);
approximately(stagedExitState.members.gp.gpCarryValue, 3.5);
assert.strictEqual(stagedExitState.members.lp.lpShares, 0);
assert.strictEqual(stagedExitState.summary.remainingPrincipal, 0,
  'staged and single-step full exits must dispose the same principal');

// A large partial exit with a small winning lot must never let the member
// share balance diverge from the sum of the surviving LP lots.
const stressedLotState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('stress-d1', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('stress-v', 'valuation', '2026-01-01', 2, { totalNAV: 200 }),
    event('stress-d2', 'deposit', '2026-01-01', 3, { member: 'lp', amount: 1000, cnhAmount: 7200 }),
    event('stress-w', 'withdraw', '2026-01-01', 4, {
      member: 'lp', amount: 1080, cnhAmount: 7776,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    })
  ]
});
approximately(stressedLotState.members.lp.shares, stressedLotState.members.lp.lpShares, 1e-4);
approximately(stressedLotState.members.lp.currentValue, stressedLotState.members.lp.lpCurrentValue);

// Unversioned historical events retain their original cash-plus-carry replay
// semantics so an algorithm upgrade cannot rewrite already recorded balances.
const legacyDisposalState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('legacy-d', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('legacy-v', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('legacy-w', 'withdraw', '2026-01-01', 3, {
      member: 'lp', amount: 60, cnhAmount: 432,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25 }
    })
  ]
});
const legacyWithdrawal = legacyDisposalState.events.find(item => item.id === 'legacy-w');
assert.strictEqual(legacyWithdrawal._disposalVersion, 1);
assert.strictEqual(legacyWithdrawal._disposedRatio, 0.5);
assert.strictEqual(legacyWithdrawal._performanceFee, 1.75);
approximately(
  legacyWithdrawal._disposedLots[0].totalShares,
  legacyWithdrawal._disposedLots[0].cashShares + legacyWithdrawal._disposedLots[0].feeShares
);
approximately(legacyDisposalState.members.lp.shares, legacyDisposalState.members.lp.lpShares, 1e-4);

// Preserve the frozen legacy algorithm even in its pathological boundary:
// cash shares plus carry can exactly exhaust one lot during a nominally
// partial disposal. Historical replay retained that zero lot for audit output.
const legacyExhaustedLotState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('legacy-zero-d', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('legacy-zero-v', 'valuation', '2025-01-02', 2, { totalNAV: 180 }),
    event('legacy-zero-w', 'withdraw', '2025-01-03', 3, {
      member: 'lp', amount: 162, cnhAmount: 1166.4,
      performanceFee: { gpMember: 'gp', annualRate: 0, feeRate: 0.25 }
    })
  ]
});
assert.strictEqual(legacyExhaustedLotState.members.lp.lpLedger.length, 1);
assert.strictEqual(legacyExhaustedLotState.members.lp.lpLedger[0].shares, 0);
assert(Number.isNaN(legacyExhaustedLotState.members.lp.lpLedger[0].highWaterNav));

// Reversal records remain auditable ledger events, but must not create a
// fake point/remark on the economic performance timeline.
const reversedChartState = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('capital-r', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('mark-r', 'valuation', '2025-12-31', 2, { totalNAV: 110 }),
    event('reverse-r', 'performance_settlement_reversal', '2026-08-05', 3, {
      settlementId: 'settled-r', settlementDate: '2025-12-31', remark: '管理员撤销最近一次业绩结算'
    })
  ]
});
assert(reversedChartState.events.some(item => item.id === 'reverse-r'), 'reversal remains in the audit ledger');
assert(!reversedChartState.charts.navHistory.some(item => item.eventId === 'reverse-r'), 'reversal must not appear in NAV history');
assert.strictEqual(reversedChartState.charts.navHistory.at(-1).date, '2025-12-31');
assert.strictEqual(reversedChartState.members.lp.lpLedger[0].hurdle, 105.98);

// Withdrawals and transfers must share one disposal engine. For every current
// and historical disposal shape, the outgoing member and GP economics are
// identical; only the fund cash flow and recipient acquisition differ.
for (const disposalVersion of [1, 2]) {
  for (const fullExit of [false, true]) {
    for (const selfGp of [false, true]) {
      const makePairedDb = type => ({
        cnhRate: 7.2,
        members: [
          { id: 'seller', name: 'Seller', roles: { lp: true, gp: selfGp } },
          { id: 'buyer', name: 'Buyer', roles: { lp: true, gp: false } },
          ...(!selfGp ? [{ id: 'gp', name: 'GP', roles: { lp: true, gp: true } }] : [])
        ],
        indexCache: {},
        events: [
          event('paired-d', 'deposit', '2025-01-01', 1, { member: 'seller', amount: 100, cnhAmount: 720 }),
          event('paired-v', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
          event(`paired-${type}`, type, '2026-01-01', 3, {
            ...(type === 'withdraw'
              ? { member: 'seller' }
              : { fromMember: 'seller', toMember: 'buyer', cnhRate: 7.2 }),
            amount: fullExit ? 120 : 60,
            cnhAmount: (fullExit ? 120 : 60) * 7.2,
            fullExit,
            performanceFee: {
              gpMember: selfGp ? 'seller' : 'gp',
              annualRate: 0.06,
              feeRate: 0.25,
              disposalVersion
            }
          })
        ]
      });
      const withdrawalState = calculateStateFromDb(makePairedDb('withdraw'));
      const transferState = calculateStateFromDb(makePairedDb('transfer'));
      const withdrawal = withdrawalState.events.at(-1);
      const transfer = transferState.events.at(-1);
      for (const field of [
        '_actualAmount', '_grossAmount', '_performanceFee', '_performanceFeeShares',
        '_carrySharesDisposed', '_unpaidPerformanceFeeShares', '_fullExit',
        '_disposalVersion', '_disposedRatio'
      ]) {
        assert.strictEqual(transfer[field], withdrawal[field], `${field} must match for paired disposal`);
      }
      assert.deepStrictEqual(transfer._disposedLots, withdrawal._disposedLots);
      for (const field of ['shares', 'lpShares', 'gpCarryShares', 'totalWithdraw', 'cnhWithdraw']) {
        assert.strictEqual(transferState.members.seller[field], withdrawalState.members.seller[field]);
      }
      if (!selfGp) {
        for (const field of ['shares', 'gpCarryShares']) {
          assert.strictEqual(transferState.members.gp[field], withdrawalState.members.gp[field]);
        }
      }
    }
  }
}

const snapshottedRateDb = {
  cnhRate: 7.2,
  performanceFee: { gpMemberId: 'gp', annualRate: 0.5, feeRate: 0.9 },
  members: [{ id: 'lp', name: 'LP' }, { id: 'gp', name: 'GP' }],
  indexCache: {},
  events: [
    event('snapshot-d', 'deposit', '2025-01-01', 1, { member: 'lp', amount: 100, cnhAmount: 720 }),
    event('snapshot-v', 'valuation', '2026-01-01', 2, { totalNAV: 120 }),
    event('snapshot-w', 'withdraw', '2026-01-01', 3, {
      member: 'lp', amount: 60, cnhAmount: 432,
      performanceFee: { gpMember: 'gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 }
    })
  ]
};
const snapshottedRateState = calculateStateFromDb(snapshottedRateDb);
const changedCurrentConfig = JSON.parse(JSON.stringify(snapshottedRateDb));
changedCurrentConfig.performanceFee = { gpMemberId: 'gp', annualRate: 0, feeRate: 0 };
const changedCurrentRateState = calculateStateFromDb(changedCurrentConfig);
assert.deepStrictEqual(changedCurrentRateState.events, snapshottedRateState.events,
  'changing current fee configuration must not rewrite historical event economics');
for (const field of ['shares', 'currentValue', 'totalWithdraw', 'lpShares', 'gpCarryShares']) {
  assert.strictEqual(changedCurrentRateState.members.lp[field], snapshottedRateState.members.lp[field]);
  assert.strictEqual(changedCurrentRateState.members.gp[field], snapshottedRateState.members.gp[field]);
}
assert(changedCurrentRateState.members.lp.lpLedger[0].hurdle < snapshottedRateState.members.lp.lpLedger[0].hurdle,
  'the prospective member hurdle must reflect the current configured annual rate');

console.log('Performance settlement hurdle, HWM and lot-transfer assertions passed.');
