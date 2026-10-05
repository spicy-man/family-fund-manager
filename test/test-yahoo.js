const assert = require('assert');
const {
  findCloseForPolicy,
  findPreviousClose,
  getTickerHistoryStartSec,
  mergeTickerAthRecord,
  fetchCnhRateFromApi
} = require('../lib/yahoo');

const prices = {
  '2026-07-02': 100,
  '2026-07-03': 101,
  '2026-07-06': 102
};

// A trading-day NAV must not use that day's close.
assert.deepStrictEqual(findPreviousClose('2026-07-06', prices), {
  date: '2026-07-03',
  price: 101
});

// Weekends and holidays still resolve to the latest earlier trading close.
assert.deepStrictEqual(findPreviousClose('2026-07-05', prices), {
  date: '2026-07-03',
  price: 101
});

assert.strictEqual(findPreviousClose('2026-07-02', prices), null);

assert.deepStrictEqual(findCloseForPolicy('2026-07-06', prices, 'same_day'), {
  date: '2026-07-06',
  price: 102
});
assert.deepStrictEqual(findCloseForPolicy('2026-07-05', prices, 'same_day'), {
  date: '2026-07-03',
  price: 101
});

assert.strictEqual(getTickerHistoryStartSec(null), 0);
assert.strictEqual(getTickerHistoryStartSec({ historyThrough: '2026-07-31' }), 0,
  'all-time adjusted highs must refresh full history after corporate actions');

const merged = mergeTickerAthRecord('VOO', {
  ath: 500,
  athDate: '2026-06-01',
  regularClose: 114,
  regularCloseDate: '2026-07-30',
  previousYear: 2025,
  previousYearClose: 100,
  longName: 'Cached name'
}, {
  timestamp: [
    Date.parse('2025-12-31T12:00:00Z') / 1000,
    Date.parse('2026-07-31T12:00:00Z') / 1000,
    Date.parse('2026-08-03T12:00:00Z') / 1000,
    Date.parse('2026-08-04T12:00:00Z') / 1000
  ],
  indicators: { quote: [{ high: [101, 116, 120, 999], close: [100, 115, 119, 999] }],
    adjclose: [{ adjclose: [90, 103.5, 107.1, 999] }] },
  meta: {
    longName: 'Vanguard S&P 500 ETF',
    regularMarketPrice: 119,
    regularMarketTime: Date.parse('2026-08-03T20:00:01Z') / 1000
  }
}, new Date('2026-08-04T12:00:00Z'));
assert.strictEqual(merged.ath, 108);
assert.strictEqual(merged.athDate, '2026-08-03');
assert.strictEqual(merged.regularClose, 107.1);
assert.strictEqual(merged.historyThrough, '2026-08-03');
assert.strictEqual(merged.ytdChange, 19);

assert.strictEqual(merged.priceBasis, 'adjusted-close');
assert.strictEqual(merged.previousYearClose, 90);
assert.strictEqual(merged.previousYearCloseDate, '2025-12-31');
assert.throws(() => mergeTickerAthRecord('AAPL', null, {
  timestamp: [Date.parse('2026-08-03') / 1000],
  indicators: { quote: [{ close: [100], high: [101] }] }
}), /No adjusted close/);
assert.throws(() => mergeTickerAthRecord('AAPL', null, {
  timestamp: [Date.parse('2026-08-03') / 1000],
  indicators: { quote: [{ close: [100], high: [101] }], adjclose: [{ adjclose: [null] }] }
}), /Incomplete adjusted history/);
assert.throws(() => mergeTickerAthRecord('AAPL', { ...merged, historyBarCount: 5 }, {
  timestamp: [Date.parse('2026-08-03') / 1000],
  indicators: { quote: [{ close: [100], high: [101] }], adjclose: [{ adjclose: [90] }] }
}, new Date('2026-08-04T12:00:00Z')), /Incomplete full adjusted history/);

// YTD starts at the final prior-year session, including the first session's return.
const yearBoundary = mergeTickerAthRecord('AAPL', null, {
  timestamp: ['2025-12-30', '2025-12-31', '2026-01-02'].map(date => Date.parse(`${date}T15:00:00Z`) / 1000),
  indicators: { quote: [{ close: [98, 100, 105], high: [99, 101, 106] }],
    adjclose: [{ adjclose: [88.2, 90, 94.5] }] }
}, new Date('2026-01-03T12:00:00Z'));
assert.strictEqual(yearBoundary.previousYearCloseDate, '2025-12-31');
assert.strictEqual(yearBoundary.ytdChange, 5);
const withoutAnchor = mergeTickerAthRecord('AAPL', { previousYear: 2025, previousYearClose: 80 }, {
  timestamp: [Date.parse('2026-06-01T15:00:00Z') / 1000],
  indicators: { quote: [{ close: [100], high: [101] }], adjclose: [{ adjclose: [90] }] }
}, new Date('2026-06-02T12:00:00Z'));
assert.strictEqual(withoutAnchor.ytdChange, null, 'never substitute an older cached or mid-year price for the year-end anchor');
assert.strictEqual(withoutAnchor.previousYearCloseDate, null);

(async () => {
  const rate = await fetchCnhRateFromApi();
  assert(rate === null || (typeof rate === 'number' && rate > 0), 'fetchCnhRateFromApi must return a positive number or null');
  console.log('Yahoo previous-close & CNH rate fetch assertions passed.');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
