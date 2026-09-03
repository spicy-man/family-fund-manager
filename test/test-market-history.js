const assert = require('assert');
const {
  emptyMarketHistory,
  mergeTickerPrices,
  previousWeekday,
  historyRequestStart,
  mergeCustomBenchmarkCaches,
  materializeBenchmarkCaches
} = require('../lib/market-history');
const {
  normalizeCustomBenchmark,
  customBenchmarkSignature
} = require('../lib/custom-benchmark');
const { calculateStateFromDb } = require('../lib/calculator');

const benchmark = normalizeCustomBenchmark({
  name: 'Portfolio',
  components: [{ ticker: 'VGT', weight: 100 }]
});
const benchmark2 = normalizeCustomBenchmark({
  name: 'BRK-B',
  components: [{ ticker: 'BRK-B', weight: 100 }]
});
const history = emptyMarketHistory();
const daily = {
  '^GSPC': { '2026-08-27': 7730.99, '2026-08-28': 7711.76 },
  '^NDX': { '2026-08-27': 29641.56, '2026-08-28': 29433.43 },
  VGT: { '2026-08-27': 121.91, '2026-08-28': 120.07 },
  'BRK-B': { '2026-08-27': 503.7, '2026-08-28': 505 }
};
for (const [ticker, prices] of Object.entries(daily)) {
  mergeTickerPrices(history, ticker, prices, {
    from: '2026-08-01',
    through: '2026-08-31'
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
}, '2025-12-18'), '2026-08-14', 'covered history should continue incrementally');

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
mergeTickerPrices(failedBackfillHistory, '^GSPC', {}, {
  from: '2020-01-01',
  through: '2026-08-31'
});
assert.strictEqual(
  failedBackfillHistory.tickers['^GSPC'].fetchedFrom,
  null,
  'an empty provider response must not prevent a later backfill retry'
);

// A later incomplete provider response must never erase a recorded trading day.
mergeTickerPrices(history, '^GSPC', { '2026-08-27': 7730.99 }, {
  from: '2026-08-20',
  through: '2026-08-31'
});
assert.strictEqual(history.tickers['^GSPC'].prices['2026-08-28'], 7711.76);

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
    '2026-08-28': { spx: 7730.99, ndx: 29641.56, spxPriceDate: '2026-08-27', ndxPriceDate: '2026-08-27', policy: 'previous' },
    '2026-08-31': { spx: 7730.99, ndx: 29641.56, spxPriceDate: '2026-08-27', ndxPriceDate: '2026-08-27', policy: 'previous' }
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
