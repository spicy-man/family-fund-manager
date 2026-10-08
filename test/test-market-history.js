const assert = require('assert');
const {
  emptyMarketHistory,
  roundMarketPrice,
  normalizeMarketHistory,
  replaceAdjustedTickerPrices,
  mergeTickerPrices,
  previousWeekday,
  historyRequestStart,
  mergeCustomBenchmarkCaches,
  materializeBenchmarkCaches,
  benchmarkDates,
  createCloseLookup
} = require('../lib/market-history');
const {
  normalizeCustomBenchmark,
  customBenchmarkSignature
} = require('../lib/custom-benchmark');
const { calculateStateFromDb, findCustomBenchmarkEntry } = require('../lib/calculator');
const { performance } = require('perf_hooks');
const { createPriceLookup } = require('../lib/yahoo');

const benchmark = normalizeCustomBenchmark({
  name: 'Portfolio',
  components: [{ ticker: 'VGT', weight: 100 }]
});
const benchmark2 = normalizeCustomBenchmark({
  name: 'BRK-B',
  components: [{ ticker: 'BRK-B', weight: 100 }]
});
// Prices must be quantized before comparing refreshes and generating snapshots.
const precisionHistory = emptyMarketHistory();
const precisionCoverage = { from: '2025-06-20', through: '2025-06-20', priceBasis: 'adjusted-close' };
for (const ticker of ['VOO', 'QQQM', 'VGT', 'BRK-B']) {
  assert.strictEqual(replaceAdjustedTickerPrices(precisionHistory, ticker,
    { '2025-06-20': 166.059235 }, precisionCoverage), true);
  assert.strictEqual(precisionHistory.tickers[ticker].prices['2025-06-20'], 166.059);
  assert.strictEqual(replaceAdjustedTickerPrices(precisionHistory, ticker,
    { '2025-06-20': 166.059219 }, precisionCoverage), false,
    'provider noise below stored precision must not change adjusted history');
  assert.strictEqual(mergeTickerPrices(precisionHistory, ticker,
    { '2025-06-20': 166.059219 }, precisionCoverage), false);
}
const legacyPrecisionHistory = { tickers: { VOO: { ...precisionHistory.tickers.VOO,
  prices: { '2025-06-20': 166.059235 } } } };
assert.strictEqual(replaceAdjustedTickerPrices(normalizeMarketHistory(legacyPrecisionHistory), 'VOO',
  { '2025-06-20': 166.059219 }, precisionCoverage), true,
  'the next refresh must migrate existing high-precision history even when quotes are unchanged');
const preciseCaches = materializeBenchmarkCaches(['2025-06-21'], precisionHistory, [benchmark, benchmark2]);
assert.strictEqual(preciseCaches.indexCache['2025-06-21'].spx, 166.059);
assert.strictEqual(preciseCaches.indexCache['2025-06-21'].ndx, 166.059);
assert.strictEqual(preciseCaches.customBenchmarkCache['2025-06-21'].components.VGT.price, 166.059);
assert.strictEqual(preciseCaches.customBenchmarkCache['2025-06-21'].secondary.components['BRK-B'].price, 166.059);
assert.strictEqual(normalizeMarketHistory({ tickers: { VOO: { prices: { '2025-06-20': 166.059235 } } } }, { roundPrices: true })
  .tickers.VOO.prices['2025-06-20'], 166.059);
assert.strictEqual(replaceAdjustedTickerPrices(precisionHistory, 'VOO',
  { '2025-06-20': 166.060235 }, precisionCoverage), true, 'a real three-decimal price change still updates');
assert.strictEqual(precisionHistory.tickers.VOO.prices['2025-06-20'], 166.06);

// Fixed decimals cannot flatten real returns in low-price split-adjusted history.
for (const price of [0.00149, 0.00449, 0.01234, 0.04999, 0.12345, 0.9999]) {
  assert(Math.abs(roundMarketPrice(price) / price - 1) < 0.005,
    'price rounding must not introduce a material relative error: ' + price);
  assert.strictEqual(roundMarketPrice(roundMarketPrice(price)), roundMarketPrice(price));
}
const lowHistory = emptyMarketHistory();
replaceAdjustedTickerPrices(lowHistory, 'VGT', { '1981-01-02': 0.0014, '1981-01-05': 0.00149 }, { priceBasis: 'adjusted-close' });
const lowCaches = materializeBenchmarkCaches(['1981-01-03', '1981-01-06'], lowHistory, [benchmark]);
const lowStart = lowCaches.customBenchmarkCache['1981-01-03'].components.VGT.price;
const lowEnd = lowCaches.customBenchmarkCache['1981-01-06'].components.VGT.price;
assert(Math.abs((lowEnd / lowStart - 1) - (0.00149 / 0.0014 - 1)) < 0.001,
  'a real low-price return must survive persistence and benchmark materialization');
// Low split-adjusted closes must survive rounding, reload and snapshot replay.
assert.strictEqual(roundMarketPrice(0.000123456), 0.000123);
assert.strictEqual(roundMarketPrice(Number.MIN_VALUE), Number.MIN_VALUE);
for (const price of [0.00049999, 0.0005, 0.00099999, 0.001, 166.059235]) {
  assert(roundMarketPrice(price) > 0);
  assert.strictEqual(roundMarketPrice(roundMarketPrice(price)), roundMarketPrice(price),
    'normalization must be idempotent across merge, persistence and materialization');
}
const tinyHistory = emptyMarketHistory();
const tinyCoverage = { from: '1981-01-02', through: '1981-01-05', priceBasis: 'adjusted-close' };
const tinyPrices = { '1981-01-02': 0.000123456, '1981-01-05': 0.000246912 };
for (const ticker of ['VOO', 'QQQM', 'VGT', 'BRK-B']) {
  assert.strictEqual(replaceAdjustedTickerPrices(tinyHistory, ticker, tinyPrices, tinyCoverage), true);
  assert.strictEqual(replaceAdjustedTickerPrices(tinyHistory, ticker,
    { ...tinyPrices, '1981-01-02': 0.000123459 }, tinyCoverage), false);
  assert.strictEqual(mergeTickerPrices(tinyHistory, ticker, tinyPrices, tinyCoverage), false);
  assert.strictEqual(replaceAdjustedTickerPrices(tinyHistory, ticker,
    Object.fromEntries(Object.entries(tinyPrices).reverse()), tinyCoverage), false,
    'unchanged prices in a different provider order must not dirty history');
  assert.strictEqual(replaceAdjustedTickerPrices(tinyHistory, ticker,
    { '1981-01-02': tinyPrices['1981-01-02'] }, tinyCoverage), false,
    'incomplete adjusted history still cannot erase a trading day');
}
const tinyReload = normalizeMarketHistory(JSON.parse(JSON.stringify(
  normalizeMarketHistory(tinyHistory, { roundPrices: true }))));
assert.strictEqual(tinyReload.tickers.VGT.prices['1981-01-02'], 0.000123);
const tinyCaches = materializeBenchmarkCaches(['1981-01-03'], tinyReload, [benchmark, benchmark2]);
assert.strictEqual(tinyCaches.indexCache['1981-01-03'].spx, 0.000123);
assert.strictEqual(tinyCaches.customBenchmarkCache['1981-01-03'].components.VGT.price, 0.000123);
assert.strictEqual(tinyCaches.customBenchmarkCache['1981-01-03'].secondary.components['BRK-B'].price, 0.000123);

const history = emptyMarketHistory();
const daily = {
  'VOO': { '2026-08-27': 7730.99, '2026-08-28': 7711.76 },
  'QQQM': { '2026-08-27': 29641.56, '2026-08-28': 29433.43 },
  VGT: { '2026-08-27': 121.91, '2026-08-28': 120.07 },
  'BRK-B': { '2026-08-27': 503.7, '2026-08-28': 505 }
};
for (const [ticker, prices] of Object.entries(daily)) {
  mergeTickerPrices(history, ticker, prices, {
    from: '2026-08-01',
    through: '2026-08-31', priceBasis: 'adjusted-close'
  });
}

assert.strictEqual(previousWeekday('2026-08-31'), '2026-08-28');
assert.strictEqual(previousWeekday('2026-08-30'), '2026-08-28');

assert.strictEqual(historyRequestStart({
  fetchedFrom: '2026-01-01',
  prices: { '2026-08-28': 1 }
}, '2025-12-18'), '2025-12-18', 'an older ledger date must expand historical coverage');
assert.strictEqual(historyRequestStart({
  fetchedFrom: '2025-01-01',
  prices: { '2026-08-28': 1 }
}, '2025-12-18'), '2025-01-01', 'adjusted history must refresh the full stored range');

const materialized = materializeBenchmarkCaches(
  ['2026-08-28', '2026-08-31'],
  history,
  [benchmark, benchmark2]
);
assert.strictEqual(materialized.indexCache['2026-08-28'].spxPriceDate, '2026-08-27');
assert.strictEqual(materialized.indexCache['2026-08-31'].spxPriceDate, '2026-08-28');
assert.strictEqual(
  materialized.customBenchmarkCache['2026-08-31'].components.VGT.priceDate,
  '2026-08-28'
);
assert.strictEqual(
  materialized.customBenchmarkCache['2026-08-31'].secondary.components['BRK-B'].priceDate,
  '2026-08-28'
);

const primaryOnlyUpdate = {
  '2026-08-31': {
    signature: customBenchmarkSignature(benchmark),
    components: { VGT: { price: 120.07, priceDate: '2026-08-28' } }
  }
};
const legacyDualSlotCache = {
  '2026-08-31': {
    signature: customBenchmarkSignature(benchmark),
    components: { VGT: { price: 119, priceDate: '2026-08-27' } },
    secondary: {
      signature: customBenchmarkSignature(benchmark2),
      components: { 'BRK-B': { price: 505, priceDate: '2026-08-28' } }
    }
  }
};
const mergedCustomCache = mergeCustomBenchmarkCaches(legacyDualSlotCache, primaryOnlyUpdate);
assert.strictEqual(mergedCustomCache['2026-08-31'].components.VGT.price, 120.07);
assert.strictEqual(
  mergedCustomCache['2026-08-31'].secondary.components['BRK-B'].price,
  505,
  'refreshing one custom benchmark must preserve the other slot'
);

const failedBackfillHistory = emptyMarketHistory();
mergeTickerPrices(failedBackfillHistory, 'VOO', {}, {
  from: '2020-01-01',
  through: '2026-08-31', priceBasis: 'adjusted-close'
});
assert.strictEqual(
  failedBackfillHistory.tickers['VOO'].fetchedFrom,
  null,
  'an empty provider response must not prevent a later backfill retry'
);

// A later incomplete provider response must never erase a recorded trading day.
mergeTickerPrices(history, 'VOO', { '2026-08-27': 7730.99 }, {
  from: '2026-08-20',
  through: '2026-08-31', priceBasis: 'adjusted-close'
});
assert.strictEqual(history.tickers['VOO'].prices['2026-08-28'], 7711.76);

// Raw daily history overrides a stale per-NAV cache during ledger replay.
const state = calculateStateFromDb({
  cnhRate: 7.2,
  members: [{ id: 'a', name: 'Alice', roles: { lp: true, gp: false } }],
  events: [
    { id: 'd', type: 'deposit', member: 'a', amount: 100, date: '2026-08-28', createdAt: 1 },
    { id: 'v', type: 'valuation', totalNAV: 101, date: '2026-08-31', createdAt: 2 }
  ],
  customBenchmark: benchmark,
  customBenchmark2: benchmark2,
  marketHistory: history,
  indexCache: {
    '2026-08-28': { spx: 7730.99, ndx: 29641.56, spxPriceDate: '2026-08-27', ndxPriceDate: '2026-08-27', policy: 'previous', source: 'VOO/QQQM:adjusted-close' },
    '2026-08-31': { spx: 7730.99, ndx: 29641.56, spxPriceDate: '2026-08-27', ndxPriceDate: '2026-08-27', policy: 'previous', source: 'VOO/QQQM:adjusted-close' }
  },
  customBenchmarkCache: {}
});
assert.strictEqual(state.charts.navHistory[1].spxPriceDate, '2026-08-28');
assert.strictEqual(state.charts.navHistory[1].customPriceDate, '2026-08-28');
assert.notStrictEqual(
  state.charts.navHistory[0].sp500NAV,
  state.charts.navHistory[1].sp500NAV,
  'Monday must reflect Friday even when the legacy NAV-date cache is stale'
);

console.log('Daily market history archival and NAV-date materialization assertions passed.');

// Preserve predecessor boundaries, invalid-price filtering and snapshot lifetime.
const noisyPrices = { '2026-01-05': 105, '2026-01-01': 101,
  '2026-01-04': null, '2026-01-03': NaN, '2026-01-02': -1 };
const closeLookup = createCloseLookup(noisyPrices);
assert.strictEqual(closeLookup('2026-01-01'), null);
assert.deepStrictEqual(closeLookup('2026-01-05'), { date: '2026-01-01', price: 101 });
assert.deepStrictEqual(closeLookup('2026-01-06'), { date: '2026-01-05', price: 105 });
noisyPrices['2026-01-05'] = 205;
assert.strictEqual(closeLookup('2026-01-06').price, 105);
assert.strictEqual(createCloseLookup(noisyPrices)('2026-01-06').price, 205);
const yahooLookup = createPriceLookup({ '2026-01-05': 105, '2026-01-01': 101 });
assert.strictEqual(yahooLookup('2026-01-05').price, 101);
assert.strictEqual(yahooLookup('2026-01-05', 'same_day').price, 105);
// The exported calculator helper still supports sparse legacy cache callers.
assert.deepStrictEqual(findCustomBenchmarkEntry('2026-09-01', legacyDualSlotCache, benchmark),
  legacyDualSlotCache['2026-08-31']);
assert.deepStrictEqual(findCustomBenchmarkEntry('2026-09-01', legacyDualSlotCache, benchmark2, 1),
  legacyDualSlotCache['2026-08-31'].secondary);
assert.strictEqual(findCustomBenchmarkEntry('2026-08-31', legacyDualSlotCache, benchmark2, 1),
  legacyDualSlotCache['2026-08-31'].secondary);

// A realistic multi-year workload, including both custom benchmark slots.
const largeHistory = emptyMarketHistory();
const largeBenchmarks = [
  normalizeCustomBenchmark({ name: 'Mix', components: [
    { ticker: 'VGT', weight: 50 }, { ticker: 'BRK-B', weight: 50 }
  ] }),
  normalizeCustomBenchmark({ name: 'Other', components: [
    { ticker: 'AAPL', weight: 40 }, { ticker: 'MSFT', weight: 60 }
  ] })
];
const origin = Date.parse('2012-01-01T00:00:00Z');
const dateAt = offset => new Date(origin + offset * 86400000).toISOString().slice(0, 10);
for (const [tickerIndex, ticker] of ['VOO', 'QQQM', 'VGT', 'BRK-B', 'AAPL', 'MSFT'].entries()) {
  const prices = {};
  // Insert in reverse order; weekdays plus missing days exercise predecessors.
  for (let day = 4999; day >= 0; day--) {
    if ([0, 6].includes(new Date(origin + day * 86400000).getUTCDay()) || day % 97 === 0) continue;
    prices[dateAt(day)] = 100 + tickerIndex * 20 + day / 100;
  }
  mergeTickerPrices(largeHistory, ticker, prices, { priceBasis: 'adjusted-close' });
}
const largeDates = Array.from({ length: 231 }, (_, index) => dateAt(730 + index * 14));
function referenceClose(date, prices) {
  const key = Object.keys(prices).filter(key => key < date && Number.isFinite(prices[key]) && prices[key] > 0)
    .sort().at(-1);
  return key ? { date: key, price: prices[key] } : null;
}
function referenceMaterialize() {
  const result = { dates: benchmarkDates(largeDates), indexCache: {}, customBenchmarkCache: {} };
  for (const date of result.dates) {
    const spx = referenceClose(date, largeHistory.tickers['VOO'].prices);
    const ndx = referenceClose(date, largeHistory.tickers['QQQM'].prices);
    if (spx && ndx) result.indexCache[date] = {
      spx: Number(spx.price.toFixed(6)), ndx: Number(ndx.price.toFixed(6)),
      spxPriceDate: spx.date, ndxPriceDate: ndx.date, policy: 'previous', source: 'VOO/QQQM:adjusted-close'
    };
    largeBenchmarks.forEach((benchmark, slot) => {
      const components = {};
      for (const { ticker } of benchmark.components) {
        const close = referenceClose(date, largeHistory.tickers[ticker].prices);
        if (!close) return;
        components[ticker] = { price: Number(close.price.toFixed(6)), priceDate: close.date };
      }
      const entry = { signature: customBenchmarkSignature(benchmark), components };
      if (slot === 0) result.customBenchmarkCache[date] = entry;
      else result.customBenchmarkCache[date].secondary = entry;
    });
  }
  return result;
}
const referenceStart = performance.now();
const referenceCaches = referenceMaterialize();
const referenceMs = performance.now() - referenceStart;
const lookupStart = performance.now();
const indexedCaches = materializeBenchmarkCaches(largeDates, largeHistory, largeBenchmarks);
const lookupMs = performance.now() - lookupStart;
assert.deepStrictEqual(indexedCaches, referenceCaches);
const largeDb = {
  cnhRate: 7.2, members: [{ id: 'lp', name: 'LP' }],
  customBenchmark: largeBenchmarks[0], customBenchmark2: largeBenchmarks[1],
  events: largeDates.map((date, index) => index === 0
    ? { id: 'deposit', type: 'deposit', member: 'lp', amount: 1000, date, sequenceNumber: 1 }
    : { id: `v-${index}`, type: 'valuation', totalNAV: 1000 + index, date, sequenceNumber: index + 1 })
};
const replayStart = performance.now();
const indexedState = calculateStateFromDb(JSON.parse(JSON.stringify({ ...largeDb, marketHistory: largeHistory })));
const replayMs = performance.now() - replayStart;
const referenceState = calculateStateFromDb(JSON.parse(JSON.stringify({
  ...largeDb, indexCache: referenceCaches.indexCache, customBenchmarkCache: referenceCaches.customBenchmarkCache
})));
assert.deepStrictEqual(indexedState, referenceState, 'multi-year prices must preserve every financial and chart output');
assert(replayMs < 8000, `market-history replay exceeded household budget: ${replayMs}ms`);
// Query reuse must not enumerate or read the entire source on each lookup.
let priceReads = 0;
const observedPrices = Object.fromEntries(Object.keys(largeHistory.tickers.VGT.prices).map(date => [date, 1]));
for (const date of Object.keys(observedPrices)) Object.defineProperty(observedPrices, date, {
  enumerable: true, get() { priceReads++; return 1; }
});
const observedLookup = createCloseLookup(observedPrices);
const initialReads = priceReads;
for (const date of largeDates) observedLookup(date);
assert.strictEqual(priceReads, initialReads);
console.log(`Multi-year market lookup: reference ${referenceMs.toFixed(1)}ms, indexed ${lookupMs.toFixed(1)}ms; full replay ${replayMs.toFixed(1)}ms.`);
