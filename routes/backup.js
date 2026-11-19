const express = require('express');
const AdmZip = require('adm-zip');
const { prepareBackupRestore } = require('../lib/backup-import');
const { stripTransientDbFields } = require('../lib/db-fields');
const { handleApiError } = require('../lib/api-errors');

function registerBackupRoutes(app, deps, utils, tickerUtils) {
  const {
    readCoreDb = deps.readDb,
    readDb,
    readSettlements,
    readConfig,
    writeSnapshot,
    writeCnhRate = () => {},
    writeIndexCache = () => {},
    ensureIndexCache,
    isValidDate,
    normalizeRemark,
    restoreSharedSettings = true
  } = deps;
  const { toFiniteNumber, findLedgerIssue, rejectLedgerIssue, rejectFutureSettlementDate } = utils;
  const { queueTickerRefresh } = tickerUtils;

  // 5. 数据一键导出备份：完整打包 data/db.json、data/config.json 与 data/settlements.json
  app.get('/api/backup/export', (req, res, next) => {
    try {
      const coreDb = stripTransientDbFields(readCoreDb());
      const config = readConfig();
      const settlements = readSettlements();
      const baseDb = {
        ...coreDb,
        events: coreDb.events.filter(event =>
          event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal')
      };
      const zip = new AdmZip();
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
      const restored = prepareBackupRestore(req.body, {
        currentDb: readDb(),
        restoreSharedSettings,
        isValidDate,
        normalizeRemark,
        toFiniteNumber,
        findLedgerIssue,
        rejectLedgerIssue,
        rejectFutureSettlementDate
      });

      writeSnapshot(restored.db, restored.config, restored.settlements);
      // Older backups may contain these fields. Restore them into market cache,
      // not back into the ledger; newer exports deliberately omit them.
      const warnings = [];
      try {
        if (restoreSharedSettings && restored.hasCnhRate) {
          writeCnhRate(restored.importedCnhRate, { source: 'backup-import' });
        }
      } catch (error) {
        console.error('Failed to restore optional exchange rate cache:', error.message);
        warnings.push('账目已恢复，但汇率未更新，请在设置中重新同步汇率。');
      }
      try {
        if (restoreSharedSettings && restored.hasIndexCache) {
          writeIndexCache(restored.importedIndexCache);
        }
      } catch (error) {
        // Market data is disposable. A cache write failure must not turn a
        // successful core-ledger restore into an ambiguous failed import.
        console.error('Failed to restore optional index cache:', error.message);
      }
      void queueTickerRefresh(readConfig());

      // 批量导入触发指数同步
      if (restored.projectedDb.events.length > 0) {
        ensureIndexCache(restored.projectedDb.events.map(e => e.date));
      }

      const migrationNotice = restored.settlementMigration.migrated
        ? `，并已为 ${restored.settlementMigration.migratedCount} 笔历史结算补充算法版本`
        : '';
      res.json({
        success: true,
        warnings,
        message: `ZIP 快照已恢复，账目与结算已原子覆盖并重新计算${restoreSharedSettings ? '，系统配置已恢复' : '，共享系统配置与行情已保留'}${migrationNotice}。${warnings.join('')}`
      });
    } catch (error) {
      handleApiError(error, req, res, next);
    }
  });
}

module.exports = { registerBackupRoutes };
