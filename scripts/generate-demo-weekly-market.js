const fs = require('fs');
const path = require('path');
const { fetchYahooPrices, createPriceLookup, mergeTickerAthRecord } = require('../lib/yahoo');
const { createJsonFetcher } = require('../lib/http-json');

const TRACKED_TICKERS = [
  'VOO', 'QQQM', 'VGT', 'SMH', 'AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN', 'NVDA', 'BRK-B',
  'KO', 'PG', 'BAC', 'JPM', 'V', 'MA', 'COST', 'WMT', 'JNJ', 'XOM'
];

const TICKERS = ['AAPL', 'GOOGL', 'VGT', 'VOO', 'QQQM', 'CNY=X'];
const START_DATE = '2022-01-07';

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function fridaysThrough(endDate) {
  const cursor = new Date(`${START_DATE}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const dates = [];
  while (cursor <= end) {
    dates.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return dates;
}

function latestCompletedFriday(now = new Date()) {
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  while (cursor.getUTCDay() !== 5) cursor.setUTCDate(cursor.getUTCDate() - 1);
  return isoDate(cursor);
}

(async () => {
  const endDate = process.argv[2] || latestCompletedFriday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !Number.isFinite(Date.parse(endDate)) ||
      isoDate(new Date(endDate)) !== endDate || new Date(endDate).getUTCDay() !== 5 ||
      endDate < START_DATE || endDate > latestCompletedFriday()) {
    throw new Error('Demo end date must be a completed Friday (YYYY-MM-DD).');
  }
  const startSec = Math.floor(Date.parse('2021-12-15T00:00:00Z') / 1000);
  const endSec = Math.floor(Date.parse(`${endDate}T00:00:00Z`) / 1000) + 24 * 3600;
  const maps = Object.fromEntries(await Promise.all(
    TICKERS.map(async ticker => [ticker, await fetchYahooPrices(ticker, startSec, endSec, { adjusted: ticker !== 'CNY=X' })])
  ));
  const liveCnhMap = await fetchYahooPrices('USDCNH=X', startSec, endSec, { adjusted: false });
  const fetchJson = createJsonFetcher();
  const historyPrices = { 'VOO': maps['VOO'], 'QQQM': maps['QQQM'] };
  // Freeze both ATH and closing prices at the requested cutoff, including when
  // Yahoo's metadata already describes a later session.
  const asOf = new Date(endSec * 1000 + 5 * 3600);
  const tickers = Object.fromEntries(await Promise.all(TRACKED_TICKERS.map(async ticker => {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=0&period2=${endSec}&interval=1d&includeAdjustedClose=true`;
    const json = await fetchJson(url);
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`Missing history for ${ticker}`);
    const quote = result.indicators.quote[0];
    const adjusted = result.indicators.adjclose?.[0]?.adjclose;
    if (!adjusted) throw new Error(`Missing adjusted history for ${ticker}`);
    const indices = result.timestamp.map((timestamp, index) => ({ timestamp, index }))
      .filter(({ timestamp }) => timestamp < endSec);
    const bounded = { ...result, meta: { ...result.meta, regularMarketTime: undefined },
      timestamp: indices.map(item => item.timestamp),
      indicators: { quote: [{ high: indices.map(item => quote.high[item.index]),
        close: indices.map(item => quote.close[item.index]) }],
        adjclose: [{ adjclose: indices.map(item => adjusted[item.index]) }] } };
    const record = mergeTickerAthRecord(ticker, null, bounded, asOf);
    if (record.regularCloseDate !== endDate) throw new Error(`Stale close for ${ticker}: ${record.regularCloseDate}`);
    historyPrices[ticker] = Object.fromEntries(indices
      .filter(({ timestamp, index }) => timestamp >= startSec && Number.isFinite(adjusted[index]))
      .map(({ timestamp, index }) => [isoDate(new Date(timestamp * 1000)), adjusted[index]]));
    return [ticker, record];
  })));

  for (const ticker of TICKERS) {
    if (Object.keys(maps[ticker]).length < 200) {
      throw new Error(`Insufficient Yahoo history for ${ticker}`);
    }
  }

  const priceLookups = Object.fromEntries(TICKERS.map(ticker => [ticker, createPriceLookup(maps[ticker])]));
  const snapshot = date => {
    const closes = Object.fromEntries(TICKERS.map(ticker => [ticker, priceLookups[ticker](date)]));
    if (Object.values(closes).some(value => !value)) throw new Error(`Missing previous close for ${date}`);
    return {
      date,
      priceDate: closes.AAPL.date,
      aapl: Number(closes.AAPL.price.toFixed(6)),
      googl: Number(closes.GOOGL.price.toFixed(6)),
      vgt: Number(closes.VGT.price.toFixed(6)),
      spx: Number(closes['VOO'].price.toFixed(6)),
      ndx: Number(closes['QQQM'].price.toFixed(6)),
      cnh: Number(closes['CNY=X'].price.toFixed(6))
    };
  };

  const years = [...new Set(fridaysThrough(endDate).map(date => date.slice(0, 4)))];
  const latestCnhDate = Object.keys(liveCnhMap).sort().at(-1);
  const latestHistoricalCnyDate = Object.keys(maps['CNY=X']).sort().at(-1);
  const latestCnh = latestCnhDate
    ? { rate: Number(liveCnhMap[latestCnhDate].toFixed(6)), priceDate: latestCnhDate, source: 'Yahoo USDCNH=X' }
    : { rate: Number(maps['CNY=X'][latestHistoricalCnyDate].toFixed(6)), priceDate: latestHistoricalCnyDate, source: 'Yahoo CNY=X fallback' };
  const output = {
    source: 'Yahoo Finance historical adjusted daily closes',
    priceBasis: 'adjusted-close',
    historicalFxSource: 'Yahoo CNY=X previous close (CNH-compatible fallback)',
    generatedAt: new Date().toISOString(),
    startDate: START_DATE,
    endDate,
    latestCnh,
    tickers,
    historyPrices,
    anchors: years.map(year => snapshot(`${year}-01-01`)),
    weeks: fridaysThrough(endDate).map(snapshot)
  };

  const target = path.join(__dirname, '..', 'demo', 'weekly-market.json');
  fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${output.weeks.length} weekly snapshots (${output.startDate} through ${output.endDate}).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
