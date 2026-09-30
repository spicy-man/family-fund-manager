const express = require('express');
const AdmZip = require('adm-zip');
const {
  DEFAULT_ANNUAL_RATE,
  DEFAULT_FEE_RATE,
  configuredPerformanceFeeRates,
  isValidPerformanceFeeRates,
  isValidDisposalFeeSnapshot
} = require('../lib/performance-fee-policy');
const { mergeSettlementLedger, migrateSettlementLedger } = require('../lib/settlement-ledger');
const { hasSequenceNumber, maxSequenceNumber, migrateEventSequences } = require('../lib/event-order');
const { InputError, handleApiError } = require('../lib/api-errors');
const { normalizeCustomBenchmark } = require('../lib/custom-benchmark');

function registerBackupRoutes(app, deps, utils, tickerUtils) {
  const { readDb, readSettlements, readConfig, writeSnapshot, writeCnhRate = () => {},
    writeIndexCache = () => {}, ensureIndexCache, isValidDate } = deps;
  const { toFiniteNumber, findLedgerIssue, rejectLedgerIssue } = utils;
  const { queueTickerRefresh } = tickerUtils;
  const rejectImport = message => { throw new InputError(message); };

// 5. 数据一键导出备份：完整打包 data/db.json 与 data/config.json
app.get('/api/backup/export', (req, res, next) => {
  try {
    const db = readDb();
    const config = readConfig();
    const settlements = readSettlements();
    const zip = new AdmZip();
    const {
      indexCache: _indexCache,
      customBenchmarkCache: _customBenchmarkCache,
      marketHistory: _marketHistory,
      cnhRate: _cnhRate,
      ...coreDb
    } = db;
    const baseDb = {
      ...coreDb,
      events: db.events.filter(event =>
        event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal')
    };
    zip.addFile('data/db.json', Buffer.from(JSON.stringify(baseDb, null, 2), 'utf8'));
    zip.addFile('data/config.json', Buffer.from(JSON.stringify(config, null, 2), 'utf8'));
    zip.addFile('data/settlements.json', Buffer.from(JSON.stringify(settlements, null, 2), 'utf8'));

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=family_fund_backup_${date}.zip`);
    res.send(zip.toBuffer());
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 6. 数据导入恢复：校验 ZIP 快照后覆盖当前 db.json 与 config.json
app.post('/api/backup/import', express.raw({
  type: ['application/zip', 'application/octet-stream'],
  limit: '10mb'
}), (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      rejectImport('请选择有效的 ZIP 备份文件。');
    }

    let zip;
    try {
      zip = new AdmZip(req.body);
    } catch (_) {
      rejectImport('备份文件不是有效的 ZIP 压缩包。');
    }

    const dbEntry = zip.getEntry('data/db.json') || zip.getEntry('db.json');
    const configEntry = zip.getEntry('data/config.json') || zip.getEntry('config.json');
    const settlementsEntry = zip.getEntry('data/settlements.json') || zip.getEntry('settlements.json');
    if (!dbEntry || !configEntry || dbEntry.isDirectory || configEntry.isDirectory) {
      rejectImport('ZIP 中必须包含 data/db.json 和 data/config.json。');
    }
    const totalUncompressedSize = Number(dbEntry.header.size) + Number(configEntry.header.size) +
      (settlementsEntry ? Number(settlementsEntry.header.size) : 0);
    if (!Number.isFinite(totalUncompressedSize) || totalUncompressedSize > 10 * 1024 * 1024) {
      rejectImport('ZIP 内的数据文件过大（最大 10MB）。');
    }

    let backupDb;
    let backupConfig;
    let backupSettlements = { version: 1, records: [] };
    try {
      backupDb = JSON.parse(dbEntry.getData().toString('utf8'));
      backupConfig = JSON.parse(configEntry.getData().toString('utf8'));
      if (settlementsEntry && !settlementsEntry.isDirectory) {
        backupSettlements = JSON.parse(settlementsEntry.getData().toString('utf8'));
      }
    } catch (_) {
      rejectImport('ZIP 中的 JSON 数据损坏或无法解析。');
    }

    const { events, members, cnhRate, indexCache, benchmarkClosePolicy, performanceFee,
      lastEventSequence: importedDbHighWater } = backupDb || {};
    if (!Array.isArray(events)) {
      rejectImport('导入的数据格式不正确，缺少 events 数组');
    }
    if (!settlementsEntry) {
      backupSettlements = {
        version: 1,
        records: events.filter(event =>
          event.type === 'performance_settlement' || event.type === 'performance_settlement_reversal')
      };
    }

    // [Fix #2] 深度格式校验：类型白名单、数量上限、字段合法性
    const VALID_EVENT_TYPES = ['deposit', 'withdraw', 'valuation', 'transfer', 'performance_settlement', 'performance_settlement_reversal'];
    const currentDb = readDb();
    const importedMembers = Array.isArray(members) ? members : currentDb.members;
    if (!Array.isArray(importedMembers) || importedMembers.length < 1 || importedMembers.length > 100) {
      rejectImport('Imported members must contain 1 to 100 entries.');
    }
    const memberIds = new Set();
    for (const member of importedMembers) {
      if (!member || typeof member.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(member.id) ||
          typeof member.name !== 'string' || member.name.trim().length < 1 || member.name.trim().length > 50 ||
          memberIds.has(member.id)) {
        rejectImport('Imported members contain an invalid or duplicate id/name.');
      }
      memberIds.add(member.id);
    }
    if (events.length > 10000) {
      rejectImport('导入事件数量超限（最大 10000 条）');
    }
    if (importedDbHighWater !== undefined &&
        (!Number.isSafeInteger(importedDbHighWater) || importedDbHighWater < 0)) {
      rejectImport('备份中的事件顺序号高水位无效。');
    }
    const eventIds = new Set();
    for (let e of events) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(e.id) || eventIds.has(e.id) ||
          !e.type || !e.date || !Number.isFinite(e.createdAt) ||
          (e.sequenceNumber !== undefined && !hasSequenceNumber(e))) {
        rejectImport('导入的数据中存在格式不完整的事件项');
      }
      eventIds.add(e.id);
      if (!VALID_EVENT_TYPES.includes(e.type)) {
        rejectImport(`导入数据中包含非法事件类型: ${e.type}`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
        rejectImport(`导入数据中包含非法日期格式: ${e.date}`);
      }
      if (!isValidDate(e.date)) {
        rejectImport(`Imported data contains an invalid calendar date: ${e.date}`);
      }
      if ((e.type === 'deposit' || e.type === 'withdraw') &&
          (typeof e.amount !== 'number' || e.amount <= 0 || !isFinite(e.amount))) {
        rejectImport(`导入数据中存在非法金额: ${e.amount}`);
      }
      if ((e.type === 'deposit' || e.type === 'withdraw') && !memberIds.has(e.member)) {
        rejectImport('A transaction references a member that does not exist.');
      }
      if ((e.type === 'deposit' || e.type === 'withdraw') && e.cnhAmount !== undefined &&
          (typeof e.cnhAmount !== 'number' || e.cnhAmount <= 0 || !Number.isFinite(e.cnhAmount))) {
        rejectImport('出入金记录中包含非法人民币金额。');
      }
      if (e.type === 'valuation' &&
          (typeof e.totalNAV !== 'number' || e.totalNAV <= 0 || !isFinite(e.totalNAV))) {
        rejectImport(`导入数据中存在非法估值金额: ${e.totalNAV}`);
      }
      if (e.type === 'transfer' &&
          (typeof e.amount !== 'number' || e.amount <= 0 || !isFinite(e.amount))) {
        rejectImport(`导入数据中存在非法划转金额: ${e.amount}`);
      }
      if (e.type === 'transfer' &&
          (!memberIds.has(e.fromMember) || !memberIds.has(e.toMember) || e.fromMember === e.toMember ||
           (e.cnhRate !== undefined && (typeof e.cnhRate !== 'number' || e.cnhRate <= 0 || !isFinite(e.cnhRate))))) {
        rejectImport('A transfer contains invalid member references or exchange rate.');
      }
      if ((e.type === 'withdraw' || e.type === 'transfer') && e.performanceFee &&
          !isValidDisposalFeeSnapshot(e.performanceFee, memberIds)) {
        rejectImport('部分退出记录包含无效的业绩结算参数快照。');
      }
      if (e.type === 'performance_settlement' &&
          (!memberIds.has(e.gpMember) || !isValidPerformanceFeeRates(e))) {
        rejectImport('业绩结算记录包含无效的GP或费率参数。');
      }
    }

    let importedCnhRate = currentDb.cnhRate;
    if (cnhRate !== undefined) {
      importedCnhRate = toFiniteNumber(cnhRate);
      if (!Number.isFinite(importedCnhRate) || importedCnhRate <= 0) {
        rejectImport('导入数据中的汇率参数必须大于 0');
      }
    }

    const importedIndexCache = (indexCache && typeof indexCache === 'object' && !Array.isArray(indexCache))
      ? indexCache
      : (currentDb.indexCache || {});
    let importedFeeRates;
    try {
      importedFeeRates = configuredPerformanceFeeRates(performanceFee || {
        annualRate: DEFAULT_ANNUAL_RATE,
        feeRate: DEFAULT_FEE_RATE
      });
    } catch (error) {
      rejectImport(error.message);
    }
    if (performanceFee?.gpMemberId != null && !memberIds.has(performanceFee.gpMemberId)) {
      rejectImport('备份中的 performanceFee.gpMemberId 引用了不存在的成员。');
    }
    const importedGpMemberId = performanceFee?.gpMemberId ?? null;
    const db = {
      members: importedMembers.map(member => ({
        id: member.id,
        name: member.name.trim(),
        roles: {
          lp: true,
          gp: member.id === importedGpMemberId
        }
      })),
      events: events.filter(event =>
        event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal'),
      benchmarkClosePolicy: 'previous',
      performanceFee: {
        gpMemberId: importedGpMemberId,
        ...importedFeeRates
      }
    };
    if (!backupConfig || !Array.isArray(backupConfig.tickers) || backupConfig.tickers.length < 1) {
      rejectImport('备份中的标的配置无效（至少需要 1 个标的）。');
    }
    if (backupSettlements?.version !== 1 || !Array.isArray(backupSettlements.records) ||
        (backupSettlements.lastEventSequence !== undefined &&
         (!Number.isSafeInteger(backupSettlements.lastEventSequence) || backupSettlements.lastEventSequence < 0))) {
      rejectImport('备份中的独立结算账本格式无效。');
    }
    const settlementIds = new Set();
    for (const record of backupSettlements.records) {
      if (!record || typeof record.id !== 'string' || settlementIds.has(record.id) ||
          !['performance_settlement', 'performance_settlement_reversal'].includes(record.type) ||
          !isValidDate(record.date) || !Number.isFinite(record.createdAt) ||
          (record.sequenceNumber !== undefined && !hasSequenceNumber(record))) {
        rejectImport('独立结算账本包含无效或重复记录。');
      }
      if (record.type === 'performance_settlement' &&
          (!memberIds.has(record.gpMember) || !isValidPerformanceFeeRates(record))) {
        rejectImport('独立结算账本包含无效的结算参数。');
      }
      if (record.type === 'performance_settlement_reversal' &&
          (typeof record.settlementId !== 'string' || !backupSettlements.records.some(item => item.id === record.settlementId && item.type === 'performance_settlement'))) {
        rejectImport('独立结算账本包含无效的冲销引用。');
      }
      settlementIds.add(record.id);
    }
    let settlementMigration;
    try {
      if (!settlementsEntry) {
        // Legacy backups embedded settlement records inside events. Migrate
        // that original array before splitting it, otherwise equal-timestamp
        // normal and settlement events could lose their interleaving.
        migrateEventSequences(events);
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
      rejectImport(error.message);
    }
    const projectedDb = mergeSettlementLedger({ ...db, indexCache: importedIndexCache }, settlementMigration.ledger);
    const ledgerIssue = findLedgerIssue(projectedDb);
    if (ledgerIssue) rejectLedgerIssue(ledgerIssue);

    const importedTickers = [];
    for (const item of backupConfig.tickers) {
      const ticker = typeof item?.ticker === 'string' ? item.ticker.trim().toUpperCase() : '';
      if (!/^[\^A-Z0-9.\-]{1,20}$/.test(ticker)) {
        rejectImport(`备份中的标的代码无效：${ticker || '(空)'}`);
      }
      importedTickers.push({ ticker });
    }
    if (new Set(importedTickers.map(item => item.ticker)).size !== importedTickers.length) {
      rejectImport('备份中的标的代码不能重复。');
    }

    const importedConfig = {
      tickers: importedTickers,
      customBenchmark: normalizeCustomBenchmark(backupConfig.customBenchmark, InputError),
      customBenchmark2: normalizeCustomBenchmark(backupConfig.customBenchmark2, InputError)
    };

    writeSnapshot(db, importedConfig, settlementMigration.ledger);
    // Older backups may contain this field. Restore it into market cache, not
    // back into the ledger; newer exports deliberately omit it.
    const warnings = [];
    try {
      writeCnhRate(importedCnhRate, { source: 'backup-import' });
    } catch (error) {
      console.error('Failed to restore optional exchange rate cache:', error.message);
      warnings.push('账目已恢复，但汇率未更新，请在设置中重新同步汇率。');
    }
    try {
      writeIndexCache(importedIndexCache);
    } catch (error) {
      // Market data is disposable. A cache write failure must not turn a
      // successful core-ledger restore into an ambiguous failed import.
      console.error('Failed to restore optional index cache:', error.message);
    }
    void queueTickerRefresh(importedConfig);

    // 批量导入触发指数同步
    if (events && events.length > 0) {
      ensureIndexCache(projectedDb.events.map(e => e.date));
    }

    const migrationNotice = settlementMigration.migrated
      ? `，并已为 ${settlementMigration.migratedCount} 笔历史结算补充算法版本`
      : '';
    res.json({ success: true, warnings, message: `ZIP 快照已恢复，账目、结算与系统配置均已原子覆盖并重新计算${migrationNotice}。${warnings.join('')}` });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});
}

module.exports = { registerBackupRoutes };
