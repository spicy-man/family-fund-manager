const assert = require('assert');
const { calculateStateFromDb } = require('../lib/calculator');
const { StorageError } = require('../lib/api-errors');
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
    { id: 'deposit', type: 'deposit', member: 'a', amount: 1000, cnhAmount: 7000,
      date: '2026-01-04', createdAt: 1, sequenceNumber: 1 },
    { id: 'valuation', type: 'valuation', totalNAV: 1000,
      date: '2026-01-09', createdAt: 2, sequenceNumber: 2 }
  ]
};
const operations = [
  ['post:/api/transaction', { member: 'a', type: 'deposit', amount: 100, date: '2026-01-11' }, {}, true],
  ['post:/api/transaction', { member: 'a', type: 'withdraw', amount: 100, date: '2026-01-11' }, {}, true],
  ['post:/api/transfer', { fromMember: 'a', toMember: 'b', amount: 100, cnhRate: 7, date: '2026-01-11' }, {}, true],
  ['post:/api/valuation', { totalNAV: 1100, date: '2026-01-12' }, {}, true],
  ['put:/api/event/:id', { amount: 900, remark: 'edited' }, { id: 'deposit' }, false],
  ['delete:/api/event/:id', {}, { id: 'valuation' }, false]
];

(async () => {
  for (const [route, body, params, isNew] of operations) {
    // Deliberately expose a shared adapter object: rejected candidates must stay
    // private even if the adapter does not detach reads like production storage.
    const sharedDb = clone(fixture);
    const calls = [];
    let failWrite = true;
    let failReplay = false;
    const api = makeApi(() => new Date('2026-10-05T00:00:00Z'), fixture, {
      readDb: () => sharedDb,
      calculateStateFromDb: (db, options) => {
        calls.push('replay');
        assert.notStrictEqual(db, sharedDb);
        assert.strictEqual(options.includeDisposalLotDetails, false);
        assert.strictEqual(options.validateMemberBalances, true);
        if (failReplay) throw new StorageError('injected replay failure');
        return calculateStateFromDb(db, options);
      },
      writeDb: db => {
        calls.push('write');
        assert.notStrictEqual(db, sharedDb);
        assert.notStrictEqual(db.events, sharedDb.events);
        if (failWrite) throw new StorageError('injected write failure');
        Object.assign(sharedDb, clone(db));
      },
      ensureIndexCache: dates => {
        calls.push('sync');
        assert.deepStrictEqual(dates, [body.date || fixture.events[0].date]);
      }
    });

    const failed = await request(api.routes[route], body, params);
    assert.strictEqual(failed.status, 500);
    assert.strictEqual(failed.body.code, 'STORAGE_ERROR');
    assert(!failed.body.message.includes('injected'));
    assert.deepStrictEqual(sharedDb, fixture, `${route}: failed save changed shared ledger`);
    assert.deepStrictEqual(calls, ['replay', 'write']);

    calls.length = 0;
    failReplay = true;
    const replayFailure = await request(api.routes[route], body, params);
    assert.strictEqual(replayFailure.status, 500);
    assert.deepStrictEqual(sharedDb, fixture);
    assert.deepStrictEqual(calls, ['replay'], 'failed validation must not save or sync');

    calls.length = 0;
    failReplay = false;
    failWrite = false;
    const saved = await request(api.routes[route], body, params);
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(calls, route.startsWith('delete:')
      ? ['replay', 'write'] : ['replay', 'write', 'sync']);
    if (isNew) {
      assert.strictEqual(saved.body.data.sequenceNumber, 3, 'failures must not consume sequence numbers');
      assert.strictEqual(sharedDb.lastEventSequence, 3);
    } else {
      assert.strictEqual(sharedDb.lastEventSequence, 2, 'edits/deletes retain the high-water mark');
    }
  }

  // An input rejection after tentative editing must also preserve shared reads.
  const sharedDb = clone(fixture);
  const api = makeApi(undefined, fixture, { readDb: () => sharedDb });
  const rejected = await request(api.routes['put:/api/event/:id'],
    { amount: 900, cnhAmount: -1 }, { id: 'deposit' });
  assert.strictEqual(rejected.status, 400);
  assert.strictEqual(rejected.body.code, 'INPUT_ERROR');
  assert.deepStrictEqual(sharedDb, fixture);
  assert.strictEqual(api.getCalculations(), 0);
  assert.strictEqual(api.getWrites(), 0);
  console.log('Transaction service: candidate isolation, single replay, failed writes, sequence retry and post-save sync passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
