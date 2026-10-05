const assert = require('assert');
const { calculateStateFromDb } = require('../lib/calculator');
const { clone, makeApi, request } = require('./helpers/api-harness');
const fixture = {
  cnhRate: 7.2,
  members: [
    { id: 'a', name: 'Alice', roles: { lp: true, gp: false } },
    { id: 'b', name: 'Bob', roles: { lp: true, gp: true } }
  ],
  performanceFee: { gpMemberId: 'b', annualRate: 0.06, feeRate: 0.25 },
  lastEventSequence: 2,
  events: [
    { id: 'deposit', type: 'deposit', member: 'a', amount: 1000, cnhAmount: 7200, date: '2026-01-04', createdAt: 1, sequenceNumber: 1 },
    { id: 'value', type: 'valuation', totalNAV: 2000, date: '2026-01-09', createdAt: 2, sequenceNumber: 2 }
  ]
};
const near = (a, b) => assert(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
(async () => {
  for (const type of ['withdraw', 'transfer']) {
    for (const fullExit of [false, true]) {
      for (const selfGp of [false, true]) {
        const db = clone(fixture);
        if (selfGp) {
          db.performanceFee.gpMemberId = 'a';
          db.members[0].roles.gp = true;
          db.members[1].roles.gp = false;
        }
        let syncs = 0;
        const api = makeApi(undefined, db, { ensureIndexCache: () => { syncs++; } });
        const body = { type, amount: 300, date: '2026-01-11', fullExit,
          ...(type === 'withdraw' ? { member: 'a', cnhAmount: 2100 } : { fromMember: 'a', toMember: 'b', cnhRate: 7 }) };
        const response = await request(api.routes['post:/api/disposal/preview'], body);
        assert.strictEqual(response.status, 200, JSON.stringify(response.body));
        const preview = response.body.data;
        assert.deepStrictEqual(api.getDb(), db);
        assert.strictEqual(api.getWrites(), 0);
        assert.strictEqual(syncs, 0);
        assert.strictEqual(preview.fullExit, fullExit);
        assert.strictEqual(preview.valuationDate, '2026-01-09');
        assert.strictEqual(preview.nav, 2);
        assert(preview.performanceFee > 0);
        if (fullExit) {
          assert.strictEqual(preview.input.amount, 2000);
          assert.strictEqual(preview.sender.after.currentValue, 0);
          assert.strictEqual(preview.sender.after.remainingPrincipal, 0);
          near(preview.actualAmount, selfGp ? 2000 : 2000 - preview.performanceFee);
        } else near(preview.actualAmount, 300);
        const again = await request(api.routes['post:/api/disposal/preview'], body);
        assert.deepStrictEqual(again.body.data, preview, 'repeated estimates must be deterministic');
        const saved = await request(api.routes[type === 'withdraw' ? 'post:/api/transaction' : 'post:/api/transfer'], preview.input);
        assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
        assert.strictEqual(saved.body.data.sequenceNumber, 3, 'preview must not consume sequence numbers');
        const state = calculateStateFromDb(api.getDb());
        const event = state.events.find(e => e.id === saved.body.data.id);
        near(event._actualAmount, preview.actualAmount);
        near(event._performanceFee, preview.performanceFee);
        near(event._cnhAmountComputed, preview.cnhAmount);
        assert.deepStrictEqual(state.members.a, preview.sender.after);
        if (type === 'transfer') assert.deepStrictEqual(state.members.b, preview.recipient.after);
      }
    }
  }
  // Displayed all-exit amounts may round above the exact Decimal entitlement.
  // Both preview and formal creation must still dispose every share.
  for (const totalNAV of [2000.004, 2000.006]) {
    for (const type of ['withdraw', 'transfer']) {
      const fractional = clone(fixture);
      fractional.events[1].totalNAV = totalNAV;
      const fractionalApi = makeApi(undefined, fractional);
      const trial = await request(fractionalApi.routes['post:/api/disposal/preview'], {
        type, date: '2026-01-11', fullExit: true,
        ...(type === 'withdraw' ? { member: 'a' } : { fromMember: 'a', toMember: 'b', cnhRate: 7 })
      });
      assert.strictEqual(trial.status, 200, JSON.stringify(trial.body));
      assert.strictEqual(trial.body.data.sender.after.shares, 0);
      const saved = await request(fractionalApi.routes[type === 'withdraw' ? 'post:/api/transaction' : 'post:/api/transfer'], trial.body.data.input);
      assert.strictEqual(saved.status, 200);
      assert.strictEqual(saved.body.data.fullExit, true);
      assert.strictEqual(calculateStateFromDb(fractionalApi.getDb()).members.a.shares, 0);
      near(saved.body.data.amount, trial.body.data.actualAmount);
    }
  }
  // Historical estimates report the operation-date state, not later valuations.
  const historical = clone(fixture);
  historical.events.push({ id: 'later', type: 'valuation', totalNAV: 3000, date: '2026-01-16', createdAt: 3, sequenceNumber: 3 });
  historical.lastEventSequence = 3;
  const api = makeApi(undefined, historical);
  const preview = await request(api.routes['post:/api/disposal/preview'], { type: 'withdraw', member: 'a', date: '2026-01-11', fullExit: true });
  assert.strictEqual(preview.body.data.sender.before.currentValue, 2000);
  assert.strictEqual(preview.body.data.sender.after.currentValue, 0);
  // Persisting would leave a later valuation without shares; reject equally in preview and save.
  const allLp = makeApi(undefined, { ...fixture, performanceFee: { annualRate: 0.06, feeRate: 0.25, gpMemberId: null }, events: historical.events });
  const invalidHistory = await request(allLp.routes['post:/api/disposal/preview'], { type: 'withdraw', member: 'a', date: '2026-01-11', fullExit: true });
  assert.strictEqual(invalidHistory.status, 400);

  const defaultFx = makeApi(undefined, fixture);
  const withoutCnh = await request(defaultFx.routes['post:/api/disposal/preview'], {
    type: 'withdraw', member: 'a', amount: 300, date: '2026-01-11'
  });
  assert.strictEqual(withoutCnh.body.data.input.cnhAmount, 2160, 'apply payload must contain the default conversion even when CNH was omitted');

  const changed = makeApi(undefined, fixture);
  const trial = (await request(changed.routes['post:/api/disposal/preview'], { type: 'withdraw', member: 'a', amount: 300, date: '2026-01-11' })).body.data;
  await request(changed.routes['post:/api/transaction'], { type: 'deposit', member: 'a', amount: 100, date: '2026-01-11' });
  const stale = await request(changed.routes['post:/api/transaction'], trial.input);
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(changed.getWrites(), 1);
  for (const body of [
    { type: 'deposit' },
    { type: 'withdraw', member: 'a', amount: 3000, date: '2026-01-11' },
    { type: 'withdraw', member: 'a', amount: 300, date: '2026-01-12' },
    { type: 'withdraw', member: 'missing', date: '2026-01-11', fullExit: true },
    { type: 'transfer', fromMember: 'a', toMember: 'a', date: '2026-01-11', fullExit: true, cnhRate: 7 }
  ]) {
    const clean = makeApi(undefined, fixture);
    const rejected = await request(clean.routes['post:/api/disposal/preview'], body);
    assert.strictEqual(rejected.status, 400, JSON.stringify(body));
    assert.strictEqual(clean.getWrites(), 0);
  }
  const lockedDb = clone(fixture);
  lockedDb.events.push({ id: 'settlement', type: 'performance_settlement', date: '2026-01-11' });
  const locked = makeApi(undefined, lockedDb);
  const rejected = await request(locked.routes['post:/api/disposal/preview'], { type: 'withdraw', member: 'a', amount: 300, date: '2026-01-11' });
  assert.strictEqual(rejected.status, 409);
  console.log('Disposal preview: read-only estimates, formal replay parity, full exits, GP, historical dates and stale-ledger protection passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
