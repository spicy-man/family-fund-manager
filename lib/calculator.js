const Decimal = require('decimal.js');
const { hurdleValue, settlePerformance } = require('./performance-settlement');
const { disposeMemberPosition } = require('./member-disposal');
const { configuredPerformanceFeeRates } = require('./performance-fee-policy');
const { compareEvents } = require('./event-order');
const {
  normalizeCustomBenchmark,
  isUsableCustomEntry,
  customEntryForSlot
} = require('./custom-benchmark');
const {
  materializeBenchmarkCaches,
  mergeCustomBenchmarkCaches
} = require('./market-history');

// Ledger values must never be accumulated with binary floating point.  Keep
// all monetary amounts, NAVs and shares as decimals during replay, then round
// only at the API boundary.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const ZERO = new Decimal(0);
const ONE = new Decimal(1);

function decimal(value) {
  return new Decimal(value);
}

function output(value, decimalPlaces) {
  return decimal(value).toDecimalPlaces(decimalPlaces).toNumber();
}

function assertTradableNav(event, currentNAV) {
  if (currentNAV.lte(ZERO)) {
    throw new Error(`账本在 ${event.date} 的${event.type === 'deposit' ? '入金' : event.type === 'withdraw' ? '出金' : '转让'}前净值为 0，无法计算份额。请删除或修改此前的零估值记录。`);
  }
}

function isUsableIndexEntry(entry, navDate, policy) {
  const isValidSourceDate = sourceDate => sourceDate < navDate;
  return entry &&
    entry.policy === policy &&
    typeof entry.spxPriceDate === 'string' &&
    isValidSourceDate(entry.spxPriceDate) &&
    typeof entry.ndxPriceDate === 'string' &&
    isValidSourceDate(entry.ndxPriceDate) &&
    Number.isFinite(entry.spx) &&
    Number.isFinite(entry.ndx);
}

function findIndices(dateStr, cache, policy) {
  if (isUsableIndexEntry(cache[dateStr], dateStr, policy)) return cache[dateStr];

  // Never use a later event's cache entry as a fallback: that would leak
  // future market information while the background refresh is still running.
  const fallbackDate = Object.keys(cache)
    .filter(candidate => candidate < dateStr && isUsableIndexEntry(cache[candidate], candidate, policy))
    .sort()
    .at(-1);
  return fallbackDate ? cache[fallbackDate] : null;
}

function findCustomBenchmarkEntry(dateStr, cache, benchmark, slot = 0) {
  if (!benchmark) return null;
  const exactEntry = customEntryForSlot(cache[dateStr], slot);
  if (isUsableCustomEntry(exactEntry, dateStr, benchmark)) return exactEntry;
  const fallbackDate = Object.keys(cache)
    .filter(candidate => candidate < dateStr &&
      isUsableCustomEntry(customEntryForSlot(cache[candidate], slot), candidate, benchmark))
    .sort()
    .at(-1);
  return fallbackDate ? customEntryForSlot(cache[fallbackDate], slot) : null;
}

function calculateCustomBenchmarkValue(entry, baseEntry, benchmark) {
  if (!entry || !baseEntry || !benchmark) return null;
  let value = 0;
  for (const { ticker, weight } of benchmark.components) {
    const price = entry.components?.[ticker]?.price;
    const basePrice = baseEntry.components?.[ticker]?.price;
    if (!Number.isFinite(price) || !Number.isFinite(basePrice) || price <= 0 || basePrice <= 0) return null;
    value += (weight / 100) * (price / basePrice);
  }
  return Number(value.toFixed(6));
}

function customEntryPriceDate(entry, benchmark) {
  if (!entry || !benchmark) return null;
  return benchmark.components.map(({ ticker }) => entry.components?.[ticker]?.priceDate).filter(Boolean).sort().at(-1) || null;
}

function calculateStateFromDb(db, options = {}) {
  const autoFullExitEventIds = options.autoFullExitEventIds instanceof Set
    ? options.autoFullExitEventIds
    : new Set(options.autoFullExitEventIds || []);
  const includeDisposalLotDetails = options.includeDisposalLotDetails !== false;
  const metrics = options.metrics;
  const verifyLotSummaries = options.verifyLotSummaries === true;
  const captureAccountValueBefore = options.captureAccountValueBefore === true || autoFullExitEventIds.size > 0;
  const sortedEvents = [...db.events].sort(compareEvents);
  if (metrics) {
    metrics.eventCount = sortedEvents.length;
    metrics.disposalLotVisits = 0;
    metrics.peakActiveLotCount = 0;
    metrics.finalActiveLotCount = 0;
  }

  let navPerShare = ONE;
  let totalShares = ZERO;
  let totalNAV = ZERO;
  // Fund-level performance must only reflect cash crossing the family-fund
  // boundary. Member-to-member transfers remain in personal ledgers only.
  let fundExternalDeposit = ZERO;
  let fundExternalWithdraw = ZERO;
  let fundExternalCnhDeposit = ZERO;
  let fundExternalCnhWithdraw = ZERO;
  const globalCnhRate = decimal(db.cnhRate || 7.2);
  const currentAnnualRate = decimal(configuredPerformanceFeeRates(db.performanceFee).annualRate);

  const members = {};
  const memberHistory = {};
  db.members.forEach(m => {
    members[m.id] = {
      id: m.id,
      name: m.name,
      shares: ZERO,
      totalDeposit: ZERO,
      totalWithdraw: ZERO,
      cnhDeposit: ZERO,
      cnhWithdraw: ZERO,
      // ROI principal is deliberately independent from lot.basis.  Lot basis
      // is also the performance-fee/high-water reference and can be reset by
      // crystallization, while this balance only tracks external principal
      // that is still represented by the member's position.
      remainingPrincipal: ZERO,
      cnhRemainingPrincipal: ZERO,
      lots: [],
      lpShares: ZERO,
      carryShares: ZERO,
      isLP: m.roles?.lp !== false,
      isGP: m.roles?.gp === true
    };
    memberHistory[m.id] = [];
  });

  const navHistory = [];
  const benchmarkClosePolicy = 'previous';
  const customBenchmark = normalizeCustomBenchmark(db.customBenchmark);
  const customBenchmark2 = normalizeCustomBenchmark(db.customBenchmark2);
  const materialized = db.marketHistory
    ? materializeBenchmarkCaches(
      sortedEvents.map(event => event.date),
      db.marketHistory,
      [customBenchmark, customBenchmark2],
      benchmarkClosePolicy
    )
    : { indexCache: {}, customBenchmarkCache: {} };
  // Daily market history is the source of truth. Legacy per-NAV caches remain
  // as a compatibility fallback while existing installations build history.
  const indexCache = { ...(db.indexCache || {}), ...materialized.indexCache };
  const customBenchmarkCache = mergeCustomBenchmarkCaches(
    db.customBenchmarkCache,
    materialized.customBenchmarkCache
  );
  let baseSpx = 5000;
  let baseNdx = 18000;
  let baseCustomEntry = null;
  let baseCustomEntry2 = null;
  if (sortedEvents.length > 0) {
    const inceptionDate = sortedEvents[0].date;
    const baseIndices = findIndices(inceptionDate, indexCache, benchmarkClosePolicy);
    if (baseIndices) {
      baseSpx = baseIndices.spx;
      baseNdx = baseIndices.ndx;
    }
    baseCustomEntry = findCustomBenchmarkEntry(inceptionDate, customBenchmarkCache, customBenchmark);
    baseCustomEntry2 = findCustomBenchmarkEntry(inceptionDate, customBenchmarkCache, customBenchmark2, 1);
  }

  sortedEvents.forEach(event => {
    const currentNAV = totalShares.isZero() ? ONE : navPerShare;

    if (event.type === 'deposit') {
      assertTradableNav(event, currentNAV);
      const amount = decimal(event.amount);
      const eventCnhAmount = event.cnhAmount !== undefined
        ? decimal(event.cnhAmount)
        : amount.mul(globalCnhRate);
      const sharesGained = amount.div(currentNAV);
      const member = members[event.member];

      if (member) {
        member.shares = member.shares.plus(sharesGained);
        member.totalDeposit = member.totalDeposit.plus(amount);
        member.cnhDeposit = member.cnhDeposit.plus(eventCnhAmount);
        member.remainingPrincipal = member.remainingPrincipal.plus(amount);
        member.cnhRemainingPrincipal = member.cnhRemainingPrincipal.plus(eventCnhAmount);
        member.lots.push({
          shares: sharesGained,
          basis: amount,
          date: event.date,
          sourceEventId: event.id,
          sourceType: 'deposit'
        });
        member.lpShares = member.lpShares.plus(sharesGained);
        totalShares = totalShares.plus(sharesGained);
        fundExternalDeposit = fundExternalDeposit.plus(amount);
        fundExternalCnhDeposit = fundExternalCnhDeposit.plus(eventCnhAmount);
      }
      totalNAV = totalShares.mul(currentNAV);
      navPerShare = currentNAV;
      event._sharesGained = output(sharesGained, 12);
      event._navAtTx = output(currentNAV, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);
      event._cnhAmountComputed = output(eventCnhAmount, 12);

    } else if (event.type === 'withdraw') {
      assertTradableNav(event, currentNAV);
      const amount = decimal(event.amount);
      let eventCnhAmount = event.cnhAmount !== undefined
        ? decimal(event.cnhAmount)
        : amount.mul(globalCnhRate);
      let sharesDeducted = ZERO;
      let actualAmount = ZERO;
      const member = members[event.member];

      if (member) {
        const feeConfig = event.performanceFee;
        const gpMember = feeConfig ? members[feeConfig.gpMember] : null;
        const disposed = disposeMemberPosition({
          event,
          member,
          gpMember,
          currentNAV,
          requestedAmount: amount,
          eventCnhAmount,
          autoFullExit: autoFullExitEventIds.has(event.id),
          captureAccountValueBefore,
          output,
          includeLotDetails: includeDisposalLotDetails,
          metrics
        });
        const principalRatio = disposed.isFullExit
          ? ONE
          : Decimal.min(ONE, Decimal.max(ZERO, disposed.disposal.ratio));
        const principalReturned = member.remainingPrincipal.mul(principalRatio);
        const cnhPrincipalReturned = member.cnhRemainingPrincipal.mul(principalRatio);
        member.remainingPrincipal = member.remainingPrincipal.minus(principalReturned);
        member.cnhRemainingPrincipal = member.cnhRemainingPrincipal.minus(cnhPrincipalReturned);
        sharesDeducted = disposed.cashShares;
        actualAmount = disposed.actualAmount;
        // Preserve the historical display-safe cap for an already-underfunded
        // withdrawal: a zero-dollar settlement must not manufacture CNH cash.
        eventCnhAmount = disposed.sharesBefore.mul(currentNAV).isZero()
          ? ZERO
          : disposed.eventCnhAmount;
        member.totalWithdraw = member.totalWithdraw.plus(actualAmount);
        member.cnhWithdraw = member.cnhWithdraw.plus(eventCnhAmount);
        totalShares = totalShares.minus(sharesDeducted);
        fundExternalWithdraw = fundExternalWithdraw.plus(actualAmount);
        fundExternalCnhWithdraw = fundExternalCnhWithdraw.plus(eventCnhAmount);
        event._grossAmount = output(disposed.grossAmount, 12);
        event._performanceFee = output(disposed.disposal.fee, 12);
        event._performanceFeeShares = output(disposed.feeShares, 12);
        event._carrySharesDisposed = output(disposed.carrySharesDisposed, 12);
        event._unpaidPerformanceFeeShares = output(disposed.disposal.feeShares.minus(disposed.feeShares), 12);
        event._fullExit = disposed.isFullExit;
        event._disposalVersion = disposed.usesNetDisposal ? 2 : 1;
        event._disposedRatio = output(
          disposed.isFullExit
            ? ONE
            : disposed.usesNetDisposal
              ? disposed.disposal.ratio
              : disposed.lpSharesDisposed.div(disposed.lpSharesBefore),
          12
        );
        event._disposedLots = disposed.disposal.lots;
        event._principalReturned = output(principalReturned, 12);
        event._cnhPrincipalReturned = output(cnhPrincipalReturned, 12);
      }
      totalNAV = totalShares.mul(currentNAV);
      navPerShare = currentNAV;
      event._sharesDeducted = output(sharesDeducted, 12);
      event._navAtTx = output(currentNAV, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);
      event._actualAmount = output(actualAmount, 12);
      event._cnhAmountComputed = output(eventCnhAmount, 12);

    } else if (event.type === 'valuation') {
      event._hasSharesAtValuation = !totalShares.isZero();
      totalNAV = decimal(event.totalNAV);
      navPerShare = totalShares.isZero() ? ONE : totalNAV.div(totalShares);
      event._navAtTx = output(navPerShare, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);

    } else if (event.type === 'transfer') {
      assertTradableNav(event, currentNAV);
      const amount = decimal(event.amount);
      const eventRate = event.cnhRate !== undefined ? decimal(event.cnhRate) : globalCnhRate;
      let eventCnhAmount = event.cnhAmount !== undefined ? decimal(event.cnhAmount) : amount.mul(eventRate);
      let sharesTransferred = amount.div(currentNAV);
      let actualAmount = ZERO;
      const fromMember = members[event.fromMember];
      const toMember = members[event.toMember];

      if (fromMember) {
        const feeConfig = event.performanceFee;
        const gpMember = feeConfig ? members[feeConfig.gpMember] : null;
        const disposed = disposeMemberPosition({
          event,
          member: fromMember,
          gpMember,
          currentNAV,
          requestedAmount: amount,
          eventCnhAmount,
          autoFullExit: autoFullExitEventIds.has(event.id),
          captureAccountValueBefore,
          output,
          includeLotDetails: includeDisposalLotDetails,
          metrics
        });
        const principalRatio = disposed.isFullExit
          ? ONE
          : Decimal.min(ONE, Decimal.max(ZERO, disposed.disposal.ratio));
        const principalTransferred = fromMember.remainingPrincipal.mul(principalRatio);
        const cnhPrincipalTransferred = fromMember.cnhRemainingPrincipal.mul(principalRatio);
        fromMember.remainingPrincipal = fromMember.remainingPrincipal.minus(principalTransferred);
        fromMember.cnhRemainingPrincipal = fromMember.cnhRemainingPrincipal.minus(cnhPrincipalTransferred);
        sharesTransferred = disposed.cashShares;
        actualAmount = disposed.actualAmount;
        eventCnhAmount = disposed.eventCnhAmount;
        const netCnhAmount = eventCnhAmount;
        const netSharesTransferred = sharesTransferred;
        fromMember.totalWithdraw = fromMember.totalWithdraw.plus(actualAmount);
        fromMember.cnhWithdraw = fromMember.cnhWithdraw.plus(netCnhAmount);
        if (toMember) {
          toMember.shares = toMember.shares.plus(netSharesTransferred);
          toMember.totalDeposit = toMember.totalDeposit.plus(actualAmount);
          toMember.cnhDeposit = toMember.cnhDeposit.plus(netCnhAmount);
          // Internal transfers carry the sender's remaining principal rather
          // than creating new fund capital at the transfer market value.
          toMember.remainingPrincipal = toMember.remainingPrincipal.plus(principalTransferred);
          toMember.cnhRemainingPrincipal = toMember.cnhRemainingPrincipal.plus(cnhPrincipalTransferred);
          // A normal member transfer is a disposal for the sender and a new
          // LP acquisition for the recipient. The recipient's hurdle starts
          // from the transfer date/current NAV; it must not inherit the
          // sender's original contribution dates or historical cost lots.
          toMember.lots.push({
            shares: netSharesTransferred,
            basis: actualAmount,
            date: event.date,
            sourceEventId: event.id,
            sourceType: 'transfer_in'
          });
          toMember.lpShares = toMember.lpShares.plus(netSharesTransferred);
        }
        event._grossAmount = output(disposed.grossAmount, 12);
        event._performanceFee = output(disposed.disposal.fee, 12);
        event._performanceFeeShares = output(disposed.feeShares, 12);
        event._carrySharesDisposed = output(disposed.carrySharesDisposed, 12);
        event._unpaidPerformanceFeeShares = output(disposed.disposal.feeShares.minus(disposed.feeShares), 12);
        event._fullExit = disposed.isFullExit;
        event._disposalVersion = disposed.usesNetDisposal ? 2 : 1;
        event._disposedRatio = output(
          disposed.lpSharesBefore.isZero()
            ? ZERO
            : disposed.isFullExit
              ? ONE
              : disposed.usesNetDisposal
                ? disposed.disposal.ratio
                : disposed.lpSharesDisposed.div(disposed.lpSharesBefore),
          12
        );
        event._disposedLots = disposed.disposal.lots;
        event._principalTransferred = output(principalTransferred, 12);
        event._cnhPrincipalTransferred = output(cnhPrincipalTransferred, 12);
        event._netSharesTransferred = output(netSharesTransferred, 12);
        event._cnhAmountComputed = output(netCnhAmount, 12);
      }
      totalNAV = totalShares.mul(currentNAV);
      navPerShare = currentNAV;
      event._sharesTransferred = output(sharesTransferred, 12);
      event._navAtTx = output(currentNAV, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);
      event._actualAmount = output(actualAmount, 12);
      event._cnhAmountComputed = event._cnhAmountComputed ?? output(eventCnhAmount, 12);
    } else if (event.type === 'performance_settlement') {
      const settlement = settlePerformance({ event, members, currentNAV, output });
      event._breakdown = settlement.breakdown;
      event._totalFee = output(settlement.totalFee, 2);
      event._feeShares = output(settlement.feeShares, 12);
      totalNAV = totalShares.mul(currentNAV);
      navPerShare = currentNAV;
      event._navAtTx = output(currentNAV, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);
    } else if (event.type === 'performance_settlement_reversal') {
      event._navAtTx = output(navPerShare, 12);
      event._totalSharesAfter = output(totalShares, 12);
      event._totalNAVAfter = output(totalNAV, 12);
    }

    if (verifyLotSummaries) {
      for (const member of Object.values(members)) {
        const actualLpShares = member.lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
        if (!member.lpShares.eq(actualLpShares)) {
          throw new Error(`LP批次汇总不一致：事件 ${event.id}，成员 ${member.id}`);
        }
      }
    }

    if (metrics) {
      const activeLotCount = Object.values(members)
        .reduce((count, member) => count + member.lots.length, 0);
      metrics.finalActiveLotCount = activeLotCount;
      metrics.peakActiveLotCount = Math.max(metrics.peakActiveLotCount, activeLotCount);
    }

    let sp500NAV = 1;
    let ndxNAV = 1;
    let customNAV = null;
    let custom2NAV = null;
    const currentIndices = findIndices(event.date, indexCache, benchmarkClosePolicy);
    const currentCustomEntry = findCustomBenchmarkEntry(event.date, customBenchmarkCache, customBenchmark);
    const currentCustomEntry2 = findCustomBenchmarkEntry(event.date, customBenchmarkCache, customBenchmark2, 1);
    if (currentIndices && Number.isFinite(currentIndices.spx) && Number.isFinite(currentIndices.ndx) && baseSpx && baseNdx) {
      sp500NAV = Number((currentIndices.spx / baseSpx).toFixed(4));
      ndxNAV = Number((currentIndices.ndx / baseNdx).toFixed(4));
    }
    customNAV = calculateCustomBenchmarkValue(currentCustomEntry, baseCustomEntry, customBenchmark);
    custom2NAV = calculateCustomBenchmarkValue(currentCustomEntry2, baseCustomEntry2, customBenchmark2);

    // A reversal is an audit instruction, not an economic event. Keep it in
    // the ledger, but never manufacture a performance-chart point for the
    // reversal timestamp or expose its administrative remark as fund history.
    if (event.type !== 'performance_settlement_reversal') {
      navHistory.push({
        eventId: event.id,
        date: event.date,
        navPerShare: output(navPerShare, 4),
        totalNAV: output(totalNAV, 2),
        totalShares: output(totalShares, 4),
        sp500NAV,
        ndxNAV,
        customNAV,
        custom2NAV,
        spx: currentIndices?.spx ?? null,
        ndx: currentIndices?.ndx ?? null,
        spxPriceDate: currentIndices?.spxPriceDate ?? null,
        ndxPriceDate: currentIndices?.ndxPriceDate ?? null,
        customPriceDate: customEntryPriceDate(currentCustomEntry, customBenchmark),
        custom2PriceDate: customEntryPriceDate(currentCustomEntry2, customBenchmark2),
        type: event.type,
        member: event.member,
        fromMember: event.fromMember,
        toMember: event.toMember,
        amount: event.amount,
        cnhRate: event.cnhRate,
        cnhAmount: event.cnhAmount || event._cnhAmountComputed,
        remark: event.remark
      });

      Object.keys(members).forEach(k => {
        memberHistory[k].push({
          date: event.date,
          shares: output(members[k].shares, 12),
          value: output(members[k].shares.mul(navPerShare), 12)
        });
      });
    }
  });

  const computedMembers = {};
  Object.keys(members).forEach(k => {
    const member = members[k];
    const currentValue = member.shares.mul(navPerShare);
    const profit = currentValue.plus(member.totalWithdraw).minus(member.totalDeposit);
    const profitRate = member.totalDeposit.isZero() ? ZERO : profit.div(member.totalDeposit).mul(100);
    const cnhCurrentValue = currentValue.mul(globalCnhRate);
    const cnhProfit = cnhCurrentValue.plus(member.cnhWithdraw).minus(member.cnhDeposit);
    const cnhProfitRate = member.cnhDeposit.isZero() ? ZERO : cnhProfit.div(member.cnhDeposit).mul(100);
    const lpShares = member.lpShares;
    const ledgerDate = sortedEvents.filter(event => event.type !== 'performance_settlement_reversal').at(-1)?.date;

    computedMembers[k] = {
      name: member.name,
      shares: output(member.shares, 4),
      currentValue: output(currentValue, 2),
      totalDeposit: output(member.totalDeposit, 2),
      totalWithdraw: output(member.totalWithdraw, 2),
      profit: output(profit, 2),
      profitRate: output(profitRate, 2),
      cnhCurrentValue: output(cnhCurrentValue, 2),
      cnhDeposit: output(member.cnhDeposit, 2),
      cnhWithdraw: output(member.cnhWithdraw, 2),
      cnhProfit: output(cnhProfit, 2),
      cnhProfitRate: output(cnhProfitRate, 2)
      ,remainingPrincipal: output(member.remainingPrincipal, 2)
      ,cnhRemainingPrincipal: output(member.cnhRemainingPrincipal, 2)
      ,lpShares: output(lpShares, 12)
      ,gpCarryShares: output(member.carryShares, 12)
      ,lpCurrentValue: output(lpShares.mul(navPerShare), 2)
      ,gpCarryValue: output(member.carryShares.mul(navPerShare), 2)
      ,lpLedger: member.lots.map(lot => ({
        startDate: lot.date,
        shares: output(lot.shares, 12),
        basis: output(lot.basis, 2),
        highWaterNav: output(lot.basis.div(lot.shares), 12),
        hurdle: output(ledgerDate ? hurdleValue(lot, ledgerDate, currentAnnualRate) : lot.basis, 2),
        currentValue: output(lot.shares.mul(navPerShare), 2)
      }))
    };
  });

  const fundProfit = totalNAV.plus(fundExternalWithdraw).minus(fundExternalDeposit);
  const fundProfitRate = fundExternalDeposit.isZero() ? ZERO : fundProfit.div(fundExternalDeposit).mul(100);
  const fundCnhCurrentValue = totalNAV.mul(globalCnhRate);
  const fundCnhProfit = fundCnhCurrentValue.plus(fundExternalCnhWithdraw).minus(fundExternalCnhDeposit);
  const fundCnhProfitRate = fundExternalCnhDeposit.isZero() ? ZERO : fundCnhProfit.div(fundExternalCnhDeposit).mul(100);
  const fundRemainingPrincipal = Object.values(members)
    .reduce((sum, member) => sum.plus(member.remainingPrincipal), ZERO);
  const fundCnhRemainingPrincipal = Object.values(members)
    .reduce((sum, member) => sum.plus(member.cnhRemainingPrincipal), ZERO);
  const fundActiveProfit = totalNAV.minus(fundRemainingPrincipal);
  const fundCnhActiveProfit = fundCnhCurrentValue.minus(fundCnhRemainingPrincipal);
  const fundActiveProfitRate = fundRemainingPrincipal.isZero()
    ? null
    : output(fundActiveProfit.div(fundRemainingPrincipal).mul(100), 2);
  const fundCnhActiveProfitRate = fundCnhRemainingPrincipal.isZero()
    ? null
    : output(fundCnhActiveProfit.div(fundCnhRemainingPrincipal).mul(100), 2);

  return {
    summary: {
      totalNAV: output(totalNAV, 2),
      totalShares: output(totalShares, 4),
      navPerShare: output(navPerShare, 4),
      totalDeposit: output(fundExternalDeposit, 2),
      totalWithdraw: output(fundExternalWithdraw, 2),
      profit: output(fundProfit, 2),
      profitRate: output(fundProfitRate, 2),
      remainingPrincipal: output(fundRemainingPrincipal, 2),
      activeProfit: output(fundActiveProfit, 2),
      activeProfitRate: fundActiveProfitRate,
      cnhRate: output(globalCnhRate, 12),
      cnhTotalNAV: output(fundCnhCurrentValue, 2),
      cnhTotalDeposit: output(fundExternalCnhDeposit, 2),
      cnhTotalWithdraw: output(fundExternalCnhWithdraw, 2),
      cnhProfit: output(fundCnhProfit, 2),
      cnhProfitRate: output(fundCnhProfitRate, 2),
      cnhRemainingPrincipal: output(fundCnhRemainingPrincipal, 2),
      cnhActiveProfit: output(fundCnhActiveProfit, 2),
      cnhActiveProfitRate: fundCnhActiveProfitRate
    },
    members: computedMembers,
    events: sortedEvents,
    settings: {
      benchmarkClosePolicy,
      customBenchmark,
      customBenchmark2,
      benchmarkCacheReady: sortedEvents
        .filter(event => event.type !== 'performance_settlement_reversal')
        .every(event =>
        isUsableIndexEntry(indexCache[event.date], event.date, benchmarkClosePolicy)),
      customBenchmarkCacheReady: !customBenchmark || sortedEvents
        .filter(event => event.type !== 'performance_settlement_reversal')
        .every(event => isUsableCustomEntry(customEntryForSlot(customBenchmarkCache[event.date], 0), event.date, customBenchmark)),
      customBenchmark2CacheReady: !customBenchmark2 || sortedEvents
        .filter(event => event.type !== 'performance_settlement_reversal')
        .every(event => isUsableCustomEntry(customEntryForSlot(customBenchmarkCache[event.date], 1), event.date, customBenchmark2))
    },
    charts: {
      navHistory,
      memberHistory,
      benchmarkAnchors: Object.fromEntries(
        Object.entries(indexCache)
          .filter(([date, entry]) => date.endsWith('-01-01') && isUsableIndexEntry(entry, date, benchmarkClosePolicy))
          .map(([date, entry]) => {
            const customEntry = customEntryForSlot(customBenchmarkCache[date], 0);
            const customEntry2 = customEntryForSlot(customBenchmarkCache[date], 1);
            return [date.slice(0, 4), {
              ...entry,
              customNAV: calculateCustomBenchmarkValue(
                isUsableCustomEntry(customEntry, date, customBenchmark) ? customEntry : null,
                baseCustomEntry,
                customBenchmark
              ),
              customPriceDate: customEntryPriceDate(customEntry, customBenchmark),
              custom2NAV: calculateCustomBenchmarkValue(
                isUsableCustomEntry(customEntry2, date, customBenchmark2) ? customEntry2 : null,
                baseCustomEntry2,
                customBenchmark2
              ),
              custom2PriceDate: customEntryPriceDate(customEntry2, customBenchmark2)
            }];
          })
      )
    }
  };
}

module.exports = {
  calculateStateFromDb,
  calculateCustomBenchmarkValue,
  findCustomBenchmarkEntry
};
