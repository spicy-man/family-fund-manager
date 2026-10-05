const { registerTransactionRoutes } = require('./transactions');
const { registerSettlementRoutes } = require('./settlements');
const { registerMemberRoutes } = require('./members');
const { registerTickerRoutes } = require('./tickers');
const { registerSettingsRoutes } = require('./settings');
const { registerCustomBenchmarkRoutes } = require('./custom-benchmark');
const { registerBackupRoutes } = require('./backup');
const { nextSequenceNumber } = require('../lib/event-order');
const { InputError, ConflictError } = require('../lib/api-errors');

function registerApiRoutes(app, deps) {
  const resolvedDeps = {
    ...deps,
    readSettlements: deps.readSettlements ?? (() => ({ version: 1, records: [] })),
    writeSettlements: deps.writeSettlements ?? (() => {}),
    now: deps.now ?? (() => new Date())
  };
  const { calculateStateFromDb, isValidDate, now: getNow } = resolvedDeps;

  const BALANCE_TOLERANCE = 0.000001;
  let lastIssuedEventSequence = 0;

  function toFiniteNumber(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return NaN;
    if (typeof value === 'string' && value.trim() === '') return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function isSundayDate(date) {
    if (!isValidDate(date)) return false;
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day === 0;
  }

  function latestValuationDate(now = getNow()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
    }).formatToParts(now);
    const values = {};
    parts.forEach(part => { values[part.type] = part.value; });
    const cursor = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
    const minutes = Number(values.hour) * 60 + Number(values.minute);
    if (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6 || minutes < 4 * 60 + 5) {
      do {
        cursor.setUTCDate(cursor.getUTCDate() - 1);
      } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
    }
    return cursor.toISOString().slice(0, 10);
  }

  function validateValuationDate(date) {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) return '估值日期必须为周一至周五的交易日。';
    const latest = latestValuationDate();
    return date <= latest ? null : `美东时间04:05后才开放当日估值；当前最晚可选择 ${latest}。`;
  }

  function rejectFutureSettlementDate(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(getNow());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const today = `${values.year}-${values.month}-${values.day}`;
    if (date > today) throw new InputError(`结算日期不能晚于今天（北京时间 ${today}）。`);
  }

  // The calculator caps underfunded replay events for display safety. Before
  // persisting a mutation, reject any ledger where requested and settled amounts
  // would differ instead.
  function calculateLedgerState(db, options = {}) {
    const validationDb = JSON.parse(JSON.stringify(db));
    return calculateStateFromDb(validationDb, {
      includeDisposalLotDetails: false,
      validateMemberBalances: true,
      ...options
    });
  }

  function findLedgerIssue(db, validationState = calculateLedgerState(db)) {
    const valuationWithoutShares = validationState.events.find(event =>
      event.type === 'valuation' && event._hasSharesAtValuation === false
    );
    if (valuationWithoutShares) return { type: 'valuation_without_shares', event: valuationWithoutShares };

    const insufficientBalance = validationState.events.find(event =>
      (event.type === 'withdraw' || event.type === 'transfer') &&
      (event._fullExit && event._accountValueBefore !== undefined
        ? event._accountValueBefore
        : (event._grossAmount ?? event._actualAmount)) + BALANCE_TOLERANCE < event.amount
    );
    const unpaidFee = validationState.events.find(event =>
      (event.type === 'withdraw' || event.type === 'transfer') &&
      (event._unpaidPerformanceFeeShares || 0) > BALANCE_TOLERANCE
    );
    if (unpaidFee) return { type: 'performance_fee_balance', event: unpaidFee };
    return insufficientBalance ? { type: 'insufficient_balance', event: insufficientBalance } : null;
  }

  function rejectLedgerIssue(issue) {
    const { event } = issue;
    if (issue.type === 'valuation_without_shares') {
      throw new InputError(`估值日期 ${event.date} 当时尚无基金份额，请先在该日期之前录入首次入金。`);
    }
    if (issue.type === 'performance_fee_balance') {
      throw new InputError(`${event.date} 的${event.type === 'withdraw' ? '出金' : '转让'}需要额外结算业绩报酬，但LP剩余份额不足。请降低金额后重试。`);
    }
    throw new InputError(`操作会导致历史${event.type === 'withdraw' ? '出金' : '转让'}余额不足：${event.date} 的记录要求 $${event.amount.toFixed(2)}，实际仅可结算 $${event._actualAmount.toFixed(2)}。`);
  }
  function latestSettlementDate(db) {
    return db.events.filter(event => event.type === 'performance_settlement')
      .map(event => event.date).sort().at(-1) || null;
  }

  function rejectLockedPeriod(db, date) {
    const lockedThrough = latestSettlementDate(db);
    if (!lockedThrough || date > lockedThrough) return false;
    throw new ConflictError(`账目已结算锁定至 ${lockedThrough}，不能变更该日期以前的记录。`);
  }

  function peekEventSequence(db, ledger = resolvedDeps.readSettlements()) {
    const persistedNext = nextSequenceNumber(db.events, ledger.records);
    const dbHighWater = db.lastEventSequence ?? 0;
    const ledgerHighWater = ledger.lastEventSequence ?? 0;
    if (lastIssuedEventSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error('事件顺序号已达到安全整数上限，无法继续创建事件。');
    }
    if (!Number.isSafeInteger(dbHighWater) || dbHighWater < 0 ||
        !Number.isSafeInteger(ledgerHighWater) || ledgerHighWater < 0) {
      throw new Error('事件顺序号高水位无效。');
    }
    const persistedHighWater = Math.max(dbHighWater, ledgerHighWater);
    if (persistedHighWater >= Number.MAX_SAFE_INTEGER) {
      throw new Error('事件顺序号高水位无效或已耗尽。');
    }
    return Math.max(persistedNext, persistedHighWater + 1, lastIssuedEventSequence + 1);
  }

  function commitEventSequence(sequenceNumber) {
    if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber <= 0) {
      throw new Error('拒绝提交无效的事件顺序号。');
    }
    lastIssuedEventSequence = Math.max(lastIssuedEventSequence, sequenceNumber);
  }

  const utils = {
    BALANCE_TOLERANCE, toFiniteNumber, isSundayDate, latestValuationDate,
    validateValuationDate, calculateLedgerState, findLedgerIssue,
    rejectLedgerIssue, latestSettlementDate, rejectLockedPeriod,
    rejectFutureSettlementDate,
    peekEventSequence, commitEventSequence
  };

  registerTransactionRoutes(app, resolvedDeps, utils);
  registerSettlementRoutes(app, resolvedDeps, utils);
  const tickerUtils = registerTickerRoutes(app, resolvedDeps);
  registerSettingsRoutes(app, resolvedDeps, utils);
  registerCustomBenchmarkRoutes(app, resolvedDeps);
  registerBackupRoutes(app, resolvedDeps, utils, tickerUtils);
  registerMemberRoutes(app, resolvedDeps);
}

module.exports = { registerApiRoutes };
