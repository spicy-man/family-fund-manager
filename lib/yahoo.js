const { createJsonFetcher } = require('./http-json');
const { createDateLookup } = require('./date-lookup');
const fetchExternalJson = createJsonFetcher();

function parseYahooPricesResponse(json) {
  const map = {};
  if (json && json.chart?.result?.[0]) {
    const result = json.chart.result[0];
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    if (timestamps && closes) {
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] !== null && closes[i] !== undefined) {
          const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
          map[dateStr] = closes[i];
        }
      }
    }
  }
  return map;
}

/** Fetch daily closes using the configured proxy or a direct connection. */
async function fetchYahooPrices(ticker, startSec, endSec) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${startSec}&period2=${endSec}&interval=1d`;
  try {
    const json = await fetchExternalJson(url);
    if (!json?.chart?.result?.[0]) throw new Error('No chart data');
    return parseYahooPricesResponse(json);
  } catch (error) {
    console.error(`[Yahoo Sync] Failed to fetch ${ticker}:`, error.message);
    return {};
  }
}

/**
 * Find the latest eligible close for the selected benchmark policy.
 * The default uses the close strictly before the NAV date.
 */
function createPriceLookup(priceMap) {
  const lookup = createDateLookup(priceMap);
  return (dateStr, policy = 'previous') => {
    const match = lookup.findBefore(dateStr, policy === 'same_day');
    return match ? { date: match.date, price: match.value } : null;
  };
}

function findCloseForPolicy(dateStr, priceMap, policy = 'previous') {
  return createPriceLookup(priceMap)(dateStr, policy);
}

function findPreviousClose(dateStr, priceMap) {
  return findCloseForPolicy(dateStr, priceMap, 'previous');
}

/**
 * 从本地 indexCache 中寻找最临近的对标价格 (时序兜底)
 */

const TICKER_OVERLAP_DAYS = 14;

function getTickerHistoryStartSec(cachedTicker) {
  if (!cachedTicker?.historyThrough || !/^\d{4}-\d{2}-\d{2}$/.test(cachedTicker.historyThrough)) return 0;
  const throughMs = Date.parse(`${cachedTicker.historyThrough}T00:00:00Z`);
  if (!Number.isFinite(throughMs)) return 0;
  return Math.max(0, Math.floor(throughMs / 1000) - TICKER_OVERLAP_DAYS * 24 * 3600);
}

function getEasternClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  }).formatToParts(now);
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return {
    year: Number(values.year),
    today: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour)
  };
}

function getEasternDate(timestampSeconds) {
  if (!Number.isFinite(timestampSeconds)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestampSeconds * 1000));
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return `${values.year}-${values.month}-${values.day}`;
}

function mergeTickerAthRecord(ticker, cachedTicker, result, now = new Date()) {
  const highs = result.indicators?.quote?.[0]?.high || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];
  const eastern = getEasternClock(now);
  const excludeToday = eastern.hour < 20;
  const bars = timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().split('T')[0],
    high: highs[index],
    close: closes[index]
  })).filter(bar => !(excludeToday && bar.date === eastern.today));

  let latestBar = [...bars].reverse().find(bar => Number.isFinite(bar.close));
  // Yahoo occasionally publishes the completed daily candle with high/low but
  // leaves quote.close null for a while. meta already carries the official
  // regular-session close and timestamp, so use it when it is newer.
  const metaCloseDate = getEasternDate(result.meta?.regularMarketTime);
  if (Number.isFinite(result.meta?.regularMarketPrice) && metaCloseDate &&
      !(excludeToday && metaCloseDate === eastern.today) &&
      (!latestBar || metaCloseDate > latestBar.date)) {
    latestBar = { date: metaCloseDate, close: result.meta.regularMarketPrice };
  }
  if (!latestBar && !Number.isFinite(cachedTicker?.regularClose)) {
    throw new Error(`No completed close data for ${ticker}`);
  }

  let ath = Number.isFinite(cachedTicker?.ath) ? cachedTicker.ath : 0;
  let athDate = cachedTicker?.athDate || '';
  for (const bar of bars) {
    if (Number.isFinite(bar.high) && bar.high > ath) {
      ath = bar.high;
      athDate = bar.date;
    }
  }

  const regularClose = latestBar?.close ?? cachedTicker.regularClose;
  const regularCloseDate = latestBar?.date ?? cachedTicker.regularCloseDate;
  const previousYear = eastern.year - 1;
  const yearStart = `${eastern.year}-01-01`;
  const previousYearBar = [...bars].reverse().find(bar =>
    Number.isFinite(bar.close) && bar.date < yearStart
  );
  let previousYearClose = previousYearBar?.close ?? null;
  if (previousYearClose === null && cachedTicker?.previousYear === previousYear) {
    previousYearClose = cachedTicker.previousYearClose;
  }
  if (previousYearClose === null && cachedTicker?.regularCloseDate?.startsWith(`${previousYear}-`)) {
    previousYearClose = cachedTicker.regularClose;
  }

  const ytdChange = previousYearClose > 0
    ? ((regularClose - previousYearClose) / previousYearClose) * 100
    : null;
  const drawdown = ath > 0 ? ((regularClose - ath) / ath) * 100 : 0;
  const longName = result.meta?.longName || cachedTicker?.longName || cachedTicker?.name || ticker;

  return {
    ticker,
    ath: parseFloat(ath.toFixed(2)),
    athDate,
    regularClose: parseFloat(regularClose.toFixed(2)),
    regularCloseDate,
    drawdown: parseFloat(drawdown.toFixed(2)),
    ytdChange: ytdChange === null ? null : parseFloat(ytdChange.toFixed(2)),
    previousYear,
    previousYearClose,
    historyThrough: regularCloseDate,
    updatedAt: now.toISOString(),
    longName,
    name: longName
  };
}

async function fetchTickerChart(ticker, startSec, endSec) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${startSec}&period2=${endSec}&interval=1d`;
  const json = await fetchExternalJson(url);
  return json?.chart?.result?.[0] || null;
}

async function fetchTickerAthData(config, cachedTickers = {}) {
  const tickers = config.tickers.map(item => item.ticker);
  const now = new Date();
  const endSec = Math.floor(now.getTime() / 1000);

  const tickerResults = await Promise.all(tickers.map(async ticker => {
    try {
      const cachedTicker = cachedTickers[ticker] || null;
      const startSec = getTickerHistoryStartSec(cachedTicker);
      const result = await fetchTickerChart(ticker, startSec, endSec);
      if (!result) throw new Error(`No chart data for ${ticker}`);
      return mergeTickerAthRecord(ticker, cachedTicker, result, now);
    } catch (error) {
      console.error(`[Ticker ATH] Failed to fetch data for ${ticker}:`, error.message);
      return { ticker, error: true };
    }
  }));

  const results = {};
  tickerResults.forEach(result => { results[result.ticker] = result; });
  return results;
}

// 1.5. 获取外部标的 ATH 数据

async function fetchJsonWithFallback(url) {
  try { return await fetchExternalJson(url); }
  catch (_) { return null; }
}

async function fetchCnhRateFromApi() {
  const providers = [
    {
      name: 'Open ER API',
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: (json) => json?.result === 'success' && (json.rates?.CNH || json.rates?.CNY)
    },
    {
      name: 'Currency API (Jsdelivr)',
      url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      parse: (json) => json?.usd?.cnh || json?.usd?.cny
    },
    {
      name: 'Frankfurter API',
      url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY',
      parse: (json) => json?.rates?.CNY || json?.rates?.CNH
    },
    {
      name: 'Yahoo Finance USDCNH=X',
      url: 'https://query2.finance.yahoo.com/v8/finance/chart/USDCNH=X?interval=1d&range=1d',
      parse: (json) => {
        const res = json?.chart?.result?.[0];
        if (!res) return null;
        return res.meta?.regularMarketPrice || res.indicators?.quote?.[0]?.close?.filter(Boolean)?.at(-1);
      }
    }
  ];

  for (const provider of providers) {
    try {
      const json = await fetchJsonWithFallback(provider.url);
      if (json) {
        const rawRate = provider.parse(json);
        const rate = Number(rawRate);
        if (Number.isFinite(rate) && rate > 0) {
          return parseFloat(rate.toFixed(4));
        }
      }
    } catch (_) {}
  }

  console.warn('[CNH Rate Sync] Unable to fetch exchange rate from any external API provider.');
  return null;
}

// 启动服务器并自动初始化同步一次当日汇率

module.exports = {
  fetchYahooPrices,
  findCloseForPolicy,
  createPriceLookup,
  findPreviousClose,
  getTickerHistoryStartSec,
  mergeTickerAthRecord,
  fetchTickerAthData,
  fetchCnhRateFromApi
};
