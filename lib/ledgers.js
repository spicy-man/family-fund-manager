const fs = require('fs');
const path = require('path');
const { InputError, NotFoundError, StorageError } = require('./api-errors');
const { LOCK_NAME } = require('./data-directory-lock');

// Selection belongs to a request, never to a process-wide current ledger.
function registerLedgerRoutes(app, { defaultStorage, createLedgerApplication, getDefaultState }) {
  const root = path.dirname(defaultStorage.DB_FILE);
  const instances = new Map();
  let revision = 0;
  const sharedReads = ['readConfig', 'readIndexCache', 'readCustomBenchmarkCache', 'readMarketHistory', 'readCnhRateCache', 'readTickerCache'];
  const sharedWrites = ['writeConfig', 'writeIndexCache', 'writeCustomBenchmarkCache', 'writeMarketHistory', 'writeCnhRateCache', 'writeTickerCache'];
  for (const key of sharedWrites) {
    const write = defaultStorage[key];
    defaultStorage[key] = (...args) => { try { return write(...args); } finally { revision++; } };
  }
  const defaultSnapshot = defaultStorage.writeSnapshot;
  defaultStorage.writeSnapshot = (...args) => { try { return defaultSnapshot(...args); } finally { revision++; } };
  defaultStorage.getSharedRevision = () => revision;
  function ledgerStorage(dir, { preserveInitialBackups = false } = {}) {
    const privateStore = defaultStorage.createStorage({ dataDir: dir, backupDir: path.join(defaultStorage.BACKUP_DIR, path.basename(dir)), configReader: () => defaultStorage.readConfig(), preserveInitialBackups });
    const store = { ...privateStore, getSharedRevision: () => revision };
    for (const key of [...sharedReads, ...sharedWrites]) store[key] = (...args) => defaultStorage[key](...args);
    // Recovery/backup stays atomic within this ledger. Settings in imported
    // snapshots never overwrite the shared benchmark/ticker configuration.
    store.writeSnapshot = (db, _config, settlements) => privateStore.writeSnapshot(db, defaultStorage.readConfig(), settlements);
    return store;
  }
  const validId = id => /^ledger-[2-9]$|^ledger-[1-9][0-9]{1,2}$/.test(id);
  function directory(id) {
    if (!validId(id)) throw new NotFoundError('账本不存在。');
    const dir = path.join(root, id);
    if (!fs.existsSync(dir)) throw new NotFoundError('账本不存在。');
    // Reject junctions/symlinks so a selected ledger cannot alias another one.
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink() ||
        fs.realpathSync(dir).toLowerCase() !== path.join(fs.realpathSync(root), id).toLowerCase()) {
      throw new StorageError('账本目录无效。');
    }
    return dir;
  }
  function metadata(id) {
    const file = path.join(id === 'default' ? root : directory(id), 'ledger.json');
    if (id === 'default' && !fs.existsSync(file)) return { id, name: '账本1', isDefault: true };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.id !== id || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 50) {
      throw new StorageError('账本信息损坏。');
    }
    return { id, name: value.name, isDefault: id === 'default' };
  }
  function list() {
    return [metadata('default'),
      ...fs.readdirSync(root).filter(id => validId(id) && fs.existsSync(path.join(root, id, 'ledger.json'))).sort((a,b) => Number(a.slice(7)) - Number(b.slice(7))).map(metadata)];
  }
  function instance(id) {
    metadata(id);
    if (!instances.has(id)) {
      const dir = directory(id);
      const store = ledgerStorage(dir);
      try {
        const application = createLedgerApplication(store);
        instances.set(id, { storage: store, app: application.app, getState: application.getState });
        application.syncLedgerBenchmarks();
      } catch (error) { store.releaseDataDirectoryLock(); throw error; }
    }
    return instances.get(id);
  }
  app.get('/api/ledgers', (_req, res, next) => {
    try { res.json({ success: true, data: list() }); } catch (error) { next(error); }
  });
  app.get('/api/ledgers/combined', (_req, res, next) => {
    try {
      const entries = list().map(ledger => ({
        ...ledger,
        state: ledger.id === 'default' ? getDefaultState() : instance(ledger.id).getState()
      }));
      res.json({ success: true, data: require('./combined-overview').combineLedgers(entries) });
    } catch (error) { next(error); }
  });
  app.post('/api/ledgers', (req, res, next) => {
    try {
      const name = req.body?.name;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) {
        throw new InputError('账本名称长度必须在 1 到 50 个字符之间。');
      }
      const entries = list();
      if (entries.length >= 100) throw new InputError('最多可创建 100 个账本。');
      let id;
      for (let number = 2; number <= 999; number++) {
        const candidate = 'ledger-' + number;
        if (!fs.existsSync(path.join(root, candidate))) { id = candidate; break; }
      }
      if (!id) throw new InputError('账本数量已达上限。');
      const dir = path.join(root, id);
      const backupDir = path.join(defaultStorage.BACKUP_DIR, id);
      const hadBackups = fs.existsSync(backupDir);
      const previousBackups = new Set(hadBackups ? fs.readdirSync(backupDir) : []);
      fs.mkdirSync(dir); // Never overwrite an existing directory.
      let store;
      try {
        store = ledgerStorage(dir, { preserveInitialBackups: true });
        // Initialize a fresh ledger; do not copy the default ledger's data.
        store.writeSnapshot(store.readDb(), store.readConfig(), store.readSettlements());
        const application = createLedgerApplication(store);
        // Publish metadata only after all initialization has succeeded.
        store.atomicWriteFile(path.join(dir, 'ledger.json'), JSON.stringify({ id, name: name.trim() }, null, 2));
        instances.set(id, { storage: store, app: application.app, getState: application.getState });
      } catch (error) {
        try {
          store?.releaseDataDirectoryLock();
          // Keep an ambiguous lease intact. Only remove paths created by this
          // request, and preserve any backups that already existed.
          if (!fs.existsSync(path.join(dir, LOCK_NAME))) {
            fs.rmSync(dir, { recursive: true, force: true });
            if (!hadBackups) fs.rmSync(backupDir, { recursive: true, force: true });
            else for (const name of fs.readdirSync(backupDir)) {
              if (!previousBackups.has(name) && name.startsWith('snapshot_backup_') && name.endsWith('.zip')) {
                fs.unlinkSync(path.join(backupDir, name));
              }
            }
          }
        } catch (cleanupError) { console.error('[Ledger creation cleanup]:', cleanupError); }
        throw error;
      }
      res.status(201).json({ success: true, data: metadata(id) });
    } catch (error) { next(error); }
  });
  app.patch('/api/ledgers/:id', (req, res, next) => {
    try {
      const id = req.params.id;
      const name = req.body?.name;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) throw new InputError('账本名称长度必须在 1 到 50 个字符之间。');
      metadata(id);
      const store = id === 'default' ? defaultStorage : instance(id).storage;
      store.atomicWriteFile(path.join(id === 'default' ? root : directory(id), 'ledger.json'), JSON.stringify({ id, name: name.trim() }, null, 2));
      res.json({ success: true, data: metadata(id) });
    } catch (error) { next(error); }
  });
  app.use('/api', (req, res, next) => {
    try {
      if (req.path === '/demo' || req.path.startsWith('/demo/')) return next();
      const header = req.get('X-Ledger-Id');
      const query = req.query.ledger;
      if (query !== undefined && (typeof query !== 'string' || !query)) throw new InputError('账本选择无效。');
      if (header !== undefined && query !== undefined && header !== query) throw new InputError('账本选择不一致。');
      const id = header ?? query ?? 'default';
      if (id === 'default') return next();
      // Express strips /api at this mount; restore it for the isolated app.
      const url = req.url;
      req.url = '/api' + url;
      instance(id).app(req, res, error => { req.url = url; next(error); });
    } catch (error) { next(error); }
  });
}
module.exports = { registerLedgerRoutes };
