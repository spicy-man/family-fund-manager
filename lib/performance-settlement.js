const Decimal = require('decimal.js');
const { DEFAULT_ANNUAL_RATE, DEFAULT_FEE_RATE } = require('./performance-fee-policy');

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_SETTLEMENT_VERSION = 1;
const INDEPENDENT_LOT_SETTLEMENT_VERSION = 2;
const CURRENT_SETTLEMENT_VERSION = 3;

function daysBetween(from, to) {
  return Math.max(0, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function hurdleValue(lot, date, annualRate) {
  return lot.basis.mul(ONE.plus(annualRate).pow(daysBetween(lot.date, date) / 365));
}

// Version 1 is the original v3.5 settlement rule. It netted all LP lots
// together before charging carry and reset every lot whenever the member as a
// whole was above the hurdle. Keep it frozen for deterministic replay only.
function settlePerformanceV1({ event, members, memberOrder = Object.keys(members), currentNAV, output }) {
  const gpMember = members[event.gpMember];
  const annualRate = new Decimal(event.annualRate ?? DEFAULT_ANNUAL_RATE);
  const feeRate = new Decimal(event.feeRate ?? DEFAULT_FEE_RATE);
  let totalFee = ZERO;
  const breakdown = [];

  if (!gpMember) throw new Error(`业绩结算的GP成员不存在：${event.gpMember}`);
  for (const member of memberOrder.map(id => members[id])) {
    const lpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
    const isSettlementLp = Array.isArray(event.lpMembers)
      ? event.lpMembers.includes(member.id)
      : member.isLP;
    if (!isSettlementLp || lpShares.isZero()) continue;

    const valueBefore = lpShares.mul(currentNAV);
    const lotBreakdown = member.lots.map(lot => {
      const lotHurdle = hurdleValue(lot, event.date, annualRate);
      const lotValue = lot.shares.mul(currentNAV);
      return {
        sourceEventId: lot.sourceEventId,
        sourceType: lot.sourceType || 'legacy',
        startDate: lot.date,
        holdingDays: daysBetween(lot.date, event.date),
        basis: output(lot.basis, 2),
        entryNav: output(lot.basis.div(lot.shares), 12),
        shares: output(lot.shares, 12),
        currentValue: output(lotValue, 2),
        hurdle: output(lotHurdle, 2),
        aboveHurdle: output(lotValue.minus(lotHurdle), 2)
      };
    });
    const hurdle = member.lots.reduce((sum, lot) => sum.plus(hurdleValue(lot, event.date, annualRate)), ZERO);
    const excess = Decimal.max(ZERO, valueBefore.minus(hurdle));
    const fee = excess.mul(feeRate);
    const feeShares = Decimal.min(lpShares, fee.div(currentNAV));
    member.shares = member.shares.minus(feeShares);
    gpMember.shares = gpMember.shares.plus(feeShares);
    gpMember.carryShares = gpMember.carryShares.plus(feeShares);
    totalFee = totalFee.plus(fee);

    const lpSharesAfter = lpShares.minus(feeShares);
    const valueAfter = lpSharesAfter.mul(currentNAV);
    if (fee.gt(ZERO)) {
      member.lots = lpSharesAfter.isZero() ? [] : [{
        shares: lpSharesAfter,
        basis: valueAfter,
        date: event.date,
        sourceEventId: event.id,
        sourceType: 'settlement_reset'
      }];
    }
    member.lpShares = fee.gt(ZERO) ? lpSharesAfter : lpShares;
    breakdown.push({
      member: member.id,
      valueBefore: output(valueBefore, 2),
      hurdle: output(hurdle, 2),
      excess: output(excess, 2),
      fee: output(fee, 2),
      feeShares: output(feeShares, 12),
      sharesBefore: output(lpShares, 12),
      sharesAfter: output(lpSharesAfter, 12),
      lots: lotBreakdown
    });
  }

  return {
    breakdown,
    totalFee,
    feeShares: breakdown.reduce((sum, item) => sum.plus(item.feeShares), ZERO)
  };
}

// Version 2 crystallizes each contribution lot independently so profitable
// and loss-making batches can never offset one another.
function settlePerformanceV2({ event, members, memberOrder = Object.keys(members), currentNAV, output }) {
  const gpMember = members[event.gpMember];
  const annualRate = new Decimal(event.annualRate ?? DEFAULT_ANNUAL_RATE);
  const feeRate = new Decimal(event.feeRate ?? DEFAULT_FEE_RATE);
  let totalFee = ZERO;
  const breakdown = [];

  if (!gpMember) throw new Error(`业绩结算的GP成员不存在：${event.gpMember}`);
  for (const member of memberOrder.map(id => members[id])) {
    member.lots = member.lots.filter(lot => !lot.shares.isZero());
    const lpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
    const isSettlementLp = Array.isArray(event.lpMembers)
      ? event.lpMembers.includes(member.id)
      : member.isLP;
    if (!isSettlementLp || lpShares.isZero()) continue;

    const valueBefore = lpShares.mul(currentNAV);
    const settledLots = [];
    const lotBreakdown = member.lots.map(lot => {
      const lotHurdle = hurdleValue(lot, event.date, annualRate);
      const lotValue = lot.shares.mul(currentNAV);
      const lotExcess = Decimal.max(ZERO, lotValue.minus(lotHurdle));
      const lotFee = lotExcess.mul(feeRate);
      const lotFeeShares = Decimal.min(lot.shares, lotFee.div(currentNAV));
      const sharesAfter = lot.shares.minus(lotFeeShares);
      if (lotFee.gt(ZERO)) {
        if (sharesAfter.gt(ZERO)) settledLots.push({
          shares: sharesAfter,
          basis: sharesAfter.mul(currentNAV),
          date: event.date,
          sourceEventId: event.id,
          sourceType: 'settlement_reset'
        });
      } else {
        settledLots.push(lot);
      }
      return {
        sourceEventId: lot.sourceEventId,
        sourceType: lot.sourceType || 'legacy',
        startDate: lot.date,
        holdingDays: daysBetween(lot.date, event.date),
        basis: output(lot.basis, 2),
        entryNav: output(lot.basis.div(lot.shares), 12),
        shares: output(lot.shares, 12),
        currentValue: output(lotValue, 2),
        hurdle: output(lotHurdle, 2),
        aboveHurdle: output(lotValue.minus(lotHurdle), 2),
        fee: output(lotFee, 2),
        feeShares: output(lotFeeShares, 12)
      };
    });
    const hurdle = member.lots.reduce((sum, lot) => sum.plus(hurdleValue(lot, event.date, annualRate)), ZERO);
    const excess = member.lots.reduce((sum, lot) => {
      return sum.plus(Decimal.max(ZERO, lot.shares.mul(currentNAV).minus(hurdleValue(lot, event.date, annualRate))));
    }, ZERO);
    const fee = excess.mul(feeRate);
    const feeShares = Decimal.min(lpShares, fee.div(currentNAV));
    member.shares = member.shares.minus(feeShares);
    gpMember.shares = gpMember.shares.plus(feeShares);
    gpMember.carryShares = gpMember.carryShares.plus(feeShares);
    totalFee = totalFee.plus(fee);

    const lpSharesAfter = lpShares.minus(feeShares);
    const valueAfter = lpSharesAfter.mul(currentNAV);
    if (fee.gt(ZERO)) {
      const allLotsCrystallized = member.lots.every(lot => {
        return lot.shares.mul(currentNAV).gt(hurdleValue(lot, event.date, annualRate));
      });
      member.lots = allLotsCrystallized
        ? (lpSharesAfter.isZero() ? [] : [{
            shares: lpSharesAfter,
            basis: valueAfter,
            date: event.date,
            sourceEventId: event.id,
            sourceType: 'settlement_reset'
          }])
        : settledLots;
    }
    member.lpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
    breakdown.push({
      member: member.id,
      valueBefore: output(valueBefore, 2),
      hurdle: output(hurdle, 2),
      excess: output(excess, 2),
      fee: output(fee, 2),
      feeShares: output(feeShares, 12),
      sharesBefore: output(lpShares, 12),
      sharesAfter: output(lpSharesAfter, 12),
      lots: lotBreakdown
    });
  }

  return {
    breakdown,
    totalFee,
    feeShares: breakdown.reduce((sum, item) => sum.plus(item.feeShares), ZERO)
  };
}

// Version 3 keeps the independent-lot fee calculation introduced in v2, while
// separating the annual measurement period from the high-water NAV. Every
// settlement restarts the holding clock, but a lot's per-share high-water NAV
// can only rise. The stored basis is derived from that NAV and the LP shares
// remaining after carry shares are transferred to the GP.
function settlePerformanceV3({ event, members, memberOrder = Object.keys(members), currentNAV, output }) {
  const gpMember = members[event.gpMember];
  const annualRate = new Decimal(event.annualRate ?? DEFAULT_ANNUAL_RATE);
  const feeRate = new Decimal(event.feeRate ?? DEFAULT_FEE_RATE);
  let totalFee = ZERO;
  const breakdown = [];

  if (!gpMember) throw new Error(`业绩结算的GP成员不存在：${event.gpMember}`);
  for (const member of memberOrder.map(id => members[id])) {
    member.lots = member.lots.filter(lot => !lot.shares.isZero());
    const lpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
    const isSettlementLp = Array.isArray(event.lpMembers)
      ? event.lpMembers.includes(member.id)
      : member.isLP;
    if (!isSettlementLp || lpShares.isZero()) continue;

    const valueBefore = lpShares.mul(currentNAV);
    const settledLots = [];
    const lotBreakdown = member.lots.map(lot => {
      const lotHurdle = hurdleValue(lot, event.date, annualRate);
      const lotValue = lot.shares.mul(currentNAV);
      const lotExcess = Decimal.max(ZERO, lotValue.minus(lotHurdle));
      const lotFee = lotExcess.mul(feeRate);
      const lotFeeShares = Decimal.min(lot.shares, lotFee.div(currentNAV));
      const sharesAfter = lot.shares.minus(lotFeeShares);
      if (sharesAfter.gt(ZERO)) {
        const priorHighWaterNav = lot.basis.div(lot.shares);
        const nextHighWaterNav = Decimal.max(priorHighWaterNav, currentNAV);
        settledLots.push({
          shares: sharesAfter,
          basis: sharesAfter.mul(nextHighWaterNav),
          date: event.date,
          sourceEventId: event.id,
          sourceType: 'settlement_reset'
        });
      }
      return {
        sourceEventId: lot.sourceEventId,
        sourceType: lot.sourceType || 'legacy',
        startDate: lot.date,
        holdingDays: daysBetween(lot.date, event.date),
        basis: output(lot.basis, 2),
        entryNav: output(lot.basis.div(lot.shares), 12),
        shares: output(lot.shares, 12),
        currentValue: output(lotValue, 2),
        hurdle: output(lotHurdle, 2),
        aboveHurdle: output(lotValue.minus(lotHurdle), 2),
        fee: output(lotFee, 2),
        feeShares: output(lotFeeShares, 12)
      };
    });
    const hurdle = member.lots.reduce((sum, lot) => sum.plus(hurdleValue(lot, event.date, annualRate)), ZERO);
    const excess = member.lots.reduce((sum, lot) => {
      return sum.plus(Decimal.max(ZERO, lot.shares.mul(currentNAV).minus(hurdleValue(lot, event.date, annualRate))));
    }, ZERO);
    const fee = excess.mul(feeRate);
    const feeShares = Decimal.min(lpShares, fee.div(currentNAV));
    member.shares = member.shares.minus(feeShares);
    gpMember.shares = gpMember.shares.plus(feeShares);
    gpMember.carryShares = gpMember.carryShares.plus(feeShares);
    totalFee = totalFee.plus(fee);

    const lpSharesAfter = lpShares.minus(feeShares);
    const valueAfter = lpSharesAfter.mul(currentNAV);
    const allLotsAtCurrentHigh = settledLots.every(lot =>
      lot.basis.eq(lot.shares.mul(currentNAV))
    );
    member.lots = lpSharesAfter.isZero()
      ? []
      : allLotsAtCurrentHigh
        ? [{
            shares: lpSharesAfter,
            basis: valueAfter,
            date: event.date,
            sourceEventId: event.id,
            sourceType: 'settlement_reset'
          }]
        : settledLots;
    member.lpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
    breakdown.push({
      member: member.id,
      valueBefore: output(valueBefore, 2),
      hurdle: output(hurdle, 2),
      excess: output(excess, 2),
      fee: output(fee, 2),
      feeShares: output(feeShares, 12),
      sharesBefore: output(lpShares, 12),
      sharesAfter: output(lpSharesAfter, 12),
      lots: lotBreakdown
    });
  }

  return {
    breakdown,
    totalFee,
    feeShares: breakdown.reduce((sum, item) => sum.plus(item.feeShares), ZERO)
  };
}

function settlePerformance(args) {
  if (args.event.algorithmVersion === undefined) {
    throw new Error('业绩结算记录缺少算法版本，必须先完成安全迁移。');
  }
  const version = Number(args.event.algorithmVersion);
  if (version === LEGACY_SETTLEMENT_VERSION) return settlePerformanceV1(args);
  if (version === INDEPENDENT_LOT_SETTLEMENT_VERSION) return settlePerformanceV2(args);
  if (version === CURRENT_SETTLEMENT_VERSION) return settlePerformanceV3(args);
  throw new Error(`不支持的业绩结算算法版本：${args.event.algorithmVersion}`);
}

function previewDisposalFee({
  member, currentNAV, date, lpSharesDisposed, netCashAmount, annualRate, feeRate,
  output, includeLotDetails = true, legacyDisposal = false, metrics
}) {
  let lpShares = ZERO;
  let fullValue = ZERO;
  let fullNetValue = ZERO;
  const evaluatedLots = [];

  // Keep the expensive hurdle calculation to one pass. The previous
  // implementation separately reduced/map/reduced the same lot collection,
  // then calculator.js traversed it once more to apply the disposal.
  for (const lot of member.lots) {
    if (metrics) metrics.disposalLotVisits = (metrics.disposalLotVisits || 0) + 1;
    const hurdle = hurdleValue(lot, date, annualRate);
    const value = lot.shares.mul(currentNAV);
    const fee = Decimal.max(ZERO, value.minus(hurdle)).mul(feeRate);
    lpShares = lpShares.plus(lot.shares);
    fullValue = fullValue.plus(value);
    fullNetValue = fullNetValue.plus(value.minus(fee));
    evaluatedLots.push({ lot, hurdle, value, fee });
  }
  if (lpShares.isZero() || lpSharesDisposed.isZero()) {
    return {
      fee: ZERO,
      feeShares: ZERO,
      feeSharesByLot: [],
      cashShares: ZERO,
      ratio: ZERO,
      hurdle: ZERO,
      value: ZERO,
      lots: [],
      remainingLots: member.lots,
      remainingLpShares: lpShares
    };
  }
  const ratio = netCashAmount === undefined
    ? lpSharesDisposed.div(lpShares)
    : Decimal.min(ONE, new Decimal(netCashAmount).div(fullNetValue));
  const feeCarvedFromDisposal = netCashAmount !== undefined || ratio.eq(ONE);
  let hurdle = ZERO;
  let fee = ZERO;
  const value = fullValue.mul(ratio);
  let cashSharesTotal = ZERO;
  const feeSharesByLot = [];
  const lots = [];
  const remainingLots = [];
  let remainingLpShares = ZERO;

  for (const { lot, hurdle: lotFullHurdle, value: lotFullValue, fee: lotFullFee } of evaluatedLots) {
    if (metrics) metrics.disposalLotVisits = (metrics.disposalLotVisits || 0) + 1;
    const disposedShares = lot.shares.mul(ratio);
    const disposedBasis = lot.basis.mul(ratio);
    const disposedHurdle = lotFullHurdle.mul(ratio);
    const disposedValue = lotFullValue.mul(ratio);
    const lotFee = lotFullFee.mul(ratio);
    const lotFeeShares = lotFee.div(currentNAV);
    if (legacyDisposal) feeSharesByLot.push(lotFeeShares);
    // Version-2 partial disposals treat the entered amount as LP net cash and
    // carve carry out of the same gross lot disposal. Historical unversioned
    // partial events treated the entered amount as the cash disposal and
    // removed carry in addition to it, so their replay must retain that shape.
    const lotCashValue = feeCarvedFromDisposal ? disposedValue.minus(lotFee) : disposedValue;
    const cashShares = lotCashValue.div(currentNAV);
    hurdle = hurdle.plus(disposedHurdle);
    fee = fee.plus(lotFee);
    cashSharesTotal = cashSharesTotal.plus(cashShares);
    const removedShares = feeCarvedFromDisposal
      ? disposedShares
      : Decimal.min(lot.shares, disposedShares.plus(lotFeeShares));
    const removedBasis = lot.shares.isZero() ? ZERO : lot.basis.mul(removedShares.div(lot.shares));
    const remainingShares = lot.shares.minus(removedShares);
    remainingLpShares = remainingLpShares.plus(remainingShares);
    if (!remainingShares.isZero() || legacyDisposal) {
      remainingLots.push({
        ...lot,
        shares: remainingShares,
        basis: lot.basis.minus(removedBasis)
      });
    }
    if (!includeLotDetails) continue;
    const totalShares = feeCarvedFromDisposal ? disposedShares : disposedShares.plus(lotFeeShares);
    const totalValue = feeCarvedFromDisposal ? disposedValue : disposedValue.plus(lotFee);
    lots.push({
      sourceEventId: lot.sourceEventId,
      sourceType: lot.sourceType || 'legacy',
      startDate: lot.date,
      holdingDays: daysBetween(lot.date, date),
      shares: output(disposedShares, 12),
      cashShares: output(cashShares, 12),
      totalShares: output(totalShares, 12),
      basis: output(disposedBasis, 2),
      hurdle: output(disposedHurdle, 2),
      value: output(disposedValue, 2),
      cashValue: output(lotCashValue, 2),
      totalValue: output(totalValue, 2),
      aboveHurdle: output(disposedValue.minus(disposedHurdle), 2),
      fee: output(lotFee, 2),
      feeShares: output(lotFeeShares, 12)
    });
  }
  return {
    fee,
    feeShares: fee.div(currentNAV),
    feeSharesByLot,
    cashShares: cashSharesTotal,
    ratio,
    hurdle,
    value,
    lots,
    remainingLots,
    remainingLpShares
  };
}

module.exports = {
  LEGACY_SETTLEMENT_VERSION,
  INDEPENDENT_LOT_SETTLEMENT_VERSION,
  CURRENT_SETTLEMENT_VERSION,
  daysBetween,
  hurdleValue,
  settlePerformance,
  previewDisposalFee
};
