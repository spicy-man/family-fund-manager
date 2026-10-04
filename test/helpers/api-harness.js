const assert = require('assert');
const { randomUUID } = require('crypto');
const { calculateStateFromDb } = require('../../lib/calculator');
const { registerApiRoutes } = require('../../routes/api');
const AdmZip = require('adm-zip');
const { mergeSettlementLedger } = require('../../lib/settlement-ledger');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeApi(now = () => new Date(), initialDb = null, overrides = {}, initialLedger = null) {
  const routes = {};
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, ...handlers) => { routes[`${method}:${path}`] = handlers.at(-1); };
  }

  let writes = 0;
  let calculations = 0;
  let settlementLedger = clone(initialLedger || { version: 1, records: [] });
  const db = initialDb ? clone(initialDb) : {
    cnhRate: 7.2,
    members: [
      { id: 'a', name: 'Alice', roles: { lp: true, gp: false } },
      { id: 'b', name: 'Bob', roles: { lp: true, gp: true } }
    ],
    performanceFee: { gpMemberId: 'b', annualRate: 0.06, feeRate: 0.25 },
    events: [{ id: 'deposit', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2026-01-10', createdAt: 1 }],
    indexCache: {}
  };
  const trackedCalculateState = (...args) => {
    calculations++;
    return calculateStateFromDb(...args);
  };
  registerApiRoutes(app, {
    readDb: () => clone(db),
    writeDb: value => { writes++; Object.assign(db, clone(value)); },
    readSettlements: () => clone(settlementLedger),
    writeSettlements: value => {
      writes++;
      settlementLedger = clone(value);
      const reversed = new Set(settlementLedger.records.filter(item => item.type === 'performance_settlement_reversal').map(item => item.settlementId));
      db.events = db.events.filter(item => item.type !== 'performance_settlement' && item.type !== 'performance_settlement_reversal');
      db.events.push(...settlementLedger.records.filter(item => item.type === 'performance_settlement' && !reversed.has(item.id)));
    },
    getState: () => trackedCalculateState(clone(db)),
    readConfig: () => ({ tickers: [] }),
    writeConfig: () => {},
    writeSnapshot: () => {},
    ensureIndexCache: async () => {},
    calculateStateFromDb: trackedCalculateState,
    fetchCnhRateFromApi: async () => null,
    isValidDate: date => /^\d{4}-\d{2}-\d{2}$/.test(date),
    normalizeRemark: value => value || '',
    normalizeMemberName: value => value,
    fetchTickerAthData: async () => ({}),
    readTickerCache: () => ({ tickers: {} }),
    writeTickerCache: () => {},
    randomUUID,
    now,
    ...overrides
  });
  return {
    routes,
    getWrites: () => writes,
    getCalculations: () => calculations,
    getDb: () => clone(db),
    getLedger: () => clone(settlementLedger)
  };
}

async function request(handler, body, params = {}) {
  const result = { status: 200, body: null };
  const res = {
    status(code) { result.status = code; return this; },
    json(payload) { result.body = payload; return this; }
  };
  await handler({ body, params }, res);
  return result;
}


module.exports = { clone, makeApi, request };
