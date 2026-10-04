const { registerApiRoutes } = require('../../routes/api');
const { calculateStateFromDb } = require('../../lib/calculator');
const { mergeSettlementLedger } = require('../../lib/settlement-ledger');
const { materializeBenchmarkCaches } = require('../../lib/market-history');
const { InputError } = require('../../lib/api-errors');
const { version } = require('../../package.json');
const clone = value => JSON.parse(JSON.stringify(value));
const STORAGE_KEY = 'family_fund_demo_sandbox_v1';

function createSandbox(seed, storage) {
  let state = clone(seed);
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    if (saved?.version === version && saved.state?.db && saved.state?.settlements && saved.state?.config) {
      state = saved.state;
      calculateStateFromDb(mergeSettlementLedger(state.db, state.settlements));
    }
  } catch (_) { state = clone(seed); }
  function save() {
    try { storage.setItem(STORAGE_KEY, JSON.stringify({ version, state })); }
    catch (_) { throw new InputError('浏览器无法保存体验数据，请释放当前站点存储空间或允许会话存储。'); }
  }
  const readConfig = () => clone(state.config);
  const readDb = () => mergeSettlementLedger(clone({ ...state.db, ...state.config,
    cnhRate: state.cnhRate, indexCache: state.indexCache,
    customBenchmarkCache: state.customBenchmarkCache, marketHistory: state.marketHistory }), clone(state.settlements));
  const supported = new Set(Object.keys(seed.tickerCache.tickers));
  function validateConfig(config) {
    const tickers = [...config.tickers.map(item => item.ticker),
      ...[config.customBenchmark, config.customBenchmark2].flatMap(item => item?.components.map(component => component.ticker) || [])];
    if (tickers.some(ticker => !supported.has(ticker))) {
      throw new InputError('体验版离线行情支持 AAPL、GOOGL、VGT。可调整这些标的及组合权重；其他标的请在本地完整版中使用。');
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
      state.db = clone({ members, performanceFee, benchmarkClosePolicy, lastEventSequence,
        events: db.events.filter(event => !['performance_settlement', 'performance_settlement_reversal'].includes(event.type)) });
      save();
    },
    readSettlements: () => clone(state.settlements),
    writeSettlements: ledger => { state.settlements = clone(ledger); save(); },
    writeConfig: config => { validateConfig(config); state.config = clone(config); save(); },
    readTickerCache: () => clone(state.tickerCache),
    writeTickerCache: cache => { state.tickerCache = clone(cache); save(); },
    readIndexCache: () => clone(state.indexCache),
    writeIndexCache: cache => { state.indexCache = clone(cache); save(); },
    readCustomBenchmarkCache: () => clone(state.customBenchmarkCache),
    writeCustomBenchmarkCache: cache => { state.customBenchmarkCache = clone(cache); save(); },
    writeCnhRate: rate => { state.cnhRate = rate; save(); },
    writeSnapshot: (db, config, settlements) => {
      validateConfig(config);
      state.db = clone(db); state.config = clone(config); state.settlements = clone(settlements); save();
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
    randomUUID: () => globalThis.crypto.randomUUID(),
    now: () => new Date()
  };
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (pattern, ...handlers) => routes.push({ method: method.toUpperCase(), pattern, handlers });
  }
  registerApiRoutes(app, deps);
  let queue = Promise.resolve();
  function request(url, options = {}) {
    const task = queue.then(async () => {
      const parsed = new URL(url, 'https://demo.invalid');
      const method = (options.method || 'GET').toUpperCase();
      let params;
      const route = routes.find(candidate => {
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
      if (!route) throw new InputError('体验版不支持此操作。');
      const before = clone(state);
      try {
        let body = options.body;
        if (body && typeof body.arrayBuffer === 'function') {
          if (body.size > 10 * 1024 * 1024) throw new InputError('ZIP 备份最大为 10MB。');
          body = Buffer.from(await body.arrayBuffer());
        } else if (typeof body === 'string') body = JSON.parse(body);
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
    exportBackup: () => request('/api/backup/export'),
    snapshot: () => clone(state) };
}

if (typeof window !== 'undefined' && document.querySelector('meta[name="fund-demo-sandbox"]')) {
  const ready = fetch(new URL('demo-data/seed.json', window.location.href))
    .then(response => { if (!response.ok) throw new Error('演示数据加载失败，请刷新页面重试。'); return response.json(); })
    .then(seed => createSandbox(seed, window.sessionStorage));
  // Avoid an unhandled rejection while the page finishes loading.
  ready.catch(() => {});
  window.FundDemoSandbox = { ready, request: async (...args) => (await ready).request(...args),
    reset: async () => (await ready).reset(), exportBackup: async () => (await ready).exportBackup() };
}
module.exports = { createSandbox };
