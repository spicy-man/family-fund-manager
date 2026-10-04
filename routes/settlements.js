const { CURRENT_SETTLEMENT_VERSION } = require('../lib/performance-settlement');
const { createSettlementFeeSnapshot } = require('../lib/performance-fee-policy');
const { compareEvents } = require('../lib/event-order');
const { createHmac, randomBytes, timingSafeEqual } = require('crypto');
const { InputError, NotFoundError, ConflictError, handleApiError } = require('../lib/api-errors');

function registerSettlementRoutes(app, deps, utils) {
  const { readDb, readSettlements, writeSettlements, calculateStateFromDb,
    isValidDate, normalizeRemark, randomUUID, now: getNow } = deps;
  const { findLedgerIssue, rejectLedgerIssue, latestSettlementDate,
    peekEventSequence, commitEventSequence, rejectFutureSettlementDate } = utils;

const previewSecret = randomBytes(32);
function previewToken(db, ledger, preview) {
  // Include reversal history so previews cannot survive a settle/reverse cycle.
  // Financial inputs and the reviewed result are bound; market caches are not.
  return createHmac('sha256', previewSecret).update(JSON.stringify({
    members: db.members, events: db.events, performanceFee: db.performanceFee,
    lastEventSequence: db.lastEventSequence, ledger, preview
  })).digest('hex');
}

function buildSettlementPreview(db, body, ledger) {
  const gpMember = db.performanceFee?.gpMemberId;
  if (body.gpMember !== undefined && body.gpMember !== gpMember) {
    throw new ConflictError('GP已变化，请刷新页面并重新预览业绩结算。');
  }
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
  const eventIds = new Set(db.events.map(event => event.id));
  let previewId = 'preview_settlement';
  for (let suffix = 1; eventIds.has(previewId); suffix++) previewId = 'preview_settlement_' + suffix;
  const event = {
    id: previewId, type: 'performance_settlement', date, gpMember,
    lpMembers: db.members.map(member => member.id),
    algorithmVersion: CURRENT_SETTLEMENT_VERSION,
    ...feeRates, remark: normalizeRemark(body.remark, '年度业绩结算'),
    createdAt: Number.MAX_SAFE_INTEGER,
    sequenceNumber: peekEventSequence(db, ledger)
  };
  previewDb.events.push(event);
  const state = calculateStateFromDb(previewDb);
  const computed = state.events.find(item => item.id === event.id && item.type === event.type && item.date === date);
  return { event, breakdown: computed._breakdown, totalFee: computed._totalFee, feeShares: computed._feeShares, navPerShare: computed._navAtTx, valuationDate };
}

app.post('/api/performance-settlement/preview', (req, res, next) => {
  try {
    const db = readDb();
    const ledger = readSettlements();
    const preview = buildSettlementPreview(db, req.body || {}, ledger);
    res.json({ success: true, data: { ...preview, previewToken: previewToken(db, ledger, preview) } });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

app.post('/api/performance-settlement', (req, res, next) => {
  try {
    const db = readDb();
    const ledger = readSettlements();
    const preview = buildSettlementPreview(db, req.body || {}, ledger);
    const token = req.body?.previewToken;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
        !timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(previewToken(db, ledger, preview), 'hex'))) {
      throw new ConflictError('结算预览已失效或账本已变化，请重新预览后确认。');
    }
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
    const settlementId = req.body?.settlementId;
    if (typeof settlementId !== 'string' || !settlementId) {
      throw new InputError('请指定要冲销的结算记录，并刷新页面后重试。');
    }
    const ledger = readSettlements();
    const target = ledger.records.find(record => record.type === 'performance_settlement' && record.id === settlementId);
    if (!target) throw new NotFoundError('未找到要冲销的结算记录，请刷新页面。');
    const existingReversal = ledger.records.find(record =>
      record.type === 'performance_settlement_reversal' && record.settlementId === settlementId);
    if (existingReversal) {
      return res.json({ success: true, message: '该结算已冲销，未变更其他账期。', data: existingReversal });
    }
    const reversedIds = new Set(ledger.records
      .filter(record => record.type === 'performance_settlement_reversal')
      .map(record => record.settlementId));
    const latest = ledger.records
      .filter(record => record.type === 'performance_settlement' && !reversedIds.has(record.id))
      .sort(compareEvents)
      .at(-1);
    if (!latest) throw new NotFoundError('当前没有可以撤销的有效结算。');
    if (latest.id !== settlementId) throw new ConflictError('最近一笔结算已变化，只能倒序冲销，请刷新页面。');

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
