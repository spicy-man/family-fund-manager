const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const storage = require('./lib/storage');
const { mergeSettlementLedger, migrateSettlementLedger } = require('./lib/settlement-ledger');
const { maxSequenceNumber, migrateEventSequences } = require('./lib/event-order');
const {
  InputError,
  NotFoundError,
  StorageError,
  normalizeApiErrorResponses,
  apiErrorHandler
} = require('./lib/api-errors');

const app = express();
const PORT = process.env.PORT || 3000;
const EXTERNAL_SYNC_ENABLED = process.env.FUND_EXTERNAL_SYNC !== '0';
const MAX_REMARK_LENGTH = 500;
const MAX_MEMBER_NAME_LENGTH = 50;
const DEPENDENCIES = require('./package.json').dependencies;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "media-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

const IMMUTABLE_ASSET_OPTIONS = {
  immutable: true,
  index: false,
  maxAge: '1y'
};
const vendorAssets = [
  {
    url: `/vendor/chart.js/${DEPENDENCIES['chart.js']}/chart.umd.min.js`,
    file: path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js')
  },
  {
    url: `/vendor/sortablejs/${DEPENDENCIES.sortablejs}/Sortable.min.js`,
    file: require.resolve('sortablejs/Sortable.min.js')
  },
  {
    url: `/vendor/fonts/inter/${DEPENDENCIES['@fontsource-variable/inter']}/index.css`,
    file: require.resolve('@fontsource-variable/inter/index.css')
  },
  {
    url: `/vendor/fonts/outfit/${DEPENDENCIES['@fontsource-variable/outfit']}/index.css`,
    file: require.resolve('@fontsource-variable/outfit/index.css')
  }
];

vendorAssets.forEach(({ url, file }) => {
  app.get(url, (req, res) => res.sendFile(file, {
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }
  }));
});

[
  ['inter', '@fontsource-variable/inter'],
  ['outfit', '@fontsource-variable/outfit']
].forEach(([family, packageName]) => {
  const version = DEPENDENCIES[packageName];
  const filesDirectory = path.join(path.dirname(require.resolve(`${packageName}/index.css`)), 'files');
  app.use(`/vendor/fonts/${family}/${version}/files`, express.static(filesDirectory, IMMUTABLE_ASSET_OPTIONS));
});

app.use('/api', normalizeApiErrorResponses);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function isValidDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function normalizeRemark(remark, fallback = '') {
  if (remark === undefined || remark === null) return fallback;
  if (typeof remark !== 'string') throw new InputError('备注必须为文本。');
  const normalized = remark.trim();
  if (normalized.length > MAX_REMARK_LENGTH) throw new InputError(`备注不能超过 ${MAX_REMARK_LENGTH} 个字符。`);
  return normalized;
}

function normalizeMemberName(name) {
  if (typeof name !== 'string') throw new InputError('成员姓名必须为文本。');
  const normalized = name.trim();
  if (!normalized || normalized.length > MAX_MEMBER_NAME_LENGTH) {
    throw new InputError(`成员姓名长度必须在 1 到 ${MAX_MEMBER_NAME_LENGTH} 个字符之间。`);
  }
  return normalized;
}

// --- 性能优化：内存缓存层 ---
let _stateCache = null;    // calculateState() 结果缓存
let _stateDirty = true;    // 脏标记：数据变更后标记缓存失效
let _settlementLedgerValidated = false;

function readDbUnsafe() {
  let db = {
    ...storage.readDb(),
    customBenchmarkCache: storage.readCustomBenchmarkCache(),
    indexCache: storage.readIndexCache(),
    marketHistory: storage.readMarketHistory(),
    cnhRate: storage.readCnhRateCache().rate
  };
  let settlementLedger = storage.readSettlements();
  if (!_settlementLedgerValidated) {
    const legacy = db.events.filter(event =>
      event.type === 'performance_settlement' || event.type === 'performance_settlement_reversal'
    );
    let movedLegacyRecords = false;
    let orderMigration = { migrated: false };
    if (legacy.length && settlementLedger.records.length === 0) {
      // Preserve the exact interleaving of legacy normal and settlement events
      // before moving settlement records to their dedicated ledger.
      orderMigration = migrateEventSequences(db.events);
      settlementLedger = { version: 1, records: legacy };
      db = {
        ...db,
        events: db.events.filter(event =>
          event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal'
        )
      };
      movedLegacyRecords = true;
    }
    const combinedOrderMigration = migrateEventSequences(db.events, settlementLedger.records);
    const dbHighWater = db.lastEventSequence ?? 0;
    const settlementHighWater = settlementLedger.lastEventSequence ?? 0;
    if (!Number.isSafeInteger(dbHighWater) || dbHighWater < 0 ||
        !Number.isSafeInteger(settlementHighWater) || settlementHighWater < 0) {
      throw new Error('账本包含无效的事件顺序号高水位。');
    }
    const derivedHighWater = Math.max(
      dbHighWater,
      settlementHighWater,
      maxSequenceNumber(db.events, settlementLedger.records)
    );
    const highWaterMigrated = derivedHighWater > 0 && db.lastEventSequence !== derivedHighWater;
    if (highWaterMigrated) db.lastEventSequence = derivedHighWater;
    const migration = migrateSettlementLedger(db, settlementLedger);
    settlementLedger = migration.ledger;
    if (movedLegacyRecords || orderMigration.migrated || combinedOrderMigration.migrated ||
        highWaterMigrated || migration.migrated) {
      storage.writeSnapshot(db, storage.readConfig(), settlementLedger);
    }
    _settlementLedgerValidated = true;
  }
  return mergeSettlementLedger(db, settlementLedger);
}

function readDb() {
  try {
    return readDbUnsafe();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('数据库读取失败。', { cause: error });
  }
}

function writeDb(dbData) {
  try {
    storage.writeDb({
      ...dbData,
      events: dbData.events.filter(event =>
        event.type !== 'performance_settlement' && event.type !== 'performance_settlement_reversal')
    });
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    storage.clearDbCache();
    _settlementLedgerValidated = false;
    _stateCache = null;
    _stateDirty = true;
    throw new StorageError('数据库写入失败。', { cause: error });
  }
}

function writeIndexCache(cacheData) {
  try {
    storage.writeIndexCache(cacheData);
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    throw new StorageError('指数缓存写入失败。', { cause: error });
  }
}

function writeCustomBenchmarkCache(cacheData) {
  try {
    storage.writeCustomBenchmarkCache(cacheData);
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    throw new StorageError('自定义标的缓存写入失败。', { cause: error });
  }
}

function writeMarketHistory(history) {
  try {
    storage.writeMarketHistory(history);
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    throw new StorageError('逐日行情历史写入失败。', { cause: error });
  }
}

function writeCnhRate(rate, options) {
  try {
    storage.writeCnhRateCache(rate, options);
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    throw new StorageError('汇率缓存写入失败。', { cause: error });
  }
}

function readSettlements() {
  try {
    return storage.readSettlements();
  } catch (error) {
    throw new StorageError('结算账本读取失败。', { cause: error });
  }
}

function writeSettlements(data) {
  try {
    storage.writeSettlements(data);
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    storage.clearDbCache();
    _settlementLedgerValidated = false;
    _stateCache = null;
    _stateDirty = true;
    throw new StorageError('结算账本写入失败。', { cause: error });
  }
}

// 获取全局计算状态（优化：带缓存，仅在数据变更后重新计算）
function getState() {
  if (!_stateDirty && _stateCache) return _stateCache;
  _stateCache = calculateState();
  _stateDirty = false;
  return _stateCache;
}

function readConfig() {
  try {
    return storage.readConfig();
  } catch (error) {
    throw new StorageError('配置读取失败。', { cause: error });
  }
}

function writeConfig(configData) {
  try {
    storage.writeConfig(configData);
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    throw new StorageError('配置写入失败。', { cause: error });
  }
}

function writeSnapshot(dbData, configData, settlementsData) {
  try {
    storage.writeSnapshot(dbData, configData, settlementsData);
    _settlementLedgerValidated = false;
    _stateCache = null;
    _stateDirty = true;
  } catch (error) {
    storage.clearDbCache();
    _settlementLedgerValidated = false;
    _stateCache = null;
    _stateDirty = true;
    throw new StorageError('快照写入失败。', { cause: error });
  }
}

/**
 * 解析 Yahoo 价格响应的辅助函数
 */
const {
  fetchYahooPrices,
  fetchTickerAthData,
  fetchCnhRateFromApi
} = require('./lib/yahoo');
const {
  normalizeMarketHistory,
  mergeTickerPrices,
  addUtcDays,
  previousWeekday,
  benchmarkDates,
  materializeBenchmarkCaches
} = require('./lib/market-history');

/**
 * 异步更新缺失日期的指数收盘价缓存 (静默后台机制)
 */
let benchmarkSyncQueue = Promise.resolve();

function ensureIndexCache(dates) {
  const requestedDates = [...(dates || [])];
  const task = benchmarkSyncQueue.then(() => syncBenchmarkHistory(requestedDates));
  benchmarkSyncQueue = task.catch(() => {});
  return task;
}

async function syncBenchmarkHistory(dates) {
  if (!dates || dates.length === 0) return;
  const benchmarkClosePolicy = 'previous';
  const { normalizeCustomBenchmark } = require('./lib/custom-benchmark');
  const config = storage.readConfig();
  const customBenchmarks = [
    normalizeCustomBenchmark(config.customBenchmark),
    normalizeCustomBenchmark(config.customBenchmark2)
  ];
  const datesToBuild = benchmarkDates(dates);
  if (datesToBuild.length === 0) return;
  const requestedTickers = [...new Set([
    '^GSPC',
    '^NDX',
    ...customBenchmarks.flatMap(benchmark =>
      benchmark ? benchmark.components.map(component => component.ticker) : [])
  ])];

  console.log(`[Yahoo Sync Worker] Updating daily history for ${requestedTickers.length} benchmark tickers...`);

  try {
    const history = normalizeMarketHistory(storage.readMarketHistory());
    const oldestRequired = addUtcDays(datesToBuild[0], -14);
    const today = new Date().toISOString().slice(0, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    let changed = false;

    // Fetch a broad daily series first. Existing dates are merged, never
    // removed, so a later incomplete Yahoo response cannot erase history.
    await Promise.all(requestedTickers.map(async ticker => {
      const record = history.tickers[ticker];
      const latestStored = Object.keys(record?.prices || {}).sort().at(-1);
      const incrementalStart = latestStored ? addUtcDays(latestStored, -14) : oldestRequired;
      const requestStart = record?.fetchedFrom
        ? (incrementalStart < oldestRequired ? oldestRequired : incrementalStart)
        : oldestRequired;
      const prices = await fetchYahooPrices(
        ticker,
        Math.floor(Date.parse(`${requestStart}T00:00:00Z`) / 1000),
        nowSec
      );
      changed = mergeTickerPrices(history, ticker, prices, {
        from: requestStart,
        through: today
      }) || changed;
    }));

    // Yahoo's broad historical endpoint can occasionally omit its newest
    // completed candle. Probe each missing expected business day with a narrow
    // date request; holidays simply remain absent and resolve to the prior close.
    const expectedDates = [...new Set(datesToBuild.map(previousWeekday))];
    await Promise.all(requestedTickers.map(async ticker => {
      for (const date of expectedDates) {
        if (history.tickers[ticker]?.prices?.[date]) continue;
        const prices = await fetchYahooPrices(
          ticker,
          Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000),
          Math.floor(Date.parse(`${addUtcDays(date, 2)}T00:00:00Z`) / 1000)
        );
        changed = mergeTickerPrices(history, ticker, prices) || changed;
      }
    }));

    if (changed) {
      history.updatedAt = new Date().toISOString();
      writeMarketHistory(history);
    }

    const materialized = materializeBenchmarkCaches(
      dates,
      history,
      customBenchmarks,
      benchmarkClosePolicy
    );
    writeIndexCache({ ...storage.readIndexCache(), ...materialized.indexCache });
    writeCustomBenchmarkCache({
      ...storage.readCustomBenchmarkCache(),
      ...materialized.customBenchmarkCache
    });
    console.log(`[Yahoo Sync Worker] Daily history saved and ${materialized.dates.length} NAV-date snapshots rebuilt.`);
  } catch (err) {
    console.error(`[Yahoo Sync Worker Error]:`, err.message);
  }
}

/**
 * 核心数学模型：事件流重放 (Event Sourcing Replay)
 * 重新按时间顺序计算每个事件发生时的净值、份额、及当前各成员资产状况。
 */
function calculateState() {
  const config = storage.readConfig();
  return calculateStateFromDb({
    ...readDb(),
    customBenchmark: config.customBenchmark || null,
    customBenchmark2: config.customBenchmark2 || null
  });
}

const { calculateStateFromDb } = require('./lib/calculator');
const { registerDemoRoutes } = require('./routes/demo');

registerDemoRoutes(app, {
  calculateStateFromDb,
  publicDirectory: path.join(__dirname, 'public')
});

const { registerApiRoutes } = require('./routes/api');

registerApiRoutes(app, {
  readDb,
  writeDb,
  readSettlements,
  writeSettlements,
  getState,
  readConfig,
  writeConfig,
  readTickerCache: storage.readTickerCache,
  writeTickerCache: storage.writeTickerCache,
  writeSnapshot,
  readIndexCache: storage.readIndexCache,
  writeIndexCache,
  readCustomBenchmarkCache: storage.readCustomBenchmarkCache,
  writeCustomBenchmarkCache,
  writeCnhRate,
  ensureIndexCache: EXTERNAL_SYNC_ENABLED ? ensureIndexCache : () => {},
  calculateStateFromDb,
  fetchCnhRateFromApi,
  isValidDate,
  normalizeRemark,
  normalizeMemberName,
  fetchTickerAthData: EXTERNAL_SYNC_ENABLED ? fetchTickerAthData : async () => ({}),
  randomUUID
});

app.use('/api', (req, _res, next) => next(new NotFoundError('未找到该 API 接口。')));
app.use('/api', apiErrorHandler);
// 从第三方公开汇率接口获取最新 USD/CNH 汇率
function startServer({ port = PORT, host = '127.0.0.1' } = {}) {
  const server = app.listen(port, host, () => {
  console.log(`====================================================`);
  console.log(`🚀 家庭基金账目管理系统已在本地成功启动！`);
  console.log(`🌐 访问地址：http://localhost:${server.address().port}`);
  console.log(`📂 数据存储路径：${storage.DB_FILE}`);
  console.log(`====================================================`);

  // 启动时静默同步一次汇率与美股指数数据
  if (EXTERNAL_SYNC_ENABLED) fetchCnhRateFromApi().then(rate => {
    if (rate) {
      try {
        writeCnhRate(rate, { source: 'startup-sync' });
        console.log(`🌍 [Auto-Sync] 系统成功自适应获取全球最新汇率：1 USD = ${rate} CNH`);
      } catch (err) {
        console.error('Failed to auto-save fetched CNH rate:', err);
      }
    }
  });

  // 静默自适应对标指数历史同步
  if (EXTERNAL_SYNC_ENABLED) try {
    const db = readDb();
    if (db.events && db.events.length > 0) {
      const dates = db.events.map(e => e.date);
      ensureIndexCache(dates);
    }
  } catch (err) {
    console.error('[Yahoo Sync Startup Error]:', err);
  }
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, calculateStateFromDb, ensureIndexCache, startServer };
