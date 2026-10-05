const assert = require('assert');
const { parseYahooPricesResponse } = require('../lib/yahoo');
const { emptyMarketHistory, normalizeMarketHistory, replaceAdjustedTickerPrices,
  materializeBenchmarkCaches, historyRequestStart } = require('../lib/market-history');
const { calculateStateFromDb } = require('../lib/calculator');
const response = closes => ({ chart: { result: [{
  timestamp: ['2025-12-31', '2026-06-01', '2026-06-02'].map(date => Date.parse(date) / 1000),
  indicators: { quote: [{ close: [100, 110, 108.9] }], adjclose: [{ adjclose: closes }] }
}] } });
assert.deepStrictEqual(parseYahooPricesResponse(response([99, 108.9, 108.9]), { adjusted: true }),
  { '2025-12-31': 99, '2026-06-01': 108.9, '2026-06-02': 108.9 });
const missingAdjusted = response([]);
delete missingAdjusted.chart.result[0].indicators.adjclose;
assert.deepStrictEqual(parseYahooPricesResponse(missingAdjusted, { adjusted: true }), {},
  'missing adjusted close must never fall back to price-only close');
assert.strictEqual(Object.keys(parseYahooPricesResponse(response([99, null, NaN]), { adjusted: true })).length, 1);
const history = emptyMarketHistory();
for (const ticker of ['VOO', 'QQQM']) replaceAdjustedTickerPrices(history, ticker,
  { '2025-12-31': 100, '2026-06-01': 110 }, { from: '2025-12-18', through: '2026-06-01' });
const oldCaches = materializeBenchmarkCaches(['2026-01-02', '2026-06-02'], history);
// Ex-dividend: all previous closes change, including the inception and YTD anchors.
for (const ticker of ['VOO', 'QQQM']) replaceAdjustedTickerPrices(history, ticker,
  parseYahooPricesResponse(response([99, 108.9, 108.9]), { adjusted: true }),
  { from: '2025-12-18', through: '2026-06-02' });
const refreshed = materializeBenchmarkCaches(['2026-01-02', '2026-06-02', '2026-06-03'], history);
assert.strictEqual(refreshed.indexCache['2026-01-01'].spx, 99);
assert.strictEqual(refreshed.indexCache['2026-01-02'].spx, 99);
assert.strictEqual(refreshed.indexCache['2026-06-03'].spx / refreshed.indexCache['2026-06-02'].spx, 1,
  'the ex-dividend price drop must not create a benchmark loss');
assert.strictEqual(historyRequestStart(history.tickers.VOO, '2026-05-01'), '2025-12-18');
const saved = JSON.stringify(history);
assert.strictEqual(replaceAdjustedTickerPrices(history, 'VOO', { '2026-06-02': 54.45 }), false);
assert.strictEqual(replaceAdjustedTickerPrices(history, 'VOO', {}), false);
assert.strictEqual(JSON.stringify(history), saved, 'failed or partial refresh must preserve one complete vintage');
const state = calculateStateFromDb({ members: [{ id: 'a', name: 'A' }], cnhRate: 7,
  events: [{ id: 'd', type: 'deposit', member: 'a', amount: 100, date: '2026-01-02' },
    { id: 'v', type: 'valuation', totalNAV: 100, date: '2026-06-03' }],
  marketHistory: history, indexCache: oldCaches.indexCache });
assert.strictEqual(state.charts.navHistory[1].sp500NAV, 1.1,
  'daily adjusted history must override every stale snapshot after an action');
const legacyOnlyState = calculateStateFromDb({ members: [{ id: 'a', name: 'A' }], cnhRate: 7,
  events: [{ id: 'd', type: 'deposit', member: 'a', amount: 100, date: '2026-01-02' }],
  indexCache: { '2026-01-02': { spx: 5000, ndx: 18000, policy: 'previous',
    spxPriceDate: '2025-12-31', ndxPriceDate: '2025-12-31' } } });
assert.strictEqual(legacyOnlyState.settings.benchmarkCacheReady, false);
assert.strictEqual(legacyOnlyState.charts.navHistory[0].sp500NAV, null,
  'pending migration must not manufacture a flat benchmark');
// Splits also rebase the complete series without changing historical returns.
replaceAdjustedTickerPrices(history, 'VOO', { '2025-12-31': 49.5, '2026-06-01': 54.45,
  '2026-06-02': 54.45, '2026-06-03': 55 }, { from: '2025-12-18' });
assert.strictEqual(history.tickers.VOO.prices['2025-12-31'], 49.5);
assert.strictEqual(normalizeMarketHistory({ tickers: { VOO: { prices: { '2025-12-31': 100 } } } })
  .tickers.VOO.priceBasis, 'close');
assert.deepStrictEqual(materializeBenchmarkCaches(['2026-01-02'], {
  tickers: { VOO: { prices: { '2025-12-31': 100 } }, QQQM: { prices: { '2025-12-31': 200 } } }
}).indexCache, {}, 'legacy price-only history must be refetched, never relabeled');
console.log('Adjusted benchmark parsing, dividend/split rebasing and failure protection passed.');

// Exercise the real worker with a newer action and only one requested NAV date.
(async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-adjusted-sync-'));
  process.env.FUND_DATA_DIR = temporary;
  process.env.FUND_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.FUND_EXTERNAL_SYNC = '0';
  const yahoo = require('../lib/yahoo');
  const originalFetch = yahoo.fetchYahooPrices;
  const requests = [];
  yahoo.fetchYahooPrices = async (ticker, start, end, options) => {
    requests.push({ ticker, start, options });
    return { '2025-12-31': 99, '2026-06-01': 108.9, '2026-06-02': 108.9 };
  };
  try {
    const storage = require('../lib/storage');
    const db = storage.readDb();
    storage.writeDb({ ...db, members: [{ id: 'a', name: 'A' }], events: [
      { id: 'd', type: 'deposit', member: 'a', amount: 100, date: '2026-01-02', sequenceNumber: 1 },
      { id: 'v', type: 'valuation', totalNAV: 100, date: '2026-06-03', sequenceNumber: 2 }
    ] });
    const before = emptyMarketHistory();
    for (const ticker of ['VOO', 'QQQM']) replaceAdjustedTickerPrices(before, ticker,
      { '2025-12-31': 100, '2026-06-01': 110 }, { from: '2025-12-18' });
    storage.writeMarketHistory(before);
    storage.writeIndexCache(oldCaches.indexCache);
    const { ensureIndexCache } = require('../server');
    await ensureIndexCache(['2026-06-03']);
    const cache = storage.readIndexCache();
    assert.strictEqual(cache['2026-01-02'].spx, 99, 'worker must rebuild inception outside the request');
    assert.strictEqual(cache['2026-01-01'].spx, 99, 'worker must rebuild YTD anchors');
    assert.strictEqual(cache['2026-06-03'].source, 'VOO/QQQM:adjusted-close');
    assert.deepStrictEqual(requests.map(request => request.ticker).sort(), ['QQQM', 'VOO']);
    assert(requests.every(request => request.options.adjusted === true &&
      request.start === Date.parse('2025-12-18') / 1000));
    console.log('Real benchmark worker full-history request and all-date rebuilding passed.');
  } finally {
    yahoo.fetchYahooPrices = originalFetch;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
