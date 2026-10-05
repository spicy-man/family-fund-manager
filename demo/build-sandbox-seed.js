const { calculateStateFromDb } = require('../lib/calculator');
const { buildDemoLedger } = require('./build-ledger');
const weeklyMarket = require('./weekly-market.json');
const { migrateSettlementLedger } = require('../lib/settlement-ledger');
const { mergeTickerPrices } = require('../lib/market-history');
function buildSandboxSeed() {
  const ledger = buildDemoLedger();
  const db = { members: ledger.members, performanceFee: ledger.performanceFee,
    benchmarkClosePolicy: 'previous', lastEventSequence: Math.max(...ledger.events.map(event => event.sequenceNumber)),
    events: ledger.events.filter(event => event.type !== 'performance_settlement') };
  const calculated = calculateStateFromDb(ledger);
  for (const event of ledger.events.filter(event => event.type === 'performance_settlement')) {
    const computed = calculated.events.find(item => item.id === event.id);
    event.snapshot = { breakdown: computed._breakdown, totalFee: computed._totalFee,
      feeShares: computed._feeShares, navPerShare: computed._navAtTx };
  }
  const settlements = migrateSettlementLedger(db, { version: 1,
    records: ledger.events.filter(event => event.type === 'performance_settlement') }).ledger;
  const marketHistory = { version: 2, tickers: {}, updatedAt: weeklyMarket.endDate };
  for (const [ticker, prices] of Object.entries(weeklyMarket.historyPrices || {})) {
    mergeTickerPrices(marketHistory, ticker, prices, { priceBasis: weeklyMarket.priceBasis || 'close' });
  }
  for (const [ticker, field] of [['AAPL', 'aapl'], ['GOOGL', 'googl'], ['VGT', 'vgt'], ['VOO', 'spx'], ['QQQM', 'ndx']]) {
    if (weeklyMarket.historyPrices?.[ticker]) continue;
    const prices = Object.fromEntries([...weeklyMarket.weeks, ...weeklyMarket.anchors]
      .map(row => [row.priceDate, row[field]]));
    mergeTickerPrices(marketHistory, ticker, prices, { priceBasis: weeklyMarket.priceBasis || 'close' });
  }
  return { db, settlements, marketHistory,
    config: { tickers: Object.values(weeklyMarket.tickers).map(({ ticker, longName }) => ({ ticker, name: longName })),
      customBenchmark: ledger.customBenchmark, customBenchmark2: ledger.customBenchmark2 },
    cnhRate: ledger.cnhRate, indexCache: ledger.indexCache, customBenchmarkCache: ledger.customBenchmarkCache,
    tickerCache: { tickers: weeklyMarket.tickers, updatedAt: weeklyMarket.endDate } };
}
module.exports = { buildSandboxSeed };
