const Decimal = require('decimal.js');
const { hurdleValue, settlePerformance, CURRENT_SETTLEMENT_VERSION } = require('./performance-settlement');
const { disposeMemberPosition } = require('./member-disposal');
const { configuredPerformanceFeeRates } = require('./performance-fee-policy');
const { compareEvents } = require('./event-order');
const { InputError } = require('./api-errors');
const { createDateLookup } = require('./date-lookup');
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
    throw new InputError(`账本在 ${event.date} 的${event.type === 'deposit' ? '入金' : event.type === 'withdraw' ? '出金' : '转让'}前净值为 0，无法计算份额。请删除或修改此前的零估值记录。`);
  }
}

function isUsableIndexEntry(entry, navDate, policy) {
  const isValidSourceDate = sourceDate => sourceDate < navDate;
  return entry &&
    entry.policy === policy &&
    entry.source === 'VOO/QQQM:adjusted-close' &&
    typeof entry.spxPriceDate === 'string' &&
    isValidSourceDate(entry.spxPriceDate) &&
    typeof entry.ndxPriceDate === 'string' &&
    isValidSourceDate(entry.ndxPriceDate) &&
    Number.isFinite(entry.spx) &&
    Number.isFinite(entry.ndx);
}

function findIndices(dateStr, cache, policy, lookup) {
  if (isUsableIndexEntry(cache[dateStr], dateStr, policy)) return cache[dateStr];

  // Never use a later event's cache entry as a fallback: that would leak
  // future market information while the background refresh is still running.
  return lookup.findBefore(dateStr)?.value || null;
}

function findCustomBenchmarkEntry(dateStr, cache, benchmark, slot = 0, lookup) {
  if (!benchmark) return null;
  const exactEntry = customEntryForSlot(cache[dateStr], slot);
  if (isUsableCustomEntry(exactEntry, dateStr, benchmark)) return exactEntry;
  const fallbackLookup = lookup || createDateLookup(cache, (entry, date) =>
    isUsableCustomEntry(customEntryForSlot(entry, slot), date, benchmark));
  const match = fallbackLookup.findBefore(dateStr);
  return match ? customEntryForSlot(match.value, slot) : null;
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
  const validateMemberBalances = options.validateMemberBalances === true;
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
  // Display-only historical snapshots. Reuse them across valuations; only
  // account mutations can change the LP lots' high-water references.
  const highWaterSnapshots = {};
  const memberHighWaterHistory = {};
  function snapshotHighWater(member) {
    let basis = ZERO, shares = ZERO, minNav = null, maxNav = null, lotCount = 0;
    const lots = [];
    for (const lot of member.lots) {
      if (!lot.shares.gt(ZERO)) continue;
      const nav = lot.basis.div(lot.shares);
      basis = basis.plus(lot.basis);
      shares = shares.plus(lot.shares);
      minNav = minNav === null ? nav : Decimal.min(minNav, nav);
      maxNav = maxNav === null ? nav : Decimal.max(maxNav, nav);
      lots.push({
        startDate: lot.date, sourceType: lot.sourceType || 'legacy',
        sourceEventId: lot.sourceEventId || null,
        shares: output(lot.shares, 12), highWaterNav: output(nav, 12),
        basis: output(lot.basis, 2),
        sharesExact: lot.shares.toString(), basisExact: lot.basis.toString()
      });
      lotCount++;
    }
    return shares.isZero() ? null : {
      nav: output(basis.div(shares), 12),
      minNav: output(minNav, 12), maxNav: output(maxNav, 12), lotCount, lots
    };
  }
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
    memberHighWaterHistory[m.id] = [];
  });

  const navHistory = [];
  const exactNavHistory = [];
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
  // Daily adjusted history is the source of truth. Only snapshots explicitly
  // marked with the same benchmark source are eligible as a fallback.
  const indexCache = { ...(db.indexCache || {}), ...materialized.indexCache };
  const customBenchmarkCache = mergeCustomBenchmarkCaches(
    db.customBenchmarkCache,
    materialized.customBenchmarkCache
  );
  const indexLookup = createDateLookup(indexCache,
    (entry, date) => isUsableIndexEntry(entry, date, benchmarkClosePolicy));
  const customLookups = [customBenchmark, customBenchmark2].map((benchmark, slot) =>
    createDateLookup(customBenchmarkCache, (entry, date) => benchmark &&
      isUsableCustomEntry(customEntryForSlot(entry, slot), date, benchmark)));
  let baseSpx = null;
  let baseNdx = null;
  let baseCustomEntry = null;
  let baseCustomEntry2 = null;
  if (sortedEvents.length > 0) {
    const inceptionDate = sortedEvents[0].date;
    const baseIndices = findIndices(inceptionDate, indexCache, benchmarkClosePolicy, indexLookup);
    if (baseIndices) {
      baseSpx = baseIndices.spx;
      baseNdx = baseIndices.ndx;
    }
    baseCustomEntry = findCustomBenchmarkEntry(inceptionDate, customBenchmarkCache, customBenchmark, 0, customLookups[0]);
    baseCustomEntry2 = findCustomBenchmarkEntry(inceptionDate, customBenchmarkCache, customBenchmark2, 1, customLookups[1]);
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

    if (validateMemberBalances) {
      for (const member of Object.values(members)) {
        if ([member.shares, member.lpShares, member.carryShares].some(shares => shares.lt('-0.000001'))) {
          throw new InputError(`${event.date} 的记录会导致成员 ${member.name} 的份额为负，请检查出金、转让及业绩结算金额。`);
        }
      }
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

    let sp500NAV = null;
    let ndxNAV = null;
    let customNAV = null;
    let custom2NAV = null;
    const currentIndices = findIndices(event.date, indexCache, benchmarkClosePolicy, indexLookup);
    const currentCustomEntry = findCustomBenchmarkEntry(event.date, customBenchmarkCache, customBenchmark, 0, customLookups[0]);
    const currentCustomEntry2 = findCustomBenchmarkEntry(event.date, customBenchmarkCache, customBenchmark2, 1, customLookups[1]);
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
      exactNavHistory.push(navPerShare);
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

      const changedMembers = event.type === 'performance_settlement'
        ? Object.keys(members)
        : event.type === 'transfer' ? [event.fromMember, event.toMember]
        : ['deposit', 'withdraw'].includes(event.type) ? [event.member] : [];
      changedMembers.forEach(id => {
        if (!members[id]) return;
        const snapshot = snapshotHighWater(members[id]);
        const { lots = [], ...summary } = snapshot || {};
        highWaterSnapshots[id] = snapshot ? summary : null;
        // Keep full lot detail once per mutation, rather than duplicating it
        // into every valuation point in the API response.
        memberHighWaterHistory[id].push({ eventIndex: navHistory.length - 1, lots });
      });
      Object.keys(members).forEach(k => {
        memberHistory[k].push({
          date: event.date,
          shares: output(members[k].shares, 12),
          value: output(members[k].shares.mul(navPerShare), 12),
          highWater: highWaterSnapshots[k] || null
        });
      });
    }
  });

  const potentialFeeAsOf = options.asOf || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => part.value).join('-');
  const estimateIndex = navHistory.findLastIndex(point => point.date <= potentialFeeAsOf);
  const estimateNAV = exactNavHistory[estimateIndex];
  const potentialFeeRates = configuredPerformanceFeeRates(db.performanceFee);
  const memberPotentialFees = {};
  Object.keys(members).forEach(id => {
    if (!estimateNAV?.gt(ZERO)) return;
    const sourceLots = memberHighWaterHistory[id].findLast(point => point.eventIndex <= estimateIndex)?.lots || [];
    const lots = sourceLots.map(lot => ({
      shares: decimal(lot.sharesExact), basis: decimal(lot.basisExact),
      date: lot.startDate, sourceType: lot.sourceType, sourceEventId: lot.sourceEventId
    }));
    const shares = lots.reduce((sum, lot) => sum.plus(lot.shares), ZERO);
    // Run the authoritative settlement algorithm on isolated copies only.
    // No ledger event is added and the replayed accounts are never mutated.
    const preview = settlePerformance({
      event: { id: 'statement-estimate', date: potentialFeeAsOf, gpMember: 'estimate-gp',
        lpMembers: ['estimate-lp'], ...potentialFeeRates, algorithmVersion: CURRENT_SETTLEMENT_VERSION },
      members: {
        'estimate-lp': { id: 'estimate-lp', shares, lpShares: shares, carryShares: ZERO, lots },
        'estimate-gp': { id: 'estimate-gp', shares: ZERO, lpShares: ZERO, carryShares: ZERO, lots: [] }
      },
      currentNAV: estimateNAV, output
    }).breakdown[0];
    memberPotentialFees[id] = {
      asOf: potentialFeeAsOf, ...potentialFeeRates,
      amount: preview?.fee || 0, lots: preview?.lots || [],
      valuationDate: navHistory.slice(0, estimateIndex + 1).findLast(point => point.type === 'valuation')?.date || null
    };
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
      memberHighWaterHistory,
      memberPotentialFees,
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
