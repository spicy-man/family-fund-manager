const assert = require('assert');
const {
  normalizeCustomBenchmark,
  customBenchmarkSignature,
  isUsableCustomEntry,
  customEntryForSlot,
  mergeCustomEntryForSlot
} = require('../lib/custom-benchmark');
const { calculateStateFromDb } = require('../lib/calculator');
const { registerCustomBenchmarkRoutes } = require('../routes/custom-benchmark');

const benchmark = normalizeCustomBenchmark({
  name: '科技与大盘',
  components: [
    { ticker: ' aapl ', weight: 60 },
    { ticker: 'VOO', weight: 40 }
  ]
});
const benchmark2 = normalizeCustomBenchmark({
  name: '第二组合',
  components: [{ ticker: 'MSFT', weight: 100 }]
});
assert.deepStrictEqual(benchmark.components, [
  { ticker: 'AAPL', weight: 60 },
  { ticker: 'VOO', weight: 40 }
]);
assert.strictEqual(benchmark.name, '科技与大盘', 'multi-component benchmark must keep custom name');
assert.strictEqual(benchmark2.name, 'MSFT', 'single-component benchmark must automatically use ticker as name');
assert.strictEqual(
  normalizeCustomBenchmark({ name: '黄金', components: [{ ticker: 'GC=F', weight: 100 }] }).name,
  'GC=F',
  'single-component benchmark must use ticker as name even if a name is provided'
);
assert.strictEqual(
  normalizeCustomBenchmark({ components: [{ ticker: 'NVDA', weight: 100 }] }).name,
  'NVDA',
  'single-component benchmark without name must use ticker as name'
);
assert.throws(
  () => normalizeCustomBenchmark({ name: '错误组合', components: [{ ticker: 'AAPL', weight: 90 }] }),
  /合计必须为 100%/
);
assert.throws(
  () => normalizeCustomBenchmark({
    name: '重复组合',
    components: [{ ticker: 'AAPL', weight: 50 }, { ticker: 'aapl', weight: 50 }]
  }),
  /不能重复/
);
assert.throws(
  () => normalizeCustomBenchmark({
    name: '舍入后零权重',
    components: [{ ticker: 'VOO', weight: 100 }, { ticker: 'AAPL', weight: 0.00001 }]
  }),
  /舍入后必须大于 0/,
  'a positive input must not be accepted if four-decimal normalization turns it into zero'
);

const signature = customBenchmarkSignature(benchmark);
const signature2 = customBenchmarkSignature(benchmark2);
const customEntry = (aapl, voo, priceDate) => ({
  signature,
  components: {
    AAPL: { price: aapl, priceDate },
    VOO: { price: voo, priceDate }
  }
});
const customEntry2 = (msft, priceDate) => ({
  signature: signature2,
  components: { MSFT: { price: msft, priceDate } }
});
const mergedSlotEntry = mergeCustomEntryForSlot(customEntry(100, 200, '2026-01-02'), 1, customEntry2(330, '2026-01-02'));
assert.deepStrictEqual(customEntryForSlot(mergedSlotEntry, 0), mergedSlotEntry);
assert.deepStrictEqual(customEntryForSlot(mergedSlotEntry, 1), customEntry2(330, '2026-01-02'));
assert.strictEqual(isUsableCustomEntry(customEntry(100, 200, '2026-01-02'), '2026-01-05', benchmark), true);
assert.strictEqual(isUsableCustomEntry(customEntry(100, 200, '2026-01-05'), '2026-01-05', benchmark), false,
  'same-day closes must not leak into a NAV snapshot');

const indexEntry = (spx, ndx, priceDate) => ({
  spx, ndx, spxPriceDate: priceDate, ndxPriceDate: priceDate, policy: 'previous', source: 'VOO/QQQM:adjusted-close'
});
const state = calculateStateFromDb({
  cnhRate: 7.2,
  customBenchmark: benchmark,
  customBenchmark2: benchmark2,
  members: [{ id: 'a', name: 'Alice' }],
  events: [
    { id: 'd', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2026-01-05', createdAt: 1 },
    { id: 'v', type: 'valuation', totalNAV: 110, date: '2026-01-12', createdAt: 2 }
  ],
  indexCache: {
    '2026-01-01': indexEntry(5900, 21000, '2025-12-31'),
    '2026-01-05': indexEntry(6000, 22000, '2026-01-02'),
    '2026-01-12': indexEntry(6100, 22500, '2026-01-09')
  },
  customBenchmarkCache: {
    '2026-01-01': { ...customEntry(90, 180, '2025-12-31'), secondary: customEntry2(300, '2025-12-31') },
    '2026-01-05': { ...customEntry(100, 200, '2026-01-02'), secondary: customEntry2(330, '2026-01-02') },
    '2026-01-12': { ...customEntry(110, 180, '2026-01-09'), secondary: customEntry2(363, '2026-01-09') }
  }
});

assert.strictEqual(state.charts.navHistory[0].customNAV, 1);
assert.strictEqual(state.charts.navHistory[1].customNAV, 1.02,
  '60% x +10% and 40% x -10% must produce a +2% fixed-weight result');
assert.strictEqual(state.settings.customBenchmarkCacheReady, true);
assert.strictEqual(state.charts.navHistory[0].custom2NAV, 1);
assert.strictEqual(state.charts.navHistory[1].custom2NAV, 1.1);
assert.strictEqual(state.settings.customBenchmark2CacheReady, true);
assert.strictEqual(state.charts.benchmarkAnchors['2026'].customNAV, 0.9);
assert.strictEqual(state.charts.benchmarkAnchors['2026'].custom2NAV, Number((300 / 330).toFixed(6)));

const routes = {};
const app = {
  get(path, handler) { routes[`get:${path}`] = handler; },
  post(path, handler) { routes[`post:${path}`] = handler; }
};
let storedConfig = { tickers: [{ ticker: 'VOO' }], customBenchmark: null, customBenchmark2: null };
let syncedDates = null;
registerCustomBenchmarkRoutes(app, {
  readConfig: () => JSON.parse(JSON.stringify(storedConfig)),
  writeConfig: config => { storedConfig = JSON.parse(JSON.stringify(config)); },
  readDb: () => ({ events: [{ date: '2026-01-05' }, { date: '2026-01-12' }] }),
  ensureIndexCache: async dates => { syncedDates = dates; }
});

function request(handler, body) {
  const result = { status: 200, body: null };
  const res = {
    status(code) { result.status = code; return this; },
    json(payload) { result.body = payload; return this; }
  };
  handler({ body }, res);
  return result;
}

const invalidSave = request(routes['post:/api/settings/custom-benchmark'], {
  customBenchmark: { name: '错误', components: [{ ticker: 'VOO', weight: 80 }] }
});
assert.strictEqual(invalidSave.status, 400);

const validSave = request(routes['post:/api/settings/custom-benchmark'], { customBenchmark: benchmark });
assert.strictEqual(validSave.status, 200);
assert.deepStrictEqual(storedConfig.customBenchmark, benchmark);
assert.deepStrictEqual(syncedDates, ['2026-01-05', '2026-01-12']);

const secondSave = request(routes['post:/api/settings/custom-benchmark'], {
  slot: 1,
  customBenchmark: benchmark2
});
assert.strictEqual(secondSave.status, 200);
assert.deepStrictEqual(storedConfig.customBenchmark, benchmark, 'saving slot 2 must preserve slot 1');
assert.deepStrictEqual(storedConfig.customBenchmark2, benchmark2);

const invalidSlot = request(routes['post:/api/settings/custom-benchmark'], {
  slot: 2,
  customBenchmark: benchmark2
});
assert.strictEqual(invalidSlot.status, 400);

const remove = request(routes['post:/api/settings/custom-benchmark'], { customBenchmark: null });
assert.strictEqual(remove.status, 200);
assert.strictEqual(storedConfig.customBenchmark, null);
assert.deepStrictEqual(storedConfig.customBenchmark2, benchmark2, 'removing slot 1 must preserve slot 2');

console.log('Custom single-symbol, weighted benchmark and settings API assertions passed.');
