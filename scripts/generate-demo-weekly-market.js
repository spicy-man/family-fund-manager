const fs = require('fs');
const path = require('path');
const { fetchYahooPrices, createPriceLookup, fetchTickerAthData } = require('../lib/yahoo');

const TICKERS = ['AAPL', 'GOOGL', 'VGT', '^GSPC', '^NDX', 'CNY=X'];
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
  const endDate = latestCompletedFriday();
  const startSec = Math.floor(Date.parse('2021-12-15T00:00:00Z') / 1000);
  const endSec = Math.floor(Date.parse(`${endDate}T00:00:00Z`) / 1000) + 24 * 3600;
  const maps = Object.fromEntries(await Promise.all(
    TICKERS.map(async ticker => [ticker, await fetchYahooPrices(ticker, startSec, endSec)])
  ));
  const liveCnhMap = await fetchYahooPrices('USDCNH=X', startSec, endSec);
  const tickers = await fetchTickerAthData({
    tickers: [
      { ticker: 'AAPL', name: 'Apple Inc.' },
      { ticker: 'GOOGL', name: 'Alphabet Inc.' },
      { ticker: 'VGT', name: 'Vanguard Information Technology ETF' }
    ]
  });
  if (Object.values(tickers).some(item => item.error)) throw new Error('Unable to build current ticker snapshots');

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
      spx: Number(closes['^GSPC'].price.toFixed(6)),
      ndx: Number(closes['^NDX'].price.toFixed(6)),
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
    source: 'Yahoo Finance historical daily closes',
    historicalFxSource: 'Yahoo CNY=X previous close (CNH-compatible fallback)',
    generatedAt: new Date().toISOString(),
    startDate: START_DATE,
    endDate,
    latestCnh,
    tickers,
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
