const Decimal = require('decimal.js');
const { DEFAULT_ANNUAL_RATE, DEFAULT_FEE_RATE } = require('./performance-fee-policy');

const ZERO = new Decimal(0);

/**
 * Frozen historical performance-settlement algorithms (V1 & V2).
 *
 * These implementations are physically isolated from the active V3 engine in
 * `lib/performance-settlement.js` so new contributors do not confuse legacy
 * replay rules with current settlement behavior. Do NOT alter their math or
 * output shapes: historical locked snapshots rely on deterministic replay.
 */
function createLegacySettlements({ daysBetween, hurdleValue }) {
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
          // Legacy disposal retains exhausted audit lots. JSON historically
          // stored their undefined 0/0 NAV as null; replay must produce that
          // same value before comparing a persisted locked snapshot.
          entryNav: lot.shares.isZero() ? null : output(lot.basis.div(lot.shares), 12),
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

  return { settlePerformanceV1, settlePerformanceV2 };
}

module.exports = { createLegacySettlements };
