const { registerApiRoutes } = require('../../routes/api');
const { calculateStateFromDb } = require('../../lib/calculator');
const { mergeSettlementLedger } = require('../../lib/settlement-ledger');
const { materializeBenchmarkCaches } = require('../../lib/market-history');
const { InputError, NotFoundError } = require('../../lib/api-errors');
const { combineLedgers } = require('../../lib/combined-overview');
const { DEFAULT_PERFORMANCE_FEE_CONFIG } = require('../../lib/performance-fee-policy');
const { version } = require('../../package.json');
const { generateMemberId } = require('../../lib/member-id');
const clone = value => JSON.parse(JSON.stringify(value));
const STORAGE_KEY = 'family_fund_demo_sandbox_v1';

function createSandbox(seed, storage) {
  let state = clone(seed);
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    if (saved?.version === version && saved.state?.db && saved.state?.settlements && saved.state?.config) {
      state = saved.state;
      calculateStateFromDb(mergeSettlementLedger(state.db, state.settlements));
      for (const [id, entry] of Object.entries(state.ledgers || {})) {
        if (!/^ledger-[2-9]$|^ledger-[1-9][0-9]{1,2}$/.test(id) || typeof entry.name !== 'string' ||
            !entry.name.trim() || entry.name.length > 50) throw new Error('Invalid saved ledger');
        calculateStateFromDb(mergeSettlementLedger(entry.db, entry.settlements));
      }
    }
  } catch (_) { state = clone(seed); }
  state.ledgers ||= {};
  state.defaultName ||= '样例账本';
  let activeId = 'default';
  const ledger = () => {
    if (activeId === 'default') return state;
    if (!Object.hasOwn(state.ledgers, activeId)) throw new NotFoundError('账本不存在。');
    return state.ledgers[activeId];
  };
  const listLedgers = () => [{ id: 'default', name: state.defaultName, isDefault: true },
    ...Object.entries(state.ledgers).map(([id, value]) => ({ id, name: value.name, isDefault: false }))];
  function save() {
    try { storage.setItem(STORAGE_KEY, JSON.stringify({ version, state })); }
    catch (_) { throw new InputError('浏览器无法保存体验数据，请释放当前站点存储空间或允许会话存储。'); }
  }
  const readConfig = () => clone(state.config);
  const readDb = () => {
    const current = ledger();
    const caches = materializeBenchmarkCaches(current.db.events.map(event => event.date), state.marketHistory,
      [state.config.customBenchmark, state.config.customBenchmark2], current.db.benchmarkClosePolicy || 'previous');
    return mergeSettlementLedger(clone({ ...current.db, ...state.config, ...caches,
      cnhRate: state.cnhRate, marketHistory: state.marketHistory }), clone(current.settlements));
  };
  const supported = new Set(Object.keys(seed.tickerCache.tickers));
  function validateConfig(config) {
    const tickers = [...config.tickers.map(item => item.ticker),
      ...[config.customBenchmark, config.customBenchmark2].flatMap(item => item?.components.map(component => component.ticker) || [])];
    if (tickers.some(ticker => !supported.has(ticker))) {
      throw new InputError(`体验版离线行情支持 ${[...supported].join('、')}。可调整这些标的及组合权重；其他标的请在本地完整版中使用。`);
    }
  }
  function ensureIndexCache(dates) {
    const caches = materializeBenchmarkCaches(dates, state.marketHistory,
      [state.config.customBenchmark, state.config.customBenchmark2], 'previous');
    state.indexCache = { ...state.indexCache, ...caches.indexCache };
    state.customBenchmarkCache = caches.customBenchmarkCache;
    save();
  }
  const isValidDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
  function normalizeText(value, maximum, fallback = '') {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string' || value.trim().length > maximum) throw new InputError(`文本最长为 ${maximum} 个字符。`);
    return value.trim();
  }
  const deps = {
    readDb, readConfig, calculateStateFromDb,
    getState: () => calculateStateFromDb(readDb()),
    writeDb: db => {
      const { members, performanceFee, benchmarkClosePolicy, lastEventSequence } = db;
      ledger().db = clone({ members, performanceFee, benchmarkClosePolicy, lastEventSequence,
        events: db.events.filter(event => !['performance_settlement', 'performance_settlement_reversal'].includes(event.type)) });
      save();
    },
    readSettlements: () => clone(ledger().settlements),
    writeSettlements: value => { ledger().settlements = clone(value); save(); },
    writeConfig: config => { validateConfig(config); state.config = clone(config); save(); },
    readTickerCache: () => clone(state.tickerCache),
    writeTickerCache: cache => { state.tickerCache = clone(cache); save(); },
    readIndexCache: () => clone(state.indexCache),
    writeIndexCache: cache => { state.indexCache = clone(cache); save(); },
    readCustomBenchmarkCache: () => clone(state.customBenchmarkCache),
    writeCustomBenchmarkCache: cache => { state.customBenchmarkCache = clone(cache); save(); },
    writeCnhRate: rate => { state.cnhRate = rate; save(); },
    writeSnapshot: (db, config, settlements) => {
      if (activeId === 'default') validateConfig(config);
      ledger().db = clone(db);
      if (activeId === 'default') state.config = clone(config);
      ledger().settlements = clone(settlements); save();
    },
    ensureIndexCache, isValidDate,
    normalizeRemark: (text, fallback) => normalizeText(text, 500, fallback),
    normalizeMemberName: name => {
      const normalized = normalizeText(name, 50);
      if (!normalized) throw new InputError('成员姓名不能为空。');
      return normalized;
    },
    fetchCnhRateFromApi: async () => seed.cnhRate,
    fetchTickerAthData: async config => Object.fromEntries(config.tickers.map(({ ticker }) =>
      [ticker, { ...clone(seed.tickerCache.tickers[ticker]), updatedAt: new Date().toISOString() }])),
    readBaseDb: () => clone(ledger().db),
    randomUUID: () => globalThis.crypto.randomUUID(),
    now: () => new Date()
  };
  // Each ledger gets its own sequence/token context; requests are serialized.
  const applications = new Map();
  function routesFor(id) {
    if (!applications.has(id)) {
      const routes = []; const app = {};
      for (const method of ['get', 'post', 'put', 'delete']) {
        app[method] = (pattern, ...handlers) => routes.push({ method: method.toUpperCase(), pattern, handlers });
      }
      registerApiRoutes(app, deps); applications.set(id, routes);
    }
    return applications.get(id);
  }
  function ledgerOperation(pathname, method, body) {
    if (pathname === '/api/ledgers' && method === 'GET') return listLedgers();
    if (pathname === '/api/ledgers/combined' && method === 'GET') {
      const selected = activeId;
      try {
        return combineLedgers(listLedgers().map(entry => {
          activeId = entry.id;
          return { ...entry, state: deps.getState() };
        }));
      } finally { activeId = selected; }
    }
    if (method !== 'POST' && method !== 'PATCH') throw new InputError('体验版不支持此操作。');
    const name = body?.name;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) {
      throw new InputError('账本名称长度必须在 1 到 50 个字符之间。');
    }
    if (pathname === '/api/ledgers' && method === 'POST') {
      if (listLedgers().length >= 100) throw new InputError('最多可创建 100 个账本。');
      let number = 2; while (Object.hasOwn(state.ledgers, 'ledger-' + number)) number++;
      const id = 'ledger-' + number;
      const used = new Set();
      state.ledgers[id] = { name: name.trim(), db: {
        benchmarkClosePolicy: 'previous', performanceFee: clone(DEFAULT_PERFORMANCE_FEE_CONFIG),
        members: ['我', '母亲', '父亲'].map(name => ({ id: generateMemberId(used), name, roles: { lp: true, gp: false } })),
        events: [], lastEventSequence: 0
      }, settlements: { version: 1, records: [] } };
      return { id, name: name.trim(), isDefault: false };
    }
    const id = pathname.slice('/api/ledgers/'.length);
    if (method !== 'PATCH' || !listLedgers().some(entry => entry.id === id)) throw new NotFoundError('账本不存在。');
    if (id === 'default') state.defaultName = name.trim(); else state.ledgers[id].name = name.trim();
    return listLedgers().find(entry => entry.id === id);
  }
  let queue = Promise.resolve();
  function request(url, options = {}) {
    const task = queue.then(async () => {
      const parsed = new URL(url, 'https://demo.invalid');
      const method = (options.method || 'GET').toUpperCase();
      const header = Object.entries(options.headers || {}).find(([key]) => key.toLowerCase() === 'x-ledger-id')?.[1];
      const query = parsed.searchParams.get('ledger');
      if (header !== undefined && query !== null && header !== query) throw new InputError('账本选择不一致。');
      activeId = header ?? query ?? 'default';
      const management = parsed.pathname === '/api/ledgers' || parsed.pathname.startsWith('/api/ledgers/');
      if (!management) ledger();
      let params;
      const route = management ? null : routesFor(activeId).find(candidate => {
        if (candidate.method !== method) return false;
        const actual = parsed.pathname.split('/'); const expected = candidate.pattern.split('/');
        if (actual.length !== expected.length) return false;
        const values = {};
        for (let i = 0; i < actual.length; i++) {
          if (expected[i].startsWith(':')) values[expected[i].slice(1)] = decodeURIComponent(actual[i]);
          else if (actual[i] !== expected[i]) return false;
        }
        params = values; return true;
      });
      if (!management && !route) throw new InputError('体验版不支持此操作。');
      const before = clone(state);
      try {
        let body = options.body;
        if (body && typeof body.arrayBuffer === 'function') {
          if (body.size > 10 * 1024 * 1024) throw new InputError('ZIP 备份最大为 10MB。');
          body = Buffer.from(await body.arrayBuffer());
        } else if (typeof body === 'string') body = JSON.parse(body);
        if (management) {
          const data = ledgerOperation(parsed.pathname, method, body);
          if (method !== 'GET') save();
          return { success: true, data };
        }
        const req = { method, originalUrl: url, params, query: Object.fromEntries(parsed.searchParams), body: body || {} };
        let result; const headers = {};
        const res = { json: value => { result = value; }, send: value => { result = { binary: value, headers }; },
          set: (name, value) => { headers[name] = value; return res; }, setHeader: (name, value) => { headers[name] = value; },
          status: () => res };
        async function run(index) {
          const handler = route.handlers[index]; if (!handler) return;
          return handler(req, res, error => { if (error) throw error; return run(index + 1); });
        }
        await run(0);
        if (!result?.success && !result?.binary) throw new InputError(result?.message || '体验操作未完成。');
        if (parsed.pathname === '/api/settings/sync-rate') result.message = '已重新载入演示汇率快照。';
        if (method !== 'GET') save();
        return result;
      } catch (error) {
        state = before;
        try { save(); } catch (_) { /* Preserve the original failure. */ }
        throw error;
      }
    });
    queue = task.catch(() => {});
    return task;
  }
  return { request, reset: () => { storage.removeItem(STORAGE_KEY); },
    exportBackup: (id = 'default') => request('/api/backup/export', { headers: { 'X-Ledger-Id': id } }),
    snapshot: () => clone(state) };
}

if (typeof window !== 'undefined' && document.querySelector('meta[name="fund-demo-sandbox"]')) {
  const ready = fetch(new URL('demo-data/seed.json', window.location.href))
    .then(response => { if (!response.ok) throw new Error('演示数据加载失败，请刷新页面重试。'); return response.json(); })
    .then(seed => createSandbox(seed, window.sessionStorage));
  // Avoid an unhandled rejection while the page finishes loading.
  ready.catch(() => {});
  window.FundDemoSandbox = { ready, request: async (...args) => (await ready).request(...args),
    reset: async () => (await ready).reset(), exportBackup: async () => (await ready).exportBackup(window.FundLedger?.id || 'default') };
}
module.exports = { createSandbox };
