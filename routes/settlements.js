const { CURRENT_SETTLEMENT_VERSION } = require('../lib/performance-settlement');
const { createSettlementFeeSnapshot } = require('../lib/performance-fee-policy');
const { compareEvents } = require('../lib/event-order');
const { InputError, NotFoundError, handleApiError } = require('../lib/api-errors');

function registerSettlementRoutes(app, deps, utils) {
  const { readDb, readSettlements, writeSettlements, calculateStateFromDb,
    isValidDate, normalizeRemark, randomUUID, now: getNow } = deps;
  const { findLedgerIssue, rejectLedgerIssue, latestSettlementDate,
    peekEventSequence, commitEventSequence, rejectFutureSettlementDate } = utils;

function buildSettlementPreview(db, body) {
  const gpMember = db.performanceFee?.gpMemberId;
  const { date } = body;
  if (!isValidDate(date)) throw new InputError('结算日期必须是有效的 YYYY-MM-DD。');
  rejectFutureSettlementDate(date);
  const settledThrough = latestSettlementDate(db);
  if (settledThrough && date <= settledThrough) {
    throw new InputError(`业绩结算已完成至 ${settledThrough}，新结算日期必须晚于该日期。`);
  }
  const gp = db.members.find(member => member.id === gpMember);
  if (!gp || gp.roles?.gp !== true) throw new InputError('请先在成员设置中指定GP。');
  if (db.events.some(event => event.type === 'performance_settlement' && event.date === date)) {
    throw new InputError('该日期已经完成过业绩结算。');
  }
  const valuationDate = db.events
    .filter(event => event.type === 'valuation' && event.date <= date)
    .map(event => event.date).sort().at(-1);
  if (!valuationDate) throw new InputError('结算日以前没有可用的基金估值。');
  const feeRates = createSettlementFeeSnapshot(db.performanceFee);
  const previewDb = JSON.parse(JSON.stringify(db));
  const event = {
    id: 'preview_settlement', type: 'performance_settlement', date, gpMember,
    lpMembers: db.members.map(member => member.id),
    algorithmVersion: CURRENT_SETTLEMENT_VERSION,
    ...feeRates, remark: normalizeRemark(body.remark, '年度业绩结算'),
    createdAt: Number.MAX_SAFE_INTEGER,
    sequenceNumber: peekEventSequence(db)
  };
  previewDb.events.push(event);
  const state = calculateStateFromDb(previewDb);
  const computed = state.events.find(item => item.id === event.id);
  return { event, breakdown: computed._breakdown, totalFee: computed._totalFee, feeShares: computed._feeShares, navPerShare: computed._navAtTx, valuationDate };
}

app.post('/api/performance-settlement/preview', (req, res, next) => {
  try {
    res.json({ success: true, data: buildSettlementPreview(readDb(), req.body || {}) });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

app.post('/api/performance-settlement', (req, res, next) => {
  try {
    const db = readDb();
    const preview = buildSettlementPreview(db, req.body || {});
    const ledger = readSettlements();
    const event = {
      ...preview.event,
      id: 'settle_' + randomUUID(),
      createdAt: Date.now(),
      sequenceNumber: peekEventSequence(db, ledger)
    };
    db.events.push(event);
    const savedState = calculateStateFromDb(JSON.parse(JSON.stringify(db)));
    const saved = savedState.events.find(item => item.id === event.id);
    event.snapshot = { breakdown: saved._breakdown, totalFee: saved._totalFee, feeShares: saved._feeShares, navPerShare: saved._navAtTx };
    const ledgerIssue = findLedgerIssue(db);
    if (ledgerIssue) rejectLedgerIssue(ledgerIssue);
    ledger.records.push(event);
    ledger.lastEventSequence = event.sequenceNumber;
    writeSettlements(ledger);
    commitEventSequence(event.sequenceNumber);
    res.json({ success: true, message: '业绩结算已确认，历史账期已锁定。', data: event });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

app.post('/api/performance-settlement/reverse-latest', (req, res, next) => {
  try {
    const ledger = readSettlements();
    const reversedIds = new Set(ledger.records
      .filter(record => record.type === 'performance_settlement_reversal')
      .map(record => record.settlementId));
    const latest = ledger.records
      .filter(record => record.type === 'performance_settlement' && !reversedIds.has(record.id))
      .sort(compareEvents)
      .at(-1);
    if (!latest) throw new NotFoundError('当前没有可以撤销的有效结算。');

    const projectedDb = readDb();
    projectedDb.events = projectedDb.events.filter(event => event.id !== latest.id);
    const issue = findLedgerIssue(projectedDb);
    if (issue) rejectLedgerIssue(issue);

    const reversal = {
      id: 'settle_reversal_' + randomUUID(),
      type: 'performance_settlement_reversal',
      settlementId: latest.id,
      settlementDate: latest.date,
      date: getNow().toISOString().slice(0, 10),
      remark: normalizeRemark(req.body?.remark, '撤销最近一次业绩结算'),
      createdAt: Date.now(),
      sequenceNumber: peekEventSequence(projectedDb, ledger)
    };
    ledger.records.push(reversal);
    ledger.lastEventSequence = reversal.sequenceNumber;
    writeSettlements(ledger);
    commitEventSequence(reversal.sequenceNumber);
    res.json({ success: true, message: `已冲销 ${latest.date} 的业绩结算并解除相应锁账。`, data: reversal });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

}

module.exports = { registerSettlementRoutes };
