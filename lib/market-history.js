const {
  customBenchmarkSignature,
  customEntryForSlot,
  mergeCustomEntryForSlot
} = require('./custom-benchmark');

const MARKET_HISTORY_VERSION = 2;
const { createDateLookup } = require('./date-lookup');
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
      priceBasis: source.priceBasis === 'adjusted-close' ? 'adjusted-close' : 'close',
      prices
    };
  }
  return normalized;
}

// Commit one complete adjustment vintage. A partial refresh cannot be spliced
// into older adjusted history: every earlier price may have changed after a dividend.
function replaceAdjustedTickerPrices(history, ticker, prices, coverage = {}) {
  const accepted = Object.fromEntries(Object.entries(prices || {}).filter(([date, price]) =>
    DATE_PATTERN.test(date) && Number.isFinite(price) && price > 0));
  if (!Object.keys(accepted).length) return false;
  const current = history.tickers[ticker];
  if (current?.priceBasis === 'adjusted-close' &&
      Object.keys(current.prices).some(date => !accepted[date])) return false;
  const next = { fetchedFrom: coverage.from || null, fetchedThrough: coverage.through || null,
    priceBasis: 'adjusted-close', prices: accepted };
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  history.tickers[ticker] = next;
  return true;
}

function mergeTickerPrices(history, ticker, prices, coverage = {}) {
  const current = history.tickers[ticker] || { fetchedFrom: null, fetchedThrough: null, prices: {} };
  if (coverage.priceBasis) current.priceBasis = coverage.priceBasis;
  let changed = false;
  let acceptedPriceCount = 0;
  for (const [date, price] of Object.entries(prices || {})) {
    if (!DATE_PATTERN.test(date) || !Number.isFinite(price) || price <= 0) continue;
    acceptedPriceCount += 1;
    if (current.prices[date] !== price) {
      current.prices[date] = price;
      changed = true;
    }
  }
  // An empty response usually means a transient provider/network failure.
  // Do not claim the range was fetched, or an older backfill would never retry.
  if (acceptedPriceCount > 0 && DATE_PATTERN.test(coverage.from || '') &&
      (!current.fetchedFrom || coverage.from < current.fetchedFrom)) {
    current.fetchedFrom = coverage.from;
    changed = true;
  }
  if (acceptedPriceCount > 0 && DATE_PATTERN.test(coverage.through || '') &&
      (!current.fetchedThrough || coverage.through > current.fetchedThrough)) {
    current.fetchedThrough = coverage.through;
    changed = true;
  }
  history.tickers[ticker] = current;
  return changed;
}

function findCloseBefore(date, prices) {
  return createCloseLookup(prices)(date);
}

function createCloseLookup(prices) {
  const lookup = createDateLookup(prices, price => Number.isFinite(price) && price > 0);
  return date => {
    const match = lookup.findBefore(date);
    return match ? { date: match.date, price: match.value } : null;
  };
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

function historyRequestStart(record, oldestRequired) {
  // Always refresh the whole stored range so corporate actions rebase all dates.
  return [oldestRequired, record?.fetchedFrom, ...Object.keys(record?.prices || {})]
    .filter(date => DATE_PATTERN.test(date || '')).sort()[0];
}

function mergeCustomBenchmarkCaches(baseCache = {}, overlayCache = {}) {
  const merged = { ...baseCache };
  for (const [date, overlayEntry] of Object.entries(overlayCache || {})) {
    let nextEntry = merged[date];
    for (let slot = 0; slot < 2; slot++) {
      const slotEntry = customEntryForSlot(overlayEntry, slot);
      if (slotEntry) nextEntry = mergeCustomEntryForSlot(nextEntry, slot, slotEntry);
    }
    if (nextEntry) merged[date] = nextEntry;
  }
  return merged;
}

function materializeBenchmarkCaches(dates, history, customBenchmarks = [], policy = 'previous') {
  const normalized = normalizeMarketHistory(history);
  const indexCache = {};
  const customBenchmarkCache = {};
  const datesToBuild = benchmarkDates(dates);
  const lookups = new Map();
  const closeFor = (ticker, date) => {
    if (!lookups.has(ticker)) {
      lookups.set(ticker, createCloseLookup(normalized.tickers[ticker]?.priceBasis === 'adjusted-close'
        ? normalized.tickers[ticker].prices : {}));
    }
    return lookups.get(ticker)(date);
  };

  for (const date of datesToBuild) {
    const spx = closeFor('VOO', date);
    const ndx = closeFor('QQQM', date);
    if (spx && ndx) {
      indexCache[date] = {
        spx: Number(spx.price.toFixed(6)),
        ndx: Number(ndx.price.toFixed(6)),
        spxPriceDate: spx.date,
        ndxPriceDate: ndx.date,
        policy,
        source: 'VOO/QQQM:adjusted-close'
      };
    }

    customBenchmarks.forEach((benchmark, slot) => {
      if (!benchmark) return;
      const components = {};
      for (const { ticker } of benchmark.components) {
        const close = closeFor(ticker, date);
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
  replaceAdjustedTickerPrices,
  findCloseBefore,
  createCloseLookup,
  addUtcDays,
  previousWeekday,
  benchmarkDates,
  historyRequestStart,
  mergeCustomBenchmarkCaches,
  materializeBenchmarkCaches
};
