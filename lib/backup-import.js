const { inflateRawSync } = require('zlib');
const AdmZip = require('adm-zip');
const { InputError } = require('./api-errors');
const {
  DEFAULT_ANNUAL_RATE,
  DEFAULT_FEE_RATE,
  configuredPerformanceFeeRates,
  isValidPerformanceFeeRates,
  isValidDisposalFeeSnapshot
} = require('./performance-fee-policy');
const {
  SUPPORTED_SETTLEMENT_VERSIONS,
  mergeSettlementLedger,
  migrateSettlementLedger,
  activeSettlementRecords
} = require('./settlement-ledger');
const { hasSequenceNumber, maxSequenceNumber, migrateEventSequences } = require('./event-order');
const { TICKER_PATTERN, normalizeCustomBenchmark } = require('./custom-benchmark');

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_EVENTS = 10000;
const MEMBER_ID_IMPORT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_FIELDS_BY_TYPE = {
  deposit: ['member', 'amount', 'cnhAmount'],
  withdraw: ['member', 'amount', 'cnhAmount'],
  valuation: ['totalNAV'],
  transfer: ['fromMember', 'toMember', 'amount', 'cnhRate', 'cnhAmount'],
  performance_settlement: ['gpMember', 'annualRate', 'feeRate', 'algorithmVersion', 'lpMembers'],
  performance_settlement_reversal: ['settlementId', 'settlementDate']
};

const pick = (value, fields) => Object.fromEntries(fields
  .filter(field => Object.prototype.hasOwnProperty.call(value, field))
  .map(field => [field, value[field]]));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const reject = message => { throw new InputError(message); };

// Use our own budget while inflating; the archive's declared size is untrusted.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function readBackupEntry(entry, remaining) {
  if (entry.isDirectory || entry.header.encrypted || ![0, 8].includes(entry.header.method)) {
    reject('备份包含目录、加密文件或不支持的压缩格式。');
  }
  if (!Number.isSafeInteger(entry.header.size) || entry.header.size < 0 || entry.header.size > remaining || remaining <= 0) {
    reject('ZIP 内的数据文件过大（最大 10MB）。');
  }
  let data;
  try {
    const compressed = entry.getCompressedData();
    if (compressed.length !== entry.header.compressedSize) throw new Error('Truncated entry');
    if (entry.header.method === 0) {
      if (compressed.length > remaining) reject('ZIP 内的数据文件过大（最大 10MB）。');
      data = compressed;
    } else {
      data = inflateRawSync(compressed, { maxOutputLength: remaining });
    }
    if (data.length !== entry.header.size || crc32(data) !== entry.header.crc) throw new Error('Invalid size or CRC');
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error.code === 'ERR_BUFFER_TOO_LARGE') reject('ZIP 内的数据文件过大（最大 10MB）。');
    reject('ZIP 中的数据文件损坏（大小或校验和不匹配）。');
  }
  return data;
}

function validateSnapshotNumbers(value, fields) {
  for (const field of fields) {
    if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isFinite(value[field]))) {
      reject('结算记录的锁定快照包含无效数值。');
    }
  }
}

function normalizeSnapshot(snapshot, memberIds, isValidDate) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.breakdown)) reject('结算记录的锁定快照格式无效。');
  validateSnapshotNumbers(snapshot, ['totalFee', 'feeShares', 'navPerShare']);
  const result = pick(snapshot, ['totalFee', 'feeShares', 'navPerShare']);
  result.breakdown = snapshot.breakdown.map(item => {
    if (!isObject(item) || !Array.isArray(item.lots)) reject('结算记录的锁定快照明细格式无效。');
    if (!memberIds.has(item.member)) reject('结算快照引用了无效成员。');
    validateSnapshotNumbers(item, ['valueBefore', 'hurdle', 'excess', 'fee', 'feeShares', 'sharesBefore', 'sharesAfter']);
    const normalized = pick(item, ['member', 'valueBefore', 'hurdle', 'excess', 'fee', 'feeShares', 'sharesBefore', 'sharesAfter']);
    normalized.lots = item.lots.map(lot => {
      if (!isObject(lot)) reject('结算记录的锁定快照批次格式无效。');
      // V1 keeps exhausted audit lots; their 0/0 entry NAV was serialized as
      // null. Preserve that legacy shape so genuine backups can be replayed.
      const emptyLegacyNav = lot.entryNav === null && lot.shares === 0 && lot.basis === 0;
      validateSnapshotNumbers(lot, ['holdingDays', 'basis', ...(!emptyLegacyNav ? ['entryNav'] : []),
        'shares', 'currentValue', 'hurdle', 'aboveHurdle', 'fee', 'feeShares']);
      if ((lot.sourceEventId !== undefined && typeof lot.sourceEventId !== 'string') ||
          (lot.sourceType !== undefined && typeof lot.sourceType !== 'string') ||
          (lot.startDate !== undefined && !isValidDate(lot.startDate))) reject('结算快照包含无效批次信息。');
      return pick(lot, ['sourceEventId', 'sourceType', 'startDate', 'holdingDays', 'basis', 'entryNav', 'shares', 'currentValue', 'hurdle', 'aboveHurdle', 'fee', 'feeShares']);
    });
    return normalized;
  });
  return result;
}

function normalizeImportedEvent(event, memberIds, normalizeRemark, isValidDate, { seenIds, settlementOnly = false } = {}) {
  const invalidRecordMessage = settlementOnly ? '独立结算账本包含无效或重复记录。' : '导入的数据中存在格式不完整的事件项';
  if (!isObject(event)) reject(invalidRecordMessage);
  if (typeof event.id !== 'string' || !EVENT_ID_PATTERN.test(event.id) || (seenIds && seenIds.has(event.id)) ||
      !event.type || !event.date || !Number.isFinite(event.createdAt) ||
      (event.sequenceNumber !== undefined && !hasSequenceNumber(event))) {
    reject(invalidRecordMessage);
  }
  if (!Object.prototype.hasOwnProperty.call(EVENT_FIELDS_BY_TYPE, event.type)) {
    reject(settlementOnly ? '独立结算账本包含无效或重复记录。' : `导入数据中包含非法事件类型: ${event.type}`);
  }
  if (settlementOnly && !['performance_settlement', 'performance_settlement_reversal'].includes(event.type)) {
    reject('独立结算账本包含无效或重复记录。');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date)) {
    reject(settlementOnly ? '独立结算账本包含无效或重复记录。' : `导入数据中包含非法日期格式: ${event.date}`);
  }
  if (!isValidDate(event.date)) {
    reject(settlementOnly ? '独立结算账本包含无效或重复记录。' : `导入数据中包含无效的日历日期: ${event.date}`);
  }

  if (event.type === 'deposit' || event.type === 'withdraw') {
    if (!positive(event.amount)) reject(`导入数据中存在非法金额: ${event.amount}`);
    if (!memberIds.has(event.member)) reject('交易记录引用了不存在的家庭成员。');
    if (event.cnhAmount !== undefined && !positive(event.cnhAmount)) reject('出入金记录中包含非法人民币金额。');
  } else if (event.type === 'valuation') {
    if (!positive(event.totalNAV)) reject(`导入数据中存在非法估值金额: ${event.totalNAV}`);
  } else if (event.type === 'transfer') {
    if (!positive(event.amount)) reject(`导入数据中存在非法划转金额: ${event.amount}`);
    if (!memberIds.has(event.fromMember) || !memberIds.has(event.toMember) || event.fromMember === event.toMember ||
        (event.cnhRate !== undefined && !positive(event.cnhRate))) {
      reject('划转记录包含无效的成员引用或受让汇率。');
    }
    if (event.cnhAmount !== undefined && !positive(event.cnhAmount)) reject('划转记录中包含非法人民币金额。');
  } else if (event.type === 'performance_settlement') {
    if (!memberIds.has(event.gpMember) || !isValidPerformanceFeeRates(event)) {
      reject(settlementOnly ? '独立结算账本包含无效的结算参数。' : '业绩结算记录包含无效的GP或费率参数。');
    }
  }

  const result = pick(event, ['id', 'type', 'date', 'createdAt', 'sequenceNumber']);
  // Keep absent remarks absent for legacy round trips; supplied remarks use the
  // same type, trimming and length policy as normal transaction writes.
  if (event.remark !== undefined) result.remark = normalizeRemark(event.remark);
  Object.assign(result, pick(event, EVENT_FIELDS_BY_TYPE[event.type]));

  if (event.type === 'withdraw' || event.type === 'transfer') {
    if (event.fullExit !== undefined && typeof event.fullExit !== 'boolean') reject('fullExit 必须为布尔值。');
    if (event.requestedGrossAmount !== undefined && !positive(event.requestedGrossAmount)) reject('requestedGrossAmount 必须为有效正数。');
    Object.assign(result, pick(event, ['fullExit', 'requestedGrossAmount']));
    if (event.performanceFee !== undefined) {
      if (!isObject(event.performanceFee) || !isValidDisposalFeeSnapshot(event.performanceFee, memberIds)) {
        reject('部分退出记录包含无效的业绩结算参数快照。');
      }
      result.performanceFee = pick(event.performanceFee, ['gpMember', 'annualRate', 'feeRate', 'disposalVersion']);
    }
  }
  if (event.type === 'performance_settlement') {
    if (event.lpMembers !== undefined && (!Array.isArray(event.lpMembers) ||
        event.lpMembers.some(id => !memberIds.has(id)) || new Set(event.lpMembers).size !== event.lpMembers.length)) {
      reject('结算记录的 lpMembers 必须为不重复的有效成员列表。');
    }
    if (event.algorithmVersion !== undefined && !SUPPORTED_SETTLEMENT_VERSIONS.includes(event.algorithmVersion)) {
      reject('结算记录的算法版本无效。');
    }
    result.snapshot = normalizeSnapshot(event.snapshot, memberIds, isValidDate);
  }
  if (event.type === 'performance_settlement_reversal' && event.settlementDate !== undefined && !isValidDate(event.settlementDate)) {
    reject('冲销记录的结算日期无效。');
  }
  if (seenIds) seenIds.add(result.id);
  return result;
}

function validateImportedIndexCache(indexCache, existingCache, isValidDate) {
  if (!isObject(indexCache)) reject('备份中的指数缓存格式无效。');
  const normalizedCache = {};
  for (const [date, record] of Object.entries(indexCache)) {
    if (!isValidDate(date) || !isObject(record) ||
        !positive(record.spx) || !positive(record.ndx) ||
        ['spxPriceDate', 'ndxPriceDate'].some(key => record[key] !== undefined && !isValidDate(record[key])) ||
        ['policy', 'source'].some(key => record[key] !== undefined && typeof record[key] !== 'string')) {
      reject('备份中的指数缓存包含无效日期或价格。');
    }
    normalizedCache[date] = pick(record, ['spx', 'ndx', 'spxPriceDate', 'ndxPriceDate', 'policy', 'source']);
  }
  return { ...(existingCache || {}), ...normalizedCache };
}

function prepareBackupRestore(buffer, {
  currentDb,
  restoreSharedSettings = true,
  isValidDate,
  normalizeRemark,
  toFiniteNumber,
  findLedgerIssue,
  rejectLedgerIssue,
  rejectFutureSettlementDate
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    reject('请选择有效的 ZIP 备份文件。');
  }

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (_) {
    reject('备份文件不是有效的 ZIP 压缩包。');
  }

  const dbEntry = zip.getEntry('data/db.json') || zip.getEntry('db.json');
  const configEntry = zip.getEntry('data/config.json') || zip.getEntry('config.json');
  const settlementsEntry = zip.getEntry('data/settlements.json') || zip.getEntry('settlements.json');
  if (!dbEntry || !configEntry || dbEntry.isDirectory || configEntry.isDirectory) {
    reject('ZIP 中必须包含 data/db.json 和 data/config.json。');
  }
  const entries = [dbEntry, configEntry, ...(settlementsEntry ? [settlementsEntry] : [])];
  let remaining = MAX_BACKUP_BYTES;
  const buffers = entries.map(entry => {
    const data = readBackupEntry(entry, remaining);
    remaining -= data.length;
    return data;
  });

  let backupDb;
  let backupConfig;
  let backupSettlements = { version: 1, records: [] };
  try {
    backupDb = JSON.parse(buffers[0].toString('utf8'));
    backupConfig = JSON.parse(buffers[1].toString('utf8'));
    if (settlementsEntry) backupSettlements = JSON.parse(buffers[2].toString('utf8'));
  } catch (_) {
    reject('ZIP 中的 JSON 数据损坏或无法解析。');
  }

  const { members, cnhRate, indexCache, performanceFee,
    lastEventSequence: importedDbHighWater } = backupDb || {};
  const rawEvents = backupDb?.events;
  if (!Array.isArray(rawEvents)) {
    reject('导入的数据格式不正确，缺少 events 数组');
  }

  const importedMembers = Array.isArray(members) ? members : currentDb.members;
  if (!Array.isArray(importedMembers) || importedMembers.length < 1 || importedMembers.length > 100) {
    reject('备份中的成员数量必须在 1 到 100 人之间。');
  }
  const memberIds = new Set();
  for (const member of importedMembers) {
    if (!member || typeof member.id !== 'string' || !MEMBER_ID_IMPORT_PATTERN.test(member.id) ||
        typeof member.name !== 'string' || member.name.trim().length < 1 || member.name.trim().length > 50 ||
        memberIds.has(member.id)) {
      reject('备份中的成员编号或姓名无效或重复。');
    }
    memberIds.add(member.id);
  }

  if (rawEvents.length > MAX_IMPORT_EVENTS) {
    reject(`导入事件数量超限（最大 ${MAX_IMPORT_EVENTS} 条）`);
  }
  if (importedDbHighWater !== undefined &&
      (!Number.isSafeInteger(importedDbHighWater) || importedDbHighWater < 0)) {
    reject('备份中的事件顺序号高水位无效。');
  }

  const seenEventIds = new Set();
  const normalizedEvents = rawEvents.map(event =>
    normalizeImportedEvent(event, memberIds, normalizeRemark, isValidDate, { seenIds: seenEventIds })
  );

  let importedCnhRate = currentDb.cnhRate;
  if (cnhRate !== undefined) {
    importedCnhRate = toFiniteNumber(cnhRate);
    if (!Number.isFinite(importedCnhRate) || importedCnhRate <= 0) {
      reject('导入数据中的汇率参数必须大于 0');
    }
  }

  const importedIndexCache = restoreSharedSettings && indexCache !== undefined
    ? validateImportedIndexCache(indexCache, currentDb.indexCache, isValidDate)
    : (currentDb.indexCache || {});

  let importedFeeRates;
  try {
    importedFeeRates = configuredPerformanceFeeRates(performanceFee || {
      annualRate: DEFAULT_ANNUAL_RATE,
      feeRate: DEFAULT_FEE_RATE
    });
  } catch (error) {
    reject(error.message);
  }
  if (performanceFee?.gpMemberId != null && !memberIds.has(performanceFee.gpMemberId)) {
    reject('备份中的 performanceFee.gpMemberId 引用了不存在的成员。');
  }
  const importedGpMemberId = performanceFee?.gpMemberId ?? null;
  const db = {
    members: importedMembers.map(member => ({
      id: member.id,
      name: member.name.trim(),
      roles: { lp: true, gp: member.id === importedGpMemberId }
    })),
    events: normalizedEvents.filter(event =>
      event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal'),
    benchmarkClosePolicy: 'previous',
    performanceFee: {
      gpMemberId: importedGpMemberId,
      ...importedFeeRates
    }
  };

  if (!backupConfig || !Array.isArray(backupConfig.tickers) || backupConfig.tickers.length < 1) {
    reject('备份中的标的配置无效（至少需要 1 个标的）。');
  }
  if (settlementsEntry) {
    if (backupSettlements?.version !== 1 || !Array.isArray(backupSettlements.records) ||
        (backupSettlements.lastEventSequence !== undefined &&
         (!Number.isSafeInteger(backupSettlements.lastEventSequence) || backupSettlements.lastEventSequence < 0))) {
      reject('备份中的独立结算账本格式无效。');
    }
    if (normalizedEvents.length + backupSettlements.records.length > MAX_IMPORT_EVENTS) {
      reject(`导入事件数量超限（最大 ${MAX_IMPORT_EVENTS} 条）`);
    }
    const settlementIds = new Set(db.events.map(event => event.id));
    backupSettlements = {
      ...backupSettlements,
      records: backupSettlements.records.map(record =>
        normalizeImportedEvent(record, memberIds, normalizeRemark, isValidDate, {
          seenIds: settlementIds,
          settlementOnly: true
        })
      )
    };
  } else {
    // Keep object references shared with normalizedEvents so legacy sequence
    // migration retains exact interleaving before splitting the ledgers.
    backupSettlements = {
      version: 1,
      records: normalizedEvents.filter(event =>
        event.type === 'performance_settlement' || event.type === 'performance_settlement_reversal')
    };
  }

  for (const record of backupSettlements.records) {
    if (record.type === 'performance_settlement_reversal' &&
        (typeof record.settlementId !== 'string' ||
         !backupSettlements.records.some(item => item.id === record.settlementId && item.type === 'performance_settlement'))) {
      reject('独立结算账本包含无效的冲销引用。');
    }
  }
  // Restores must enforce the same date limit as new settlements. Reversed
  // records remain audit history and do not lock or affect the active ledger.
  for (const record of activeSettlementRecords(backupSettlements.records)) {
    if (record.type === 'performance_settlement') rejectFutureSettlementDate(record.date);
  }

  let settlementMigration;
  try {
    if (!settlementsEntry) {
      migrateEventSequences(normalizedEvents);
    }
    migrateEventSequences(db.events, backupSettlements.records);
    const importedHighWater = Math.max(
      importedDbHighWater || 0,
      backupSettlements.lastEventSequence || 0,
      maxSequenceNumber(db.events, backupSettlements.records)
    );
    if (importedHighWater > 0) db.lastEventSequence = importedHighWater;
    settlementMigration = migrateSettlementLedger(db, backupSettlements);
  } catch (error) {
    reject(error.message);
  }

  const projectedDb = mergeSettlementLedger({ ...db, indexCache: importedIndexCache }, settlementMigration.ledger);
  const ledgerIssue = findLedgerIssue(projectedDb);
  if (ledgerIssue) rejectLedgerIssue(ledgerIssue);

  const importedTickers = [];
  for (const item of backupConfig.tickers) {
    const ticker = typeof item?.ticker === 'string' ? item.ticker.trim().toUpperCase() : '';
    if (!TICKER_PATTERN.test(ticker)) {
      reject(`备份中的标的代码无效：${ticker || '(空)'}`);
    }
    importedTickers.push({ ticker });
  }
  if (new Set(importedTickers.map(item => item.ticker)).size !== importedTickers.length) {
    reject('备份中的标的代码不能重复。');
  }

  const importedConfig = {
    tickers: importedTickers,
    customBenchmark: normalizeCustomBenchmark(backupConfig.customBenchmark, InputError),
    customBenchmark2: normalizeCustomBenchmark(backupConfig.customBenchmark2, InputError)
  };

  return {
    db,
    config: importedConfig,
    settlements: settlementMigration.ledger,
    settlementMigration,
    projectedDb,
    hasCnhRate: cnhRate !== undefined,
    importedCnhRate,
    hasIndexCache: indexCache !== undefined,
    importedIndexCache
  };
}

module.exports = {
  MAX_BACKUP_BYTES,
  readBackupEntry,
  normalizeImportedEvent,
  prepareBackupRestore
};
