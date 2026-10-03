const { inflateRawSync } = require('zlib');
const { InputError } = require('./api-errors');
const { isValidDisposalFeeSnapshot } = require('./performance-fee-policy');

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
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
      validateSnapshotNumbers(lot, ['holdingDays', 'basis', 'entryNav', 'shares', 'currentValue', 'hurdle', 'aboveHurdle', 'fee', 'feeShares']);
      if ((lot.sourceEventId !== undefined && typeof lot.sourceEventId !== 'string') ||
          (lot.sourceType !== undefined && typeof lot.sourceType !== 'string') ||
          (lot.startDate !== undefined && !isValidDate(lot.startDate))) reject('结算快照包含无效批次信息。');
      return pick(lot, ['sourceEventId', 'sourceType', 'startDate', 'holdingDays', 'basis', 'entryNav', 'shares', 'currentValue', 'hurdle', 'aboveHurdle', 'fee', 'feeShares']);
    });
    return normalized;
  });
  return result;
}

function normalizeImportedEvent(event, memberIds, normalizeRemark, isValidDate) {
  if (!isObject(event)) reject('导入的数据中存在格式不完整的事件项');
  const result = pick(event, ['id', 'type', 'date', 'createdAt', 'sequenceNumber']);
  // Keep absent remarks absent for legacy round trips; supplied remarks use the
  // same type, trimming and length policy as normal transaction writes.
  if (event.remark !== undefined) result.remark = normalizeRemark(event.remark);
  const fields = {
    deposit: ['member', 'amount', 'cnhAmount'],
    withdraw: ['member', 'amount', 'cnhAmount'],
    valuation: ['totalNAV'],
    transfer: ['fromMember', 'toMember', 'amount', 'cnhRate', 'cnhAmount'],
    performance_settlement: ['gpMember', 'annualRate', 'feeRate', 'algorithmVersion', 'lpMembers'],
    performance_settlement_reversal: ['settlementId', 'settlementDate']
  };
  if (!Object.prototype.hasOwnProperty.call(fields, event.type)) reject('导入数据中包含非法事件类型。');
  Object.assign(result, pick(event, fields[event.type]));
  if (event.type === 'withdraw' || event.type === 'transfer') {
    if (event.fullExit !== undefined && typeof event.fullExit !== 'boolean') reject('fullExit 必须为布尔值。');
    if (event.requestedGrossAmount !== undefined && !positive(event.requestedGrossAmount)) reject('requestedGrossAmount 必须为有效正数。');
    Object.assign(result, pick(event, ['fullExit', 'requestedGrossAmount']));
    if (event.performanceFee !== undefined) {
      if (!isObject(event.performanceFee) || !isValidDisposalFeeSnapshot(event.performanceFee, memberIds)) reject('部分退出记录包含无效的业绩结算参数快照。');
      result.performanceFee = pick(event.performanceFee, ['gpMember', 'annualRate', 'feeRate', 'disposalVersion']);
    }
  }
  if (event.type === 'transfer' && event.cnhAmount !== undefined && !positive(event.cnhAmount)) reject('划转记录中包含非法人民币金额。');
  if (event.type === 'performance_settlement') {
    if (event.lpMembers !== undefined && (!Array.isArray(event.lpMembers) ||
        event.lpMembers.some(id => !memberIds.has(id)) || new Set(event.lpMembers).size !== event.lpMembers.length)) {
      reject('结算记录的 lpMembers 必须为不重复的有效成员列表。');
    }
    if (event.algorithmVersion !== undefined && ![1, 2, 3].includes(event.algorithmVersion)) reject('结算记录的算法版本无效。');
    result.snapshot = normalizeSnapshot(event.snapshot, memberIds, isValidDate);
  }
  if (event.type === 'performance_settlement_reversal' && event.settlementDate !== undefined && !isValidDate(event.settlementDate)) reject('冲销记录的结算日期无效。');
  return result;
}

module.exports = { MAX_BACKUP_BYTES, readBackupEntry, normalizeImportedEvent };
