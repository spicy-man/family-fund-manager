const {
  customBenchmarkSignature,
  mergeCustomEntryForSlot
} = require('./custom-benchmark');

const MARKET_HISTORY_VERSION = 1;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function emptyMarketHistory() {
  return { version: MARKET_HISTORY_VERSION, updatedAt: null, tickers: {} };
}

function normalizeMarketHistory(value) {
  const normalized = emptyMarketHistory();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  normalized.updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : null;
  for (const [ticker, source] of Object.entries(value.tickers || {})) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const prices = {};
    for (const [date, price] of Object.entries(source.prices || {})) {
      if (DATE_PATTERN.test(date) && Number.isFinite(price) && price > 0) prices[date] = price;
    }
    normalized.tickers[ticker] = {
      fetchedFrom: DATE_PATTERN.test(source.fetchedFrom || '') ? source.fetchedFrom : null,
      fetchedThrough: DATE_PATTERN.test(source.fetchedThrough || '') ? source.fetchedThrough : null,
      prices
    };
  }
  return normalized;
}

function mergeTickerPrices(history, ticker, prices, coverage = {}) {
  const current = history.tickers[ticker] || { fetchedFrom: null, fetchedThrough: null, prices: {} };
  let changed = false;
  for (const [date, price] of Object.entries(prices || {})) {
    if (!DATE_PATTERN.test(date) || !Number.isFinite(price) || price <= 0) continue;
    if (current.prices[date] !== price) {
      current.prices[date] = price;
      changed = true;
    }
  }
  if (DATE_PATTERN.test(coverage.from || '') &&
      (!current.fetchedFrom || coverage.from < current.fetchedFrom)) {
    current.fetchedFrom = coverage.from;
    changed = true;
  }
  if (DATE_PATTERN.test(coverage.through || '') &&
      (!current.fetchedThrough || coverage.through > current.fetchedThrough)) {
    current.fetchedThrough = coverage.through;
    changed = true;
  }
  history.tickers[ticker] = current;
  return changed;
}

function findCloseBefore(date, prices) {
  const priceDate = Object.keys(prices || {})
    .filter(candidate => candidate < date && Number.isFinite(prices[candidate]) && prices[candidate] > 0)
    .sort()
    .at(-1);
  return priceDate ? { date: priceDate, price: prices[priceDate] } : null;
}

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function previousWeekday(date) {
  let candidate = addUtcDays(date, -1);
  while ([0, 6].includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) {
    candidate = addUtcDays(candidate, -1);
  }
  return candidate;
}

function benchmarkDates(dates) {
  const eventDates = [...new Set((dates || []).filter(date =>
    typeof date === 'string' && DATE_PATTERN.test(date)
  ))];
  return [...new Set([
    ...eventDates,
    ...eventDates.map(date => `${date.slice(0, 4)}-01-01`)
  ])].sort();
}

function materializeBenchmarkCaches(dates, history, customBenchmarks = [], policy = 'previous') {
  const normalized = normalizeMarketHistory(history);
  const indexCache = {};
  const customBenchmarkCache = {};
  const datesToBuild = benchmarkDates(dates);
  const spxPrices = normalized.tickers['^GSPC']?.prices || {};
  const ndxPrices = normalized.tickers['^NDX']?.prices || {};

  for (const date of datesToBuild) {
    const spx = findCloseBefore(date, spxPrices);
    const ndx = findCloseBefore(date, ndxPrices);
    if (spx && ndx) {
      indexCache[date] = {
        spx: Number(spx.price.toFixed(2)),
        ndx: Number(ndx.price.toFixed(2)),
        spxPriceDate: spx.date,
        ndxPriceDate: ndx.date,
        policy
      };
    }

    customBenchmarks.forEach((benchmark, slot) => {
      if (!benchmark) return;
      const components = {};
      for (const { ticker } of benchmark.components) {
        const close = findCloseBefore(date, normalized.tickers[ticker]?.prices || {});
        if (!close) return;
        components[ticker] = { price: Number(close.price.toFixed(6)), priceDate: close.date };
      }
      const entry = { signature: customBenchmarkSignature(benchmark), components };
      customBenchmarkCache[date] = mergeCustomEntryForSlot(customBenchmarkCache[date], slot, entry);
    });
  }

  return { dates: datesToBuild, indexCache, customBenchmarkCache };
}

module.exports = {
  MARKET_HISTORY_VERSION,
  emptyMarketHistory,
  normalizeMarketHistory,
  mergeTickerPrices,
  findCloseBefore,
  addUtcDays,
  previousWeekday,
  benchmarkDates,
  materializeBenchmarkCaches
};
