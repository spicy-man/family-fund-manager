const assert = require('assert');
const { randomUUID } = require('crypto');
const { registerApiRoutes } = require('../routes/api');

const routes = {};
const app = {};
for (const method of ['get', 'post', 'put', 'delete']) {
  app[method] = (path, ...handlers) => { routes[`${method}:${path}`] = handlers.at(-1); };
}

const oldUpdatedAt = '2026-01-01T00:00:00.000Z';
let persisted = {
  version: 1,
  updatedAt: oldUpdatedAt,
  tickers: {
    VOO: {
      ticker: 'VOO', priceBasis: 'adjusted-close', ath: 100, athDate: '2025-12-01', regularClose: 95,
      regularCloseDate: '2026-01-02', historyThrough: '2026-01-02', updatedAt: oldUpdatedAt
    }
  }
};
let fetchCalls = 0;
let writes = 0;
let failWrite = false;
let finishFetch;
let currentNow = new Date('2026-08-05T16:00:00.000Z'); // Wednesday noon ET

registerApiRoutes(app, {
  readDb: () => ({ members: [], events: [], indexCache: {} }),
  writeDb: () => {},
  getState: () => ({}),
  readConfig: () => ({ tickers: [{ ticker: 'VOO' }] }),
  writeConfig: () => {},
  readTickerCache: () => JSON.parse(JSON.stringify(persisted)),
  writeTickerCache: value => { if (failWrite) throw new Error("simulated ticker disk failure"); writes++; persisted = JSON.parse(JSON.stringify(value)); },
  writeSnapshot: () => {},
  ensureIndexCache: () => {},
  calculateStateFromDb: () => ({ events: [] }),
  fetchCnhRateFromApi: async () => null,
  isValidDate: () => true,
  normalizeRemark: value => value || '',
  normalizeMemberName: value => value,
  fetchTickerAthData: async () => {
    fetchCalls++;
    return new Promise(resolve => { finishFetch = resolve; });
  },
  randomUUID,
  now: () => currentNow
});

async function requestTicker() {
  const result = { headers: {}, body: null };
  const res = {
    set(name, value) { result.headers[name] = value; return this; },
    status() { return this; },
    json(value) { result.body = value; return this; }
  };
  await routes['get:/api/ticker-ath']({}, res);
  return result;
}

async function requestManualTickerRefresh() {
  const result = { headers: {}, body: null };
  const res = {
    set(name, value) { result.headers[name] = value; return this; },
    status() { return this; },
    json(value) { result.body = value; return this; }
  };
  await routes['post:/api/ticker-ath/refresh']({}, res);
  return result;
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const first = await requestTicker();
  assert.strictEqual(first.body.data.VOO.ath, 100);
  assert.strictEqual(first.body.cached, true);
  assert.strictEqual(first.body.stale, true);
  assert.strictEqual(fetchCalls, 0, 'the response must be sent before refresh starts');

  await nextTurn();
  assert.strictEqual(fetchCalls, 1);

  const second = await requestTicker();
  assert.strictEqual(second.body.data.VOO.ath, 100);
  assert.strictEqual(second.body.refreshing, true, 'clients must keep polling while the shared worker is active');
  await nextTurn();
  assert.strictEqual(fetchCalls, 1, 'concurrent stale requests must share one refresh');

  finishFetch({
    VOO: {
      ...persisted.tickers.VOO,
      ath: 110,
      regularClose: 105,
      regularCloseDate: '2026-08-04',
      updatedAt: currentNow.toISOString()
    }
  });
  await nextTurn();
  await nextTurn();
  assert.strictEqual(writes, 1);
  assert.strictEqual(persisted.tickers.VOO.ath, 110);

  // During the trading day, yesterday's completed close remains current. The
  // browser may poll every five minutes, but that must not hit Yahoo again.
  const duringSession = await requestTicker();
  assert.strictEqual(duringSession.body.stale, false);
  await nextTurn();
  assert.strictEqual(fetchCalls, 1);

  // Shortly after the 20:00 ET publication boundary, today's close becomes the
  // target and a missing candle triggers a refresh.
  currentNow = new Date('2026-08-06T00:05:00.000Z');
  const afterClose = await requestTicker();
  assert.strictEqual(afterClose.body.stale, true);
  await nextTurn();
  assert.strictEqual(fetchCalls, 2);

  finishFetch({});
  await nextTurn();
  await nextTurn();

  // A failed/empty refresh is rate-limited in the close publication window.
  const immediateRetry = await requestTicker();
  assert.strictEqual(immediateRetry.body.stale, false);
  await nextTurn();
  assert.strictEqual(fetchCalls, 2);

  // The explicit panel action bypasses automatic freshness checks.
  const manualRefresh = requestManualTickerRefresh();
  await nextTurn();
  assert.strictEqual(fetchCalls, 3);
  finishFetch({
    VOO: {
      ...persisted.tickers.VOO,
      regularCloseDate: '2026-08-05',
      updatedAt: currentNow.toISOString()
    }
  });
  const manualResult = await manualRefresh;
  assert.strictEqual(manualResult.body.refreshSuccess, true);
  assert.deepStrictEqual(manualResult.body.failedTickers, []);

  const writesBeforeUnchangedRefresh = writes;
  const snapshotBeforeUnchangedRefresh = JSON.parse(JSON.stringify(persisted));
  const unchangedRefresh = requestManualTickerRefresh();
  await nextTurn();
  finishFetch({ VOO: { ...persisted.tickers.VOO, updatedAt: '2026-08-06T00:06:00.000Z' } });
  const unchangedResult = await unchangedRefresh;
  assert.strictEqual(unchangedResult.body.refreshSuccess, true);
  assert.strictEqual(writes, writesBeforeUnchangedRefresh, 'unchanged quotes must not rewrite the cache');
  assert.deepStrictEqual(persisted, snapshotBeforeUnchangedRefresh, 'unchanged checks preserve cache timestamps');

  // A fresh legacy price-only cache must still bootstrap adjusted data.
  persisted.tickers.VOO.priceBasis = 'close';
  const migrated = requestTicker();
  await nextTurn();
  assert.strictEqual(fetchCalls, 5, 'legacy source must refresh even when its close date is current');
  finishFetch({ VOO: { ...persisted.tickers.VOO, priceBasis: 'adjusted-close', ath: 99 } });
  const migratedResult = await migrated;
  assert.strictEqual(migratedResult.body.data.VOO.priceBasis, 'adjusted-close');
  assert.strictEqual(migratedResult.body.data.VOO.ath, 99);

  const beforeDiskFailure = JSON.parse(JSON.stringify(persisted));
  failWrite = true;
  const failedRefresh = requestManualTickerRefresh();
  await nextTurn();
  finishFetch({ VOO: { ...persisted.tickers.VOO, regularClose: 123 } });
  const failedResult = await failedRefresh;
  assert.strictEqual(failedResult.body.refreshSuccess, false, 'failed disk writes cannot report a successful refresh');
  assert.deepStrictEqual(failedResult.body.failedTickers, ['VOO']);
  assert.deepStrictEqual(persisted, beforeDiskFailure, 'failed writes preserve the persisted snapshot');
  failWrite = false;
  const retryRefresh = requestManualTickerRefresh();
  await nextTurn();
  finishFetch({ VOO: { ...persisted.tickers.VOO, regularClose: 123 } });
  const retryResult = await retryRefresh;
  assert.strictEqual(retryResult.body.refreshSuccess, true);
  assert.strictEqual(persisted.tickers.VOO.regularClose, 123);
  console.log('Ticker persistent stale-while-revalidate and adjusted-cache migration assertions passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
