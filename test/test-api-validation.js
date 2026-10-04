const assert = require('assert');
const { randomUUID } = require('crypto');
const { calculateStateFromDb } = require('../lib/calculator');
const { registerApiRoutes } = require('../routes/api');
const AdmZip = require('adm-zip');
const { mergeSettlementLedger } = require('../lib/settlement-ledger');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeApi(now = () => new Date(), initialDb = null, overrides = {}) {
  const routes = {};
  const app = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (path, ...handlers) => { routes[`${method}:${path}`] = handlers.at(-1); };
  }

  let writes = 0;
  let calculations = 0;
  let settlementLedger = { version: 1, records: [] };
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
    getDb: () => clone(db)
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

(async () => {
  // Invalid dates must be input failures even when the ledger is locked.
  const lockedFixture = makeApi().getDb();
  lockedFixture.events.push({ id: 'locked', type: 'performance_settlement', date: '2026-09-30' });
  const lockedApi = makeApi(undefined, lockedFixture, {
    isValidDate: date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  });
  for (const [route, payload] of [
    ['post:/api/transaction', { member: 'a', type: 'deposit', amount: 100 }],
    ['post:/api/transfer', { fromMember: 'a', toMember: 'b', amount: 10, cnhRate: 7.2 }]
  ]) {
    for (const date of [123, true, {}, [], ['2026-01-04'], '2026-02-30', '2026-01', '', null]) {
      const result = await request(lockedApi.routes[route], { ...payload, date });
      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.body.code, 'INPUT_ERROR');
      assert.match(result.body.message, /日期/);
    }
    const validLocked = await request(lockedApi.routes[route], { ...payload, date: '2026-01-04' });
    assert.strictEqual(validLocked.status, 409);
    assert.strictEqual(validLocked.body.code, 'BUSINESS_CONFLICT');
  }
  assert.strictEqual(lockedApi.getWrites(), 0);
  assert.strictEqual(lockedApi.getCalculations(), 0);
  assert.deepStrictEqual(lockedApi.getDb(), lockedFixture);

  // Calculation business failures must reach the API with an actionable reason.
  const invalidRateDb = makeApi().getDb();
  invalidRateDb.performanceFee.annualRate = 2;
  const zeroNavDb = makeApi().getDb();
  zeroNavDb.events.push({ id: 'zero', type: 'valuation', totalNAV: 0, date: '2026-01-12' });
  for (const [fixture, message] of [[invalidRateDb, /业绩报酬配置/], [zeroNavDb, /净值为 0/]]) {
    const failedApi = makeApi(undefined, fixture);
    const result = await request(failedApi.routes['post:/api/transaction'],
      { member: 'a', type: 'deposit', amount: 10, date: '2026-01-18' });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.code, 'INPUT_ERROR');
    assert.match(result.body.message, message);
    assert.strictEqual(failedApi.getWrites(), 0);
    assert.deepStrictEqual(failedApi.getDb(), fixture);
  }
  const brokenStateDb = makeApi().getDb();
  brokenStateDb.events.push(
    { id: 'zero-state', type: 'valuation', totalNAV: 0, date: '2026-01-12' },
    { id: 'after-zero-state', type: 'deposit', member: 'a', amount: 10, date: '2026-01-18' }
  );
  const brokenStateApi = makeApi(undefined, brokenStateDb);
  const brokenState = await request(brokenStateApi.routes['get:/api/state'], {});
  assert.strictEqual(brokenState.status, 400);
  assert.strictEqual(brokenState.body.code, 'INPUT_ERROR');
  assert.match(brokenState.body.message, /净值为 0/);
  assert.strictEqual(brokenStateApi.getWrites(), 0);

  const api = makeApi();
  const transaction = api.routes['post:/api/transaction'];
  const transfer = api.routes['post:/api/transfer'];
  const valuation = api.routes['post:/api/valuation'];
  const settings = api.routes['post:/api/settings'];
  const previewSettlement = api.routes['post:/api/performance-settlement/preview'];
  const confirmSettlement = api.routes['post:/api/performance-settlement'];
  const reverseSettlement = api.routes['post:/api/performance-settlement/reverse-latest'];
  const updateEvent = api.routes['put:/api/event/:id'];

  const disposalDb = {
    cnhRate: 7.2,
    members: [
      { id: 'a', name: 'Alice', roles: { lp: true, gp: false } },
      { id: 'b', name: 'Bob', roles: { lp: true, gp: true } },
      { id: 'c', name: 'Carol', roles: { lp: true, gp: false } }
    ],
    performanceFee: { gpMemberId: 'b', annualRate: 0.06, feeRate: 0.25 },
    events: [
      { id: 'net-d', type: 'deposit', member: 'a', amount: 1000, date: '2025-01-05', createdAt: 1 },
      { id: 'other-d', type: 'deposit', member: 'c', amount: 1000, date: '2025-01-05', createdAt: 2 },
      { id: 'net-v', type: 'valuation', totalNAV: 4000, date: '2026-01-02', createdAt: 3 }
    ]
  };
  const disposalBody = (type, amount) => type === 'withdraw'
    ? { member: 'a', type, amount, date: '2026-01-04' }
    : { fromMember: 'a', toMember: 'c', amount, cnhRate: 7.2, date: '2026-01-04' };
  const disposalRoute = type => `post:/api/${type === 'withdraw' ? 'transaction' : 'transfer'}`;
  for (const type of ['withdraw', 'transfer']) {
    for (const amount of [1800, 1950]) {
      const netApi = makeApi(undefined, disposalDb);
      const result = await request(netApi.routes[disposalRoute(type)], disposalBody(type, amount));
      assert.strictEqual(result.status, 400, `${type} above LP net value must be rejected`);
      assert.strictEqual(result.body.code, 'INPUT_ERROR');
      assert.strictEqual(netApi.getWrites(), 0);
      assert.deepStrictEqual(netApi.getDb(), disposalDb);
    }
    for (const amount of [1500, 2000]) {
      const netApi = makeApi(undefined, disposalDb);
      const result = await request(netApi.routes[disposalRoute(type)], disposalBody(type, amount));
      assert.strictEqual(result.status, 200, `${type} must preserve valid partial and gross full exits`);
      const state = calculateStateFromDb(netApi.getDb(), { verifyLotSummaries: true });
      assert(state.members.a.shares >= 0);
      assert(Math.abs(state.members.a.shares - state.members.a.lpShares - state.members.a.gpCarryShares) < 1e-4);
      if (amount === 2000) {
        assert.strictEqual(result.body.data.fullExit, true);
        assert(result.body.data.amount < 2000);
        assert.strictEqual(state.members.a.shares, 0);
      } else {
        const beforeEdit = netApi.getDb();
        const writesBeforeEdit = netApi.getWrites();
        const edit = await request(netApi.routes['put:/api/event/:id'], { amount: 1800 }, { id: result.body.data.id });
        assert.strictEqual(edit.status, 400, 'editing into the overdraw interval must fail');
        assert.strictEqual(netApi.getWrites(), writesBeforeEdit);
        assert.deepStrictEqual(netApi.getDb(), beforeEdit);
      }
    }

    // A historical NAV edit or deletion must revalidate downstream net cash,
    // even when the outgoing member later deposits enough to hide a deficit.
    const cascadeDb = clone(disposalDb);
    cascadeDb.events.push(
      { id: 'higher-v', type: 'valuation', totalNAV: 6000, date: '2026-01-02', createdAt: 4 },
      { id: 'cascade-out', type, ...disposalBody(type, 1800), createdAt: 5,
        performanceFee: { gpMember: 'b', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 } },
      { id: 'later-d', type: 'deposit', member: 'a', amount: 1000, date: '2026-01-11', createdAt: 6 }
    );
    for (const method of ['put', 'delete']) {
      const cascadeApi = makeApi(undefined, cascadeDb);
      const result = await request(cascadeApi.routes[`${method}:/api/event/:id`],
        method === 'put' ? { totalNAV: 4000 } : {}, { id: 'higher-v' });
      assert.strictEqual(result.status, 400, 'historical mutations must reject an underfunded net disposal');
      assert.strictEqual(cascadeApi.getWrites(), 0);
      assert.deepStrictEqual(cascadeApi.getDb(), cascadeDb);
    }

    const importedDb = clone(disposalDb);
    importedDb.events.push({ id: 'import-out', type, ...disposalBody(type, 1800), createdAt: 4,
      performanceFee: { gpMember: 'b', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2 } });
    const zip = new AdmZip();
    zip.addFile('data/db.json', Buffer.from(JSON.stringify(importedDb)));
    zip.addFile('data/config.json', Buffer.from(JSON.stringify({ tickers: [{ ticker: 'VOO' }] })));
    let snapshotWrites = 0;
    const importApi = makeApi(undefined, disposalDb, { writeSnapshot: () => { snapshotWrites++; } });
    const imported = await request(importApi.routes['post:/api/backup/import'], zip.toBuffer());
    assert.strictEqual(imported.status, 400, 'backup import must reject an underfunded net disposal');
    assert.strictEqual(snapshotWrites, 0);
    assert.deepStrictEqual(importApi.getDb(), disposalDb);
  }

  const mixedGpDb = clone(disposalDb);
  mixedGpDb.events = [
    { id: 'gp-d', type: 'deposit', member: 'b', amount: 100, date: '2025-01-05', createdAt: 1 },
    { id: 'gp-v1', type: 'valuation', totalNAV: 120, date: '2026-01-02', createdAt: 2 },
    { id: 'gp-s', type: 'performance_settlement', date: '2026-01-02', gpMember: 'b',
      lpMembers: ['a', 'b', 'c'], annualRate: 0.06, feeRate: 0.25, algorithmVersion: 3, createdAt: 3 },
    { id: 'gp-v2', type: 'valuation', totalNAV: 140, date: '2026-01-02', createdAt: 4 }
  ];
  for (const type of ['withdraw', 'transfer']) {
    for (const [amount, status] of [[133, 200], [136, 400]]) {
      const mixedApi = makeApi(undefined, mixedGpDb);
      const body = disposalBody(type, amount);
      if (type === 'withdraw') body.member = 'b';
      else body.fromMember = 'b';
      const result = await request(mixedApi.routes[disposalRoute(type)], body);
      assert.strictEqual(result.status, status, 'only existing GP carry may fund cash above LP net value');
      if (status === 400) assert.strictEqual(mixedApi.getWrites(), 0);
      else assert.strictEqual(calculateStateFromDb(mixedApi.getDb()).members.b.currentValue, 7);
    }
  }

  const settlementDateDb = clone(disposalDb);
  // Check both routes around Beijing midnight, when the UTC date still
  // belongs to the previous day. Settlement days need not be trading days.
  for (const route of ['post:/api/performance-settlement/preview', 'post:/api/performance-settlement']) {
    for (const [instant, date, status] of [
      ['2026-01-03T15:59:59Z', '2026-01-04', 400],
      ['2026-01-03T16:00:00Z', '2026-01-04', 200],
      ['2026-01-03T16:00:00Z', '2026-01-05', 400],
      ['2026-01-03T16:00:00Z', '2030-12-31', 400]
    ]) {
      const dateApi = makeApi(() => new Date(instant), settlementDateDb);
      const result = await request(dateApi.routes[route], { date });
      assert.strictEqual(result.status, status, `${route}: ${date} at ${instant}`);
      if (status === 400) {
        assert.match(result.body.message, /不能晚于今天/);
        assert.strictEqual(dateApi.getWrites(), 0);
        assert.strictEqual(dateApi.getCalculations(), 0, 'future dates must fail before replay');
        assert.deepStrictEqual(dateApi.getDb(), settlementDateDb);
      }
    }
  }

  // Both backup formats must share the live settlement date limit. A future
  // settlement which was already reversed is audit history, not an active lock.
  for (const separateLedger of [false, true]) {
    for (const [instant, date, reversed, status] of [
      ['2026-01-03T15:59:59Z', '2026-01-04', false, 400],
      ['2026-01-03T16:00:00Z', '2026-01-04', false, 200],
      ['2026-01-03T16:00:00Z', '2026-01-03', false, 200],
      ['2026-01-03T16:00:00Z', '2030-12-31', false, 400],
      ['2026-01-03T16:00:00Z', '2030-12-31', true, 200]
    ]) {
      const baseDb = clone(settlementDateDb);
      baseDb.events.forEach((event, index) => { event.sequenceNumber = index + 1; });
      const settlement = {
        id: 'import-settle', type: 'performance_settlement', date,
        gpMember: 'b', lpMembers: ['a', 'b', 'c'], annualRate: 0.06, feeRate: 0.25,
        algorithmVersion: 3, createdAt: 4, sequenceNumber: 4
      };
      const computed = calculateStateFromDb({ ...clone(baseDb), events: [...clone(baseDb.events), clone(settlement)] }).events.at(-1);
      settlement.snapshot = {
        breakdown: computed._breakdown, totalFee: computed._totalFee,
        feeShares: computed._feeShares, navPerShare: computed._navAtTx
      };
      const records = [settlement];
      if (reversed) records.push({
        id: 'import-reversal', type: 'performance_settlement_reversal',
        settlementId: settlement.id, settlementDate: date, date: '2026-01-04',
        createdAt: 5, sequenceNumber: 5
      });
      const zip = new AdmZip();
      zip.addFile('data/db.json', Buffer.from(JSON.stringify({
        ...baseDb, events: separateLedger ? baseDb.events : [...baseDb.events, ...records]
      })));
      zip.addFile('data/config.json', Buffer.from(JSON.stringify({ tickers: [{ ticker: 'VOO' }] })));
      if (separateLedger) zip.addFile('data/settlements.json', Buffer.from(JSON.stringify({ version: 1, records })));
      let saved = null;
      let snapshotWrites = 0;
      let cacheWrites = 0;
      const restoreApi = makeApi(() => new Date(instant), settlementDateDb, {
        writeSnapshot: (db, config, ledger) => { snapshotWrites++; saved = mergeSettlementLedger(db, ledger); },
        writeCnhRate: () => { cacheWrites++; },
        writeIndexCache: () => { cacheWrites++; }
      });
      const restored = await request(restoreApi.routes['post:/api/backup/import'], zip.toBuffer());
      assert.strictEqual(restored.status, status, `backup ${separateLedger ? 'separate' : 'embedded'}: ${date}, reversed=${reversed}, at ${instant}`);
      if (status === 400) {
        assert.match(restored.body.message, /不能晚于今天/);
        assert.strictEqual(snapshotWrites, 0);
        assert.strictEqual(cacheWrites, 0);
        assert.deepStrictEqual(restoreApi.getDb(), settlementDateDb);
      } else {
        assert.strictEqual(snapshotWrites, 1);
        const lockedDates = saved.events.filter(event => event.type === 'performance_settlement').map(event => event.date);
        assert.deepStrictEqual(lockedDates, reversed ? [] : [date]);
        if (reversed) {
          const afterRestore = makeApi(() => new Date(instant), saved);
          const deposit = await request(afterRestore.routes['post:/api/transaction'], {
            member: 'a', type: 'deposit', amount: 100, date: '2026-01-04'
          });
          assert.strictEqual(deposit.status, 200, 'reversed future history must not lock current operations');
        }
      }
    }
  }

  // Exercise the conditional LP guard without startup migration normalizing
  // roles. A rejected reassignment must leave the persisted ledger unchanged.
  const roleDb = {
    cnhRate: 7.2,
    members: [
      { id: 'a', name: 'Alice', roles: { lp: true, gp: false } },
      { id: 'b', name: 'Bob', roles: { lp: true, gp: true } },
      { id: 'gp', name: 'GP only', roles: { lp: false, gp: true } }
    ],
    performanceFee: { gpMemberId: 'b', annualRate: 0.06, feeRate: 0.25 },
    indexCache: {},
    events: [
      { id: 'd', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2026-01-04', createdAt: 1 },
      { id: 'w', type: 'withdraw', member: 'a', amount: 10, cnhAmount: 72, date: '2026-01-11', createdAt: 2 },
      { id: 't', type: 'transfer', fromMember: 'a', toMember: 'b', amount: 10, cnhRate: 7.2, cnhAmount: 72, date: '2026-01-18', createdAt: 3 }
    ]
  };
  for (const [id, body] of [
    ['d', { member: 'gp' }], ['w', { member: 'gp' }],
    ['t', { fromMember: 'gp' }], ['t', { toMember: 'gp' }]
  ]) {
    const roleApi = makeApi(undefined, roleDb);
    const result = await request(roleApi.routes['put:/api/event/:id'], body, { id });
    assert.strictEqual(result.status, 400);
    assert.match(result.body.message, /LP/);
    assert.strictEqual(roleApi.getWrites(), 0);
    assert.deepStrictEqual(roleApi.getDb(), roleDb);
  }
  const validRoleApi = makeApi(undefined, { ...roleDb, events: [roleDb.events[0]] });
  const validRoleEdit = await request(validRoleApi.routes['put:/api/event/:id'], { member: 'b' }, { id: 'd' });
  assert.strictEqual(validRoleEdit.status, 200, 'a GP with LP identity remains eligible');

  const beforeCutoffApi = makeApi(() => new Date('2026-08-06T08:04:00Z'));
  const beforeCutoffValuation = await request(beforeCutoffApi.routes['post:/api/valuation'], {
    totalNAV: 120, date: '2026-08-06'
  });
  assert.strictEqual(beforeCutoffValuation.status, 400);
  assert.match(beforeCutoffValuation.body.message, /美东时间04:05/);

  const afterCutoffApi = makeApi(() => new Date('2026-08-06T08:05:00Z'));
  const afterCutoffValuation = await request(afterCutoffApi.routes['post:/api/valuation'], {
    totalNAV: 120, date: '2026-08-06'
  });
  assert.strictEqual(afterCutoffValuation.status, 200);

  // Winter EST is UTC-5: the same 04:05 NAV cutoff moves from 16:05 to 17:05
  // in Beijing instead of opening an hour early at a fixed Beijing time.
  const beforeWinterCutoffApi = makeApi(() => new Date('2026-01-12T09:04:00Z'));
  const beforeWinterCutoffValuation = await request(beforeWinterCutoffApi.routes['post:/api/valuation'], {
    totalNAV: 120, date: '2026-01-12'
  });
  assert.strictEqual(beforeWinterCutoffValuation.status, 400);

  const afterWinterCutoffApi = makeApi(() => new Date('2026-01-12T09:05:00Z'));
  const afterWinterCutoffValuation = await request(afterWinterCutoffApi.routes['post:/api/valuation'], {
    totalNAV: 120, date: '2026-01-12'
  });
  assert.strictEqual(afterWinterCutoffValuation.status, 200);

  const zeroValuation = await request(valuation, {
    totalNAV: 0, date: '2026-01-11'
  });
  assert.strictEqual(zeroValuation.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const preInceptionValuation = await request(valuation, {
    totalNAV: 110, date: '2026-01-01'
  });
  assert.strictEqual(preInceptionValuation.status, 400);
  assert.match(preInceptionValuation.body.message, /尚无基金份额/);
  assert.strictEqual(api.getWrites(), 0);

  const historicalWithdrawal = await request(transaction, {
    member: 'a', type: 'withdraw', amount: 100, date: '2026-01-01'
  });
  assert.strictEqual(historicalWithdrawal.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const malformedAmount = await request(transaction, {
    member: 'a', type: 'deposit', amount: '100usd', date: '2026-01-11'
  });
  assert.strictEqual(malformedAmount.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const infiniteAmount = await request(transaction, {
    member: 'a', type: 'deposit', amount: 'Infinity', date: '2026-01-11'
  });
  assert.strictEqual(infiniteAmount.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const weekdayDeposit = await request(transaction, {
    member: 'a', type: 'deposit', amount: 10, date: '2026-01-12'
  });
  assert.strictEqual(weekdayDeposit.status, 400);
  assert.match(weekdayDeposit.body.message, /周日/);
  assert.strictEqual(api.getWrites(), 0);

  const saturdayDeposit = await request(transaction, {
    member: 'a', type: 'deposit', amount: 10, date: '2026-01-17'
  });
  assert.strictEqual(saturdayDeposit.status, 400);
  assert.match(saturdayDeposit.body.message, /周日/);
  assert.strictEqual(api.getWrites(), 0);

  const weekdayTransfer = await request(transfer, {
    fromMember: 'a', toMember: 'b', amount: 10, cnhRate: 7.2, date: '2026-01-12'
  });
  assert.strictEqual(weekdayTransfer.status, 400);
  assert.match(weekdayTransfer.body.message, /周日/);
  assert.strictEqual(api.getWrites(), 0);

  const saturdayTransfer = await request(transfer, {
    fromMember: 'a', toMember: 'b', amount: 10, cnhRate: 7.2, date: '2026-01-17'
  });
  assert.strictEqual(saturdayTransfer.status, 400);
  assert.match(saturdayTransfer.body.message, /周日/);
  assert.strictEqual(api.getWrites(), 0);

  const historicalTransfer = await request(transfer, {
    fromMember: 'a', toMember: 'b', amount: 100, cnhRate: 7.2, date: '2026-01-01'
  });
  assert.strictEqual(historicalTransfer.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const invalidPolicy = await request(settings, { benchmarkClosePolicy: 'future_close' });
  assert.strictEqual(invalidPolicy.status, 400);
  assert.strictEqual(api.getWrites(), 0);

  const validPolicy = await request(settings, { benchmarkClosePolicy: 'previous' });
  assert.strictEqual(validPolicy.status, 200);
  assert.strictEqual(api.getWrites(), 1);

  const settlementValuation = await request(valuation, { totalNAV: 120, date: '2026-01-12' });
  assert.strictEqual(settlementValuation.status, 200);
  const preview = await request(previewSettlement, { gpMember: 'b', date: '2026-01-12' });
  assert.strictEqual(preview.status, 200);
  assert(preview.body.data.totalFee > 0);
  const confirmed = await request(confirmSettlement, { gpMember: 'b', date: '2026-01-12' });
  assert.strictEqual(confirmed.status, 200);
  assert.strictEqual(confirmed.body.data.algorithmVersion, 3);
  const historicalSettlement = await request(previewSettlement, { gpMember: 'b', date: '2026-01-10' });
  assert.strictEqual(historicalSettlement.status, 400);
  assert.match(historicalSettlement.body.message, /必须晚于/);
  const lockedMutation = await request(transaction, {
    member: 'a', type: 'deposit', amount: 1, date: '2026-01-11'
  });
  assert.strictEqual(lockedMutation.status, 409);
  const futureMutation = await request(transaction, {
    member: 'a', type: 'deposit', amount: 1, date: '2026-01-18'
  });
  assert.strictEqual(futureMutation.status, 200);
  const lockedDateEdit = await request(updateEvent, {
    date: '2026-01-11'
  }, { id: futureMutation.body.data.id });
  assert.strictEqual(lockedDateEdit.status, 409);
  const reversed = await request(reverseSettlement, { remark: 'test reversal' });
  assert.strictEqual(reversed.status, 200);
  const unlockedMutation = await request(transaction, {
    member: 'a', type: 'deposit', amount: 1, date: '2026-01-11'
  });
  assert.strictEqual(unlockedMutation.status, 200);
  const sameDayPreviewAfterReversal = await request(previewSettlement, {
    gpMember: 'b', date: '2026-01-12'
  });
  assert.strictEqual(sameDayPreviewAfterReversal.status, 200);
  const sameDayConfirmedAfterReversal = await request(confirmSettlement, {
    gpMember: 'b', date: '2026-01-12'
  });
  assert.strictEqual(sameDayConfirmedAfterReversal.status, 200);

  const rawSettlementWriteFailureApi = makeApi(undefined, null, {
    writeSettlements: () => { throw new Error('raw persistence failure'); }
  });
  assert.strictEqual((await request(rawSettlementWriteFailureApi.routes['post:/api/valuation'], {
    totalNAV: 120, date: '2026-01-12'
  })).status, 200);
  const rawSettlementWriteFailure = await request(
    rawSettlementWriteFailureApi.routes['post:/api/performance-settlement'],
    { date: '2026-01-12' }
  );
  assert.strictEqual(rawSettlementWriteFailure.status, 500,
    'an untyped persistence failure must never be downgraded to an input error');
  assert.strictEqual(rawSettlementWriteFailure.body.code, 'INTERNAL_ERROR');

  const sequenceReuseApi = makeApi();
  const firstSequencedValuation = await request(
    sequenceReuseApi.routes['post:/api/valuation'],
    { totalNAV: 120, date: '2026-01-12' }
  );
  assert.strictEqual(firstSequencedValuation.status, 200);
  assert.strictEqual((await request(
    sequenceReuseApi.routes['delete:/api/event/:id'],
    {},
    { id: firstSequencedValuation.body.data.id }
  )).status, 200);
  const valuationAfterDeletion = await request(
    sequenceReuseApi.routes['post:/api/valuation'],
    { totalNAV: 130, date: '2026-01-12' }
  );
  assert(valuationAfterDeletion.body.data.sequenceNumber > firstSequencedValuation.body.data.sequenceNumber,
    'deleting the latest event must not allow its sequence number to be reused');
  assert.strictEqual((await request(
    sequenceReuseApi.routes['delete:/api/event/:id'],
    {},
    { id: valuationAfterDeletion.body.data.id }
  )).status, 200);
  const restartedSequenceApi = makeApi(undefined, sequenceReuseApi.getDb());
  const valuationAfterRestart = await request(
    restartedSequenceApi.routes['post:/api/valuation'],
    { totalNAV: 140, date: '2026-01-13' }
  );
  assert(valuationAfterRestart.body.data.sequenceNumber > valuationAfterDeletion.body.data.sequenceNumber,
    'the persisted sequence high-water mark must survive a process restart');

  // Later cash flows must not prevent a historical year-end settlement. The
  // replay engine naturally excludes members whose first deposit is later.
  const laterCashFlowApi = makeApi();
  const laterValuation = laterCashFlowApi.routes['post:/api/valuation'];
  const laterTransaction = laterCashFlowApi.routes['post:/api/transaction'];
  const historicalPreview = laterCashFlowApi.routes['post:/api/performance-settlement/preview'];
  assert.strictEqual((await request(laterValuation, { totalNAV: 120, date: '2026-01-12' })).status, 200);
  assert.strictEqual((await request(laterTransaction, {
    member: 'a', type: 'deposit', amount: 10, date: '2026-02-01'
  })).status, 200);
  assert.strictEqual((await request(historicalPreview, {
    gpMember: 'b', date: '2026-01-15'
  })).status, 200);

  const versionApi = makeApi();
  const versionedWithdrawal = await request(versionApi.routes['post:/api/transaction'], {
    member: 'a', type: 'withdraw', amount: 10, date: '2026-01-11'
  });
  assert.strictEqual(versionedWithdrawal.status, 200);
  assert.strictEqual(versionedWithdrawal.body.data.performanceFee.disposalVersion, 2);
  const versionedTransfer = await request(versionApi.routes['post:/api/transfer'], {
    fromMember: 'a', toMember: 'b', amount: 10, cnhRate: 7.2, date: '2026-01-11'
  });
  assert.strictEqual(versionedTransfer.status, 200);
  assert.strictEqual(versionedTransfer.body.data.performanceFee.disposalVersion, 2);

  const configuredRatesDb = {
    cnhRate: 7.2,
    members: [
      { id: 'a', name: 'Alice', roles: { lp: true, gp: false } },
      { id: 'b', name: 'Bob', roles: { lp: true, gp: true } }
    ],
    performanceFee: { gpMemberId: 'b', annualRate: 0.08, feeRate: 0.3 },
    events: [
      { id: 'rate-d', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2025-01-05', createdAt: 1 },
      { id: 'rate-v', type: 'valuation', totalNAV: 120, date: '2026-01-09', createdAt: 2 }
    ],
    indexCache: {}
  };
  const configuredRatesApi = makeApi(() => new Date('2026-01-12T12:00:00Z'), configuredRatesDb);
  const configuredWithdrawal = await request(configuredRatesApi.routes['post:/api/transaction'], {
    member: 'a', type: 'withdraw', amount: 10, date: '2026-01-11'
  });
  assert.strictEqual(configuredWithdrawal.status, 200);
  assert.deepStrictEqual(
    { annualRate: configuredWithdrawal.body.data.performanceFee.annualRate, feeRate: configuredWithdrawal.body.data.performanceFee.feeRate },
    { annualRate: 0.08, feeRate: 0.3 }
  );
  const configuredTransfer = await request(configuredRatesApi.routes['post:/api/transfer'], {
    fromMember: 'a', toMember: 'b', amount: 10, cnhRate: 7.2, date: '2026-01-11'
  });
  assert.strictEqual(configuredTransfer.status, 200);
  assert.deepStrictEqual(
    { annualRate: configuredTransfer.body.data.performanceFee.annualRate, feeRate: configuredTransfer.body.data.performanceFee.feeRate },
    { annualRate: 0.08, feeRate: 0.3 }
  );
  const configuredPreview = await request(
    configuredRatesApi.routes['post:/api/performance-settlement/preview'],
    { date: '2026-01-12' }
  );
  assert.strictEqual(configuredPreview.status, 200);
  assert.strictEqual(configuredPreview.body.data.event.annualRate, 0.08);
  assert.strictEqual(configuredPreview.body.data.event.feeRate, 0.3);

  const editApi = makeApi();
  assert.strictEqual((await request(editApi.routes['post:/api/valuation'], {
    totalNAV: 120, date: '2026-01-12'
  })).status, 200);
  let calculationsBefore = editApi.getCalculations();
  const createdFullExit = await request(editApi.routes['post:/api/transaction'], {
    member: 'a', type: 'withdraw', amount: 120, cnhAmount: 864, date: '2026-01-18'
  });
  assert.strictEqual(createdFullExit.status, 200);
  assert.strictEqual(editApi.getCalculations() - calculationsBefore, 1, 'full-exit creation must replay once');
  assert.strictEqual(createdFullExit.body.data.fullExit, true);
  calculationsBefore = editApi.getCalculations();
  const editedToPartial = await request(
    editApi.routes['put:/api/event/:id'],
    { amount: 60, cnhAmount: 432, date: '2026-01-18' },
    { id: createdFullExit.body.data.id }
  );
  assert.strictEqual(editedToPartial.status, 200);
  assert.strictEqual(editApi.getCalculations() - calculationsBefore, 1, 'withdrawal edit must replay once');
  assert.strictEqual(editedToPartial.body.data.fullExit, undefined);
  assert.strictEqual(editedToPartial.body.data.amount, 60);
  let editedState = calculateStateFromDb(editApi.getDb());
  assert.strictEqual(editedState.events.find(item => item.id === createdFullExit.body.data.id)._actualAmount, 60);
  assert(editedState.members.a.currentValue > 0);
  const editedAmountOnly = await request(
    editApi.routes['put:/api/event/:id'],
    { amount: 30, date: '2026-01-18' },
    { id: createdFullExit.body.data.id }
  );
  assert.strictEqual(editedAmountOnly.status, 200);
  assert.strictEqual(editedAmountOnly.body.data.cnhAmount, 216);
  const editedBackToFull = await request(
    editApi.routes['put:/api/event/:id'],
    { amount: 120, cnhAmount: 864, date: '2026-01-18' },
    { id: createdFullExit.body.data.id }
  );
  assert.strictEqual(editedBackToFull.status, 200);
  assert.strictEqual(editedBackToFull.body.data.fullExit, true);
  assert.strictEqual(editedBackToFull.body.data.requestedGrossAmount, 120);
  editedState = calculateStateFromDb(editApi.getDb());
  assert.strictEqual(editedState.members.a.currentValue, 0);

  const historicalDb = {
    cnhRate: 7.2,
    members: [
      { id: 'a', name: 'Alice', roles: { lp: true, gp: false } },
      { id: 'b', name: 'Bob', roles: { lp: true, gp: true } }
    ],
    performanceFee: { gpMemberId: 'b', annualRate: 0.06, feeRate: 0.25 },
    indexCache: {},
    events: [
      { id: 'hd', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2026-01-04', createdAt: 1 },
      { id: 'hv1', type: 'valuation', totalNAV: 120, date: '2026-01-05', createdAt: 2 },
      { id: 'hv2', type: 'valuation', totalNAV: 60, date: '2026-01-12', createdAt: 3 }
    ]
  };
  const historicalWithdrawalApi = makeApi(undefined, historicalDb);
  const historicalPartialWithdrawal = await request(
    historicalWithdrawalApi.routes['post:/api/transaction'],
    { member: 'a', type: 'withdraw', amount: 60, cnhAmount: 432, date: '2026-01-11' }
  );
  assert.strictEqual(historicalPartialWithdrawal.status, 200);
  assert.strictEqual(historicalPartialWithdrawal.body.data.fullExit, undefined);
  assert.strictEqual(historicalPartialWithdrawal.body.data.amount, 60);

  const historicalTransferApi = makeApi(undefined, historicalDb);
  calculationsBefore = historicalTransferApi.getCalculations();
  const historicalPartialTransfer = await request(
    historicalTransferApi.routes['post:/api/transfer'],
    { fromMember: 'a', toMember: 'b', amount: 60, cnhRate: 7.2, date: '2026-01-11' }
  );
  assert.strictEqual(historicalPartialTransfer.status, 200);
  assert.strictEqual(historicalTransferApi.getCalculations() - calculationsBefore, 1, 'transfer creation must replay once');
  assert.strictEqual(historicalPartialTransfer.body.data.fullExit, undefined);
  assert.strictEqual(historicalPartialTransfer.body.data.amount, 60);

  // Full-exit detection must use the same two-decimal account value shown by
  // the API. A user entering the displayed $100.00 should still close an
  // account whose exact Decimal value is $100.004.
  const roundedExitApi = makeApi(undefined, {
    cnhRate: 7.2,
    members: [
      { id: 'a', name: 'Alice', roles: { lp: true, gp: false } },
      { id: 'b', name: 'Bob', roles: { lp: true, gp: true } }
    ],
    performanceFee: { gpMemberId: 'b', annualRate: 0.06, feeRate: 0.25 },
    indexCache: {},
    events: [
      { id: 'rounded-d', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2026-01-04', createdAt: 1 },
      { id: 'rounded-v', type: 'valuation', totalNAV: 100.004, date: '2026-01-05', createdAt: 2 }
    ]
  });
  const roundedFullExit = await request(
    roundedExitApi.routes['post:/api/transaction'],
    { member: 'a', type: 'withdraw', amount: 100, cnhAmount: 720, date: '2026-01-11' }
  );
  assert.strictEqual(roundedFullExit.status, 200);
  assert.strictEqual(roundedFullExit.body.data.fullExit, true);
  assert.strictEqual(roundedFullExit.body.data.requestedGrossAmount, 100);

  const roundedOverdrawApi = makeApi(undefined, {
    cnhRate: 7.2,
    members: [
      { id: 'a', name: 'Alice', roles: { lp: true, gp: false } },
      { id: 'b', name: 'Bob', roles: { lp: true, gp: true } }
    ],
    performanceFee: { gpMemberId: 'b', annualRate: 0.06, feeRate: 0.25 },
    indexCache: {},
    events: [
      { id: 'rounded-over-d', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2026-01-04', createdAt: 1 },
      { id: 'rounded-over-v', type: 'valuation', totalNAV: 100.004, date: '2026-01-05', createdAt: 2 }
    ]
  });
  calculationsBefore = roundedOverdrawApi.getCalculations();
  const roundedOverdraw = await request(
    roundedOverdrawApi.routes['post:/api/transaction'],
    { member: 'a', type: 'withdraw', amount: 100.01, cnhAmount: 720.072, date: '2026-01-11' }
  );
  assert.strictEqual(roundedOverdraw.status, 400);
  assert.strictEqual(roundedOverdrawApi.getCalculations() - calculationsBefore, 1, 'rejected withdrawal must replay once');

  // Review #6: preserving an actual historical CNH payment must work with
  // sparse API edits and the browser's complete unchanged monetary payload.
  for (const fullExit of [false, true]) {
    const seedApi = makeApi(undefined, disposalDb);
    const created = await request(seedApi.routes['post:/api/transfer'], disposalBody('transfer', fullExit ? 2000 : 500));
    assert.strictEqual(created.status, 200);
    const fixture = seedApi.getDb();
    const original = fixture.events.find(event => event.id === created.body.data.id);
    original.cnhAmount = original.amount * 7.35; // Imported/manual actual payment differs from stated rate.
    for (const [legacyRate, legacyGross] of [[false, false], [true, false], ...(fullExit ? [[false, true], [true, true]] : [])]) {
      const legacyFixture = clone(fixture);
      const baseline = legacyFixture.events.find(event => event.id === original.id);
      if (legacyRate) delete baseline.cnhRate;
      if (legacyGross) delete baseline.requestedGrossAmount;
      const rate = baseline.cnhRate ?? baseline.cnhAmount / baseline.amount;
      for (const payload of [
        { remark: 'new note' },
        { remark: 'new note', amount: String(baseline.requestedGrossAmount ?? baseline.amount), cnhRate: String(rate),
          fromMember: baseline.fromMember, toMember: baseline.toMember, date: baseline.date }
      ]) {
        const editApi = makeApi(undefined, legacyFixture);
        const beforeState = calculateStateFromDb(editApi.getDb());
        for (let repeat = 0; repeat < 3; repeat++) {
          const edited = await request(editApi.routes['put:/api/event/:id'], payload, { id: baseline.id });
          assert.strictEqual(edited.status, 200);
          assert.strictEqual(edited.body.data.cnhAmount, baseline.cnhAmount, 'notes must preserve exact historical CNH');
          assert.strictEqual(edited.body.data.amount, baseline.amount);
          assert.strictEqual(edited.body.data.fullExit, baseline.fullExit);
          assert.strictEqual(edited.body.data.requestedGrossAmount, baseline.requestedGrossAmount);
          const afterState = calculateStateFromDb(editApi.getDb());
          assert.deepStrictEqual(afterState.members, beforeState.members, 'editing notes must preserve member balances');
          assert.deepStrictEqual(afterState.summary, beforeState.summary);
        }
      }
      for (const payload of [{ amount: 400 }, { cnhRate: 8 }]) {
        const editApi = makeApi(undefined, legacyFixture);
        const edited = await request(editApi.routes['put:/api/event/:id'], payload, { id: baseline.id });
        assert.strictEqual(edited.status, 200);
        assert(Math.abs(edited.body.data.cnhAmount - edited.body.data.amount * (payload.cnhRate ?? rate)) < 1e-8,
          'changed money must recompute CNH, including full-exit scaling');
      }
    }
  }

  console.log('API validation regression tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
