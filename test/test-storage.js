const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const storagePath = require.resolve('../lib/storage');
const originalDataDir = process.env.FUND_DATA_DIR;
const originalBackupDir = process.env.FUND_BACKUP_DIR;

function loadStorage(dataDir, backupDir) {
  process.env.FUND_DATA_DIR = dataDir;
  process.env.FUND_BACKUP_DIR = backupDir;
  delete require.cache[storagePath];
  return require('../lib/storage');
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-storage-'));
const coreDb = db => {
  const { cnhRate, ...core } = db;
  return core;
};

try {
  const danglingDataDir = path.join(testRoot, 'data-dangling-gp');
  const danglingBackupDir = path.join(testRoot, 'backups-dangling-gp');
  fs.mkdirSync(danglingDataDir, { recursive: true });
  fs.writeFileSync(path.join(danglingDataDir, 'db.json'), JSON.stringify({
    cnhRate: 7.2,
    benchmarkClosePolicy: 'previous',
    performanceFee: { gpMemberId: 'deleted-gp', annualRate: 0.06, feeRate: 0.25 },
    members: [{ id: 'lp', name: 'LP', roles: { lp: true, gp: false } }],
    events: []
  }));
  const danglingStorage = loadStorage(danglingDataDir, danglingBackupDir);
  const danglingConsoleError = console.error;
  try {
    console.error = () => {};
    assert.throws(
      () => danglingStorage.readDb(),
      /gpMemberId references a member that does not exist/,
      'startup must fail closed when the current GP reference is dangling'
    );
  } finally {
    console.error = danglingConsoleError;
  }

  const danglingSnapshotDataDir = path.join(testRoot, 'data-dangling-snapshot');
  const danglingSnapshotBackupDir = path.join(testRoot, 'backups-dangling-snapshot');
  fs.mkdirSync(danglingSnapshotDataDir, { recursive: true });
  fs.writeFileSync(path.join(danglingSnapshotDataDir, 'db.json'), JSON.stringify({
    cnhRate: 7.2,
    benchmarkClosePolicy: 'previous',
    performanceFee: { gpMemberId: null, annualRate: 0.06, feeRate: 0.25 },
    members: [{ id: 'lp', name: 'LP', roles: { lp: true, gp: false } }],
    events: [{
      id: 'historical-withdrawal',
      type: 'withdraw',
      member: 'lp',
      amount: 1,
      date: '2026-01-01',
      createdAt: 1,
      performanceFee: {
        gpMember: 'deleted-gp', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2
      }
    }]
  }));
  const danglingSnapshotStorage = loadStorage(danglingSnapshotDataDir, danglingSnapshotBackupDir);
  try {
    console.error = () => {};
    assert.throws(
      () => danglingSnapshotStorage.readDb(),
      /invalid performance-fee snapshot/,
      'startup must fail closed when a historical disposal snapshot references a deleted GP'
    );
  } finally {
    console.error = danglingConsoleError;
  }

  // Every durable mutation archives the complete intended state in the same
  // ZIP structure accepted by the manual restore endpoint.
  const dataDir = path.join(testRoot, 'data-ok');
  const backupDir = path.join(testRoot, 'backups-ok');
  const storage = loadStorage(dataDir, backupDir);
  const originalDb = storage.readDb();
  const nextDb = { ...originalDb, cnhRate: 7.3 };
  storage.writeDb(nextDb);
  assert.throws(
    () => storage.writeDb({
      ...nextDb,
      events: [{
        id: 'dangling-fee-snapshot',
        type: 'withdraw',
        member: 'me',
        amount: 1,
        date: '2026-01-01',
        createdAt: 1,
        performanceFee: {
          gpMember: 'deleted-gp',
          annualRate: 0.06,
          feeRate: 0.25,
          disposalVersion: 2
        }
      }]
    }),
    /invalid performance-fee snapshot/,
    'durable writes must reject historical fee snapshots that reference a deleted GP'
  );
  assert.throws(
    () => storage.writeDb({ ...nextDb, lastEventSequence: Number.NaN }),
    /invalid event sequence high-water mark/
  );

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(storage.DB_FILE, 'utf8')), coreDb(nextDb));
  const backupFiles = fs.readdirSync(backupDir).filter(name => name.startsWith('snapshot_backup_') && name.endsWith('.zip'));
  assert.strictEqual(backupFiles.length, 1);
  const firstBackup = new AdmZip(path.join(backupDir, backupFiles[0]));
  assert.deepStrictEqual(JSON.parse(firstBackup.readAsText('data/db.json')), coreDb(nextDb));
  assert.deepStrictEqual(JSON.parse(firstBackup.readAsText('data/config.json')), storage.readConfig());
  assert.deepStrictEqual(JSON.parse(firstBackup.readAsText('data/settlements.json')), { version: 1, records: [] });

  const originalConfig = storage.readConfig();
  const snapshotDb = { ...nextDb, cnhRate: 7.35 };
  const snapshotConfig = { tickers: [{ ticker: 'AAPL' }] };
  storage.writeSnapshot(snapshotDb, snapshotConfig);
  assert.deepStrictEqual(storage.readDb(), coreDb(snapshotDb));
  assert.deepStrictEqual(storage.readConfig(), snapshotConfig);
  assert.deepStrictEqual(storage.readSettlements(), { version: 1, records: [] });
  const settlementLedger = {
    version: 1,
    records: [{ id: 's1', type: 'performance_settlement', date: '2026-01-01', createdAt: 1 }]
  };
  storage.writeSettlements(settlementLedger);
  assert.deepStrictEqual(storage.readSettlements(), settlementLedger);
  const sequencedSettlementLedger = { ...settlementLedger, lastEventSequence: 9 };
  storage.writeSettlements(sequencedSettlementLedger);
  assert.deepStrictEqual(storage.readSettlements(), sequencedSettlementLedger);
  storage.writeSettlements(settlementLedger);
  assert.notStrictEqual(storage.SETTLEMENTS_FILE, storage.DB_FILE);

  const backupsBeforeTickerWrite = fs.readdirSync(backupDir).length;
  const tickerCache = {
    version: 1,
    updatedAt: '2026-08-04T00:00:00.000Z',
    tickers: { AAPL: { ticker: 'AAPL', ath: 250, updatedAt: '2026-08-04T00:00:00.000Z' } }
  };
  storage.writeTickerCache(tickerCache);
  assert.deepStrictEqual(storage.readTickerCache(), tickerCache);
  assert.strictEqual(fs.readdirSync(backupDir).length, backupsBeforeTickerWrite);

  const backupsBeforeIndexWrite = fs.readdirSync(backupDir).length;
  const indexCache = {
    '2026-08-04': {
      spx: 6330.94,
      ndx: 23219.34,
      spxPriceDate: '2026-08-03',
      ndxPriceDate: '2026-08-03',
      policy: 'previous'
    }
  };
  storage.writeIndexCache(indexCache);
  assert.deepStrictEqual(storage.readIndexCache(), indexCache);
  assert.strictEqual(fs.readdirSync(backupDir).length, backupsBeforeIndexWrite);
  const customBenchmarkCache = {
    '2026-08-04': {
      signature: 'VOO:100.0000',
      components: { VOO: { price: 612.5, priceDate: '2026-08-03' } }
    }
  };
  storage.writeCustomBenchmarkCache(customBenchmarkCache);
  assert.deepStrictEqual(storage.readCustomBenchmarkCache(), customBenchmarkCache);
  assert.strictEqual(fs.readdirSync(backupDir).length, backupsBeforeIndexWrite);
  assert.notStrictEqual(storage.CUSTOM_BENCHMARK_CACHE_FILE, storage.INDEX_CACHE_FILE);
  const marketHistory = {
    version: 1,
    updatedAt: '2026-08-04T00:00:00.000Z',
    tickers: {
      '^GSPC': {
        fetchedFrom: '2026-08-01',
        fetchedThrough: '2026-08-04',
        prices: { '2026-08-03': 6330.94 }
      }
    }
  };
  storage.writeMarketHistory(marketHistory);
  assert.deepStrictEqual(storage.readMarketHistory(), marketHistory);
  assert.strictEqual(fs.readdirSync(backupDir).length, backupsBeforeIndexWrite);
  assert.notStrictEqual(storage.MARKET_HISTORY_FILE, storage.INDEX_CACHE_FILE);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(
    JSON.parse(fs.readFileSync(storage.DB_FILE, 'utf8')),
    'indexCache'
  ), false);

  // If the second live-file commit fails, the already replaced db.json must
  // roll back to the exact previous bytes and config.json must remain unchanged.
  const dbBeforeRollbackTest = fs.readFileSync(storage.DB_FILE, 'utf8');
  const configFile = path.join(dataDir, 'config.json');
  const configBeforeRollbackTest = fs.readFileSync(configFile, 'utf8');
  const originalRenameSync = fs.renameSync;
  try {
    fs.renameSync = (source, target) => {
      if (target === configFile && source.endsWith('.tmp')) {
        throw new Error('simulated config commit failure');
      }
      return originalRenameSync(source, target);
    };
    assert.throws(
      () => storage.writeSnapshot(
        { ...snapshotDb, cnhRate: 7.4 },
        { tickers: [{ ticker: 'MSFT' }] }
      ),
      /simulated config commit failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.strictEqual(fs.readFileSync(storage.DB_FILE, 'utf8'), dbBeforeRollbackTest);
  assert.strictEqual(fs.readFileSync(configFile, 'utf8'), configBeforeRollbackTest);
  assert.deepStrictEqual(storage.readDb(), coreDb(snapshotDb));
  assert.notDeepStrictEqual(originalConfig, snapshotConfig);

  // A three-file restore is one logical commit. If settlements.json cannot be
  // replaced, db.json and config.json must both roll back as well.
  const dbBeforeSettlementFailure = fs.readFileSync(storage.DB_FILE, 'utf8');
  const configBeforeSettlementFailure = fs.readFileSync(configFile, 'utf8');
  const settlementsBeforeFailure = fs.readFileSync(storage.SETTLEMENTS_FILE, 'utf8');
  const nextSettlementLedger = {
    version: 1,
    records: [{ id: 's2', type: 'performance_settlement', date: '2027-01-01', createdAt: 2 }]
  };
  try {
    fs.renameSync = (source, target) => {
      if (target === storage.SETTLEMENTS_FILE && source.endsWith('.tmp')) {
        throw new Error('simulated settlement commit failure');
      }
      return originalRenameSync(source, target);
    };
    assert.throws(
      () => storage.writeSnapshot(
        { ...snapshotDb, cnhRate: 7.5 },
        { tickers: [{ ticker: 'NVDA' }] },
        nextSettlementLedger
      ),
      /simulated settlement commit failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.strictEqual(fs.readFileSync(storage.DB_FILE, 'utf8'), dbBeforeSettlementFailure);
  assert.strictEqual(fs.readFileSync(configFile, 'utf8'), configBeforeSettlementFailure);
  assert.strictEqual(fs.readFileSync(storage.SETTLEMENTS_FILE, 'utf8'), settlementsBeforeFailure);
  assert.deepStrictEqual(storage.readDb(), coreDb(snapshotDb));
  assert.deepStrictEqual(storage.readConfig(), snapshotConfig);
  assert.deepStrictEqual(storage.readSettlements(), settlementLedger);

  // Once initialized, a missing settlement ledger is data loss, not a fresh
  // install. Fail closed instead of silently recreating an empty file.
  const savedSettlementContent = fs.readFileSync(storage.SETTLEMENTS_FILE, 'utf8');
  fs.unlinkSync(storage.SETTLEMENTS_FILE);
  storage.clearDbCache();
  assert.throws(() => storage.readSettlements(), /Settlement ledger is missing/);
  fs.writeFileSync(storage.SETTLEMENTS_FILE, savedSettlementContent, 'utf8');
  storage.clearDbCache();
  assert.deepStrictEqual(storage.readSettlements(), settlementLedger);

  // Simulate a process dying immediately after db.json is replaced. The next
  // process must observe the durable journal and restore the entire old
  // generation before serving any reads.
  const crashDataDir = path.join(testRoot, 'data-crash');
  const crashBackupDir = path.join(testRoot, 'backups-crash');
  let crashStorage = loadStorage(crashDataDir, crashBackupDir);
  crashStorage.readDb();
  crashStorage.clearDbCache();
  const crashDb = crashStorage.readDb();
  const crashConfig = crashStorage.readConfig();
  const crashSettlements = crashStorage.readSettlements();
  const crashBefore = {
    db: fs.readFileSync(crashStorage.DB_FILE, 'utf8'),
    config: fs.readFileSync(path.join(crashDataDir, 'config.json'), 'utf8'),
    settlements: fs.readFileSync(crashStorage.SETTLEMENTS_FILE, 'utf8'),
    marker: fs.readFileSync(crashStorage.SETTLEMENTS_MARKER_FILE, 'utf8')
  };
  const crashScript = `
    const fs = require('fs');
    const storage = require(process.env.FUND_STORAGE_MODULE);
    const db = storage.readDb();
    const config = storage.readConfig();
    const settlements = storage.readSettlements();
    const originalRename = fs.renameSync;
    fs.renameSync = (source, target) => {
      const result = originalRename(source, target);
      if (target === storage.DB_FILE && source.endsWith('.tmp')) process.exit(73);
      return result;
    };
    storage.writeSnapshot(
      { ...db, cnhRate: 9.9 },
      { tickers: [{ ticker: 'CRASH' }] },
      { version: 1, records: [{ id: 'crash-s', type: 'performance_settlement', date: '2028-01-01', createdAt: 1 }] }
    );
  `;
  const crashed = spawnSync(process.execPath, ['-e', crashScript], {
    env: {
      ...process.env,
      FUND_DATA_DIR: crashDataDir,
      FUND_BACKUP_DIR: crashBackupDir,
      FUND_STORAGE_MODULE: storagePath
    }
  });
  assert.strictEqual(crashed.status, 73);
  assert(fs.existsSync(crashStorage.SNAPSHOT_JOURNAL_FILE));
  crashStorage = loadStorage(crashDataDir, crashBackupDir);
  assert.strictEqual(fs.readFileSync(crashStorage.DB_FILE, 'utf8'), crashBefore.db);
  assert.strictEqual(fs.readFileSync(path.join(crashDataDir, 'config.json'), 'utf8'), crashBefore.config);
  assert.strictEqual(fs.readFileSync(crashStorage.SETTLEMENTS_FILE, 'utf8'), crashBefore.settlements);
  assert.strictEqual(fs.readFileSync(crashStorage.SETTLEMENTS_MARKER_FILE, 'utf8'), crashBefore.marker);
  assert(!fs.existsSync(crashStorage.SNAPSHOT_JOURNAL_FILE));
  assert.deepStrictEqual(crashStorage.readDb(), crashDb);
  assert.deepStrictEqual(crashStorage.readConfig(), crashConfig);
  assert.deepStrictEqual(crashStorage.readSettlements(), crashSettlements);

  // If the backup destination is unusable, writeDb must fail before touching
  // the committed database so retrying cannot duplicate a ledger operation.
  const blockedRoot = path.join(testRoot, 'blocked-backup');
  fs.writeFileSync(blockedRoot, 'not a directory');
  const blockedStorage = loadStorage(path.join(testRoot, 'data-blocked'), blockedRoot);
  const beforeFailure = blockedStorage.readDb();
  const beforeFailureRaw = fs.readFileSync(blockedStorage.DB_FILE, 'utf8');
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    assert.throws(() => blockedStorage.writeDb({ ...beforeFailure, cnhRate: 7.4 }));
  } finally {
    console.error = originalConsoleError;
  }
  assert.strictEqual(fs.readFileSync(blockedStorage.DB_FILE, 'utf8'), beforeFailureRaw);

  // Upgrade an existing installation without losing its embedded benchmark
  // prices. The cache file is committed first, then the legacy db field is
  // removed; neither step creates a core-ledger ZIP backup.
  const legacyDataDir = path.join(testRoot, 'data-legacy-index');
  const legacyBackupDir = path.join(testRoot, 'backups-legacy-index');
  fs.mkdirSync(legacyDataDir, { recursive: true });
  const legacyIndexCache = {
    '2025-01-01': {
      spx: 5881.63,
      ndx: 21012.17,
      spxPriceDate: '2024-12-31',
      ndxPriceDate: '2024-12-31',
      policy: 'previous'
    }
  };
  const preexistingIndexCache = {
    '2024-01-01': {
      spx: 4769.83,
      ndx: 16825.93,
      spxPriceDate: '2023-12-29',
      ndxPriceDate: '2023-12-29',
      policy: 'previous'
    },
    '2025-01-01': {
      spx: 1,
      ndx: 1,
      spxPriceDate: '2024-12-30',
      ndxPriceDate: '2024-12-30',
      policy: 'previous'
    }
  };
  fs.writeFileSync(
    path.join(legacyDataDir, 'db.json'),
    JSON.stringify({ ...originalDb, indexCache: legacyIndexCache }, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(legacyDataDir, 'index-cache.json'),
    JSON.stringify(preexistingIndexCache, null, 2),
    'utf8'
  );
  let legacyStorage = loadStorage(legacyDataDir, legacyBackupDir);
  const consoleErrorBeforeInterruptedMigration = console.error;
  try {
    console.error = () => {};
    fs.renameSync = (source, target) => {
      if (target === legacyStorage.DB_FILE && source.endsWith('.tmp')) {
        throw new Error('simulated legacy db migration interruption');
      }
      return originalRenameSync(source, target);
    };
    assert.throws(
      () => legacyStorage.readDb(),
      /simulated legacy db migration interruption/
    );
  } finally {
    fs.renameSync = originalRenameSync;
    console.error = consoleErrorBeforeInterruptedMigration;
  }
  assert.strictEqual(Object.prototype.hasOwnProperty.call(
    JSON.parse(fs.readFileSync(legacyStorage.DB_FILE, 'utf8')),
    'indexCache'
  ), true);
  assert.deepStrictEqual(legacyStorage.readIndexCache(), {
    ...preexistingIndexCache,
    ...legacyIndexCache
  });

  legacyStorage = loadStorage(legacyDataDir, legacyBackupDir);
  const migratedDb = legacyStorage.readDb();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(migratedDb, 'indexCache'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(
    JSON.parse(fs.readFileSync(legacyStorage.DB_FILE, 'utf8')),
    'indexCache'
  ), false);
  assert.deepStrictEqual(legacyStorage.readIndexCache(), {
    ...preexistingIndexCache,
    ...legacyIndexCache
  });
  assert.strictEqual(fs.readdirSync(legacyBackupDir).length, 0);

  // The first v3.13.0 build nested custom quotes under each index date. Move
  // those records into their own disposable cache and clean the index file.
  const splitCacheDataDir = path.join(testRoot, 'data-split-custom-cache');
  const splitCacheBackupDir = path.join(testRoot, 'backups-split-custom-cache');
  fs.mkdirSync(splitCacheDataDir, { recursive: true });
  const legacyCustomEntry = {
    signature: 'VOO:100.0000',
    components: { VOO: { price: 612.5, priceDate: '2026-08-03' } }
  };
  fs.writeFileSync(path.join(splitCacheDataDir, 'index-cache.json'), JSON.stringify({
    '2026-08-04': { ...indexCache['2026-08-04'], custom: legacyCustomEntry }
  }, null, 2));
  const splitCacheStorage = loadStorage(splitCacheDataDir, splitCacheBackupDir);
  assert.deepStrictEqual(splitCacheStorage.readCustomBenchmarkCache(), {
    '2026-08-04': legacyCustomEntry
  });
  assert.deepStrictEqual(splitCacheStorage.readIndexCache(), {
    '2026-08-04': indexCache['2026-08-04']
  });
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(splitCacheStorage.CUSTOM_BENCHMARK_CACHE_FILE, 'utf8')),
    { '2026-08-04': legacyCustomEntry }
  );

  // A corrupt disposable cache degrades to an in-memory empty cache once per
  // process instead of reparsing the same bad file and flooding logs on every
  // API read.
  const malformedDataDir = path.join(testRoot, 'data-malformed-index');
  const malformedBackupDir = path.join(testRoot, 'backups-malformed-index');
  fs.mkdirSync(malformedDataDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDataDir, 'index-cache.json'), '{bad json', 'utf8');
  const malformedStorage = loadStorage(malformedDataDir, malformedBackupDir);
  let cacheReadErrors = 0;
  const consoleErrorBeforeMalformedRead = console.error;
  try {
    console.error = () => { cacheReadErrors += 1; };
    assert.deepStrictEqual(malformedStorage.readIndexCache(), {});
    assert.deepStrictEqual(malformedStorage.readIndexCache(), {});
  } finally {
    console.error = consoleErrorBeforeMalformedRead;
  }
  assert.strictEqual(cacheReadErrors, 1);

  console.log('Storage, index-cache recovery, backup ordering and snapshot rollback assertions passed.');
} finally {
  if (originalDataDir === undefined) delete process.env.FUND_DATA_DIR;
  else process.env.FUND_DATA_DIR = originalDataDir;
  if (originalBackupDir === undefined) delete process.env.FUND_BACKUP_DIR;
  else process.env.FUND_BACKUP_DIR = originalBackupDir;
  delete require.cache[storagePath];
  fs.rmSync(testRoot, { recursive: true, force: true });
}
