const assert = require('assert');
const { clone, makeApi, request } = require('./helpers/api-harness');
const clock = () => new Date('2026-10-04T04:00:00Z');
const fixture = {
  cnhRate: 7.2, members: [
    { id: 'lp', name: 'LP', roles: { lp: true, gp: false } },
    { id: 'gp', name: 'GP', roles: { lp: true, gp: true } },
    { id: 'other', name: 'Other', roles: { lp: true, gp: false } }
  ], performanceFee: { gpMemberId: 'gp', annualRate: 0, feeRate: .25 },
  events: [
    { id: 'deposit', type: 'deposit', member: 'lp', amount: 1000, cnhAmount: 7200, date: '2026-01-04', createdAt: 1, sequenceNumber: 1 },
    { id: 'valuation', type: 'valuation', totalNAV: 1500, date: '2026-01-30', createdAt: 2, sequenceNumber: 2 }
  ]
};
const payload = { date: '2026-02-01', gpMember: 'gp', remark: 'reviewed' };
const call = (api, route, body, params) => request(api.routes['post:' + route], body, params);
async function preview(api, body = payload) {
  const result = await call(api, '/api/performance-settlement/preview', body);
  assert.strictEqual(result.status, 200);
  assert.match(result.body.data.previewToken, /^[a-f0-9]{64}$/);
  return result.body.data;
}
async function confirm(api, body = payload) {
  const reviewed = await preview(api, body);
  return call(api, '/api/performance-settlement', { ...body, previewToken: reviewed.previewToken });
}
(async () => {
  for (const token of [undefined, '', 1, {}, 'a'.repeat(64), 'a'.repeat(63), 'gg'.repeat(32)]) {
    const api = makeApi(clock, fixture);
    const result = await call(api, '/api/performance-settlement', { ...payload, previewToken: token });
    assert.strictEqual(result.status, 409);
    assert.strictEqual(api.getWrites(), 0);
    assert.deepStrictEqual(api.getDb(), fixture);
  }
  // Legal imported event IDs must not collide with the ephemeral preview.
  for (const count of [1, 2]) {
    const collisionDb = clone(fixture);
    collisionDb.events[0].id = 'preview_settlement';
    if (count === 2) collisionDb.events[1].id = 'preview_settlement_1';
    const collisionApi = makeApi(clock, collisionDb);
    const reviewed = await preview(collisionApi);
    assert.strictEqual(reviewed.totalFee, 125);
    assert.strictEqual(reviewed.navPerShare, 1.5);
    assert(Array.isArray(reviewed.breakdown));
    assert(!collisionDb.events.some(event => event.id === reviewed.event.id));
    const saved = await call(collisionApi, '/api/performance-settlement', { ...payload, previewToken: reviewed.previewToken });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.data.snapshot, { breakdown: reviewed.breakdown,
      totalFee: reviewed.totalFee, feeShares: reviewed.feeShares, navPerShare: reviewed.navPerShare });
  }
  // Reproduce the original $125 -> $250 drift and GP switch with a valid old token.
  for (const mutate of [
    api => request(api.routes['put:/api/event/:id'], { totalNAV: 2000 }, { id: 'valuation' }),
    api => request(api.routes['put:/api/members/:id/roles'], { gp: true }, { id: 'other' }),
    api => call(api, '/api/transaction', { date: '2026-02-08', type: 'deposit', member: 'lp', amount: 10 }),
    api => request(api.routes['put:/api/members/:id'], { name: 'Renamed LP' }, { id: 'lp' })
  ]) {
    const api = makeApi(clock, fixture);
    const reviewed = await preview(api);
    assert.strictEqual(reviewed.totalFee, 125);
    assert.strictEqual((await mutate(api)).status, 200);
    const before = api.getDb(), writes = api.getWrites();
    const rejected = await call(api, '/api/performance-settlement', { ...payload, previewToken: reviewed.previewToken });
    assert.strictEqual(rejected.status, 409);
    assert.strictEqual(api.getWrites(), writes);
    assert.deepStrictEqual(api.getDb(), before);
    const freshBody = { ...payload, gpMember: before.performanceFee.gpMemberId };
    const fresh = await confirm(api, freshBody);
    assert.strictEqual(fresh.status, 200);
    assert.strictEqual(fresh.body.data.gpMember, freshBody.gpMember);
  }
  for (const change of [{ date: '2026-02-02' }, { remark: 'changed' }, { gpMember: 'other' }]) {
    const api = makeApi(clock, fixture);
    const reviewed = await preview(api);
    assert.strictEqual((await call(api, '/api/performance-settlement', { ...payload, ...change, previewToken: reviewed.previewToken })).status, 409);
    assert.strictEqual(api.getWrites(), 0);
  }
  const api = makeApi(clock, fixture);
  const oldPreview = await preview(api);
  const first = await confirm(api);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.data.snapshot.totalFee, oldPreview.totalFee);
  const second = await confirm(api, { ...payload, date: '2026-03-01' });
  assert.strictEqual(second.status, 200);
  const reverse = body => call(api, '/api/performance-settlement/reverse-latest', body);
  assert.strictEqual((await reverse({})).status, 400);
  assert.strictEqual((await reverse({ settlementId: 'missing' })).status, 404);
  assert.strictEqual((await reverse({ settlementId: first.body.data.id })).status, 409);
  const reversed = await reverse({ settlementId: second.body.data.id, remark: 'once' });
  assert.strictEqual(reversed.status, 200);
  const writesAfter = api.getWrites(), ledgerAfter = api.getLedger();
  const retried = await reverse({ settlementId: second.body.data.id, remark: 'retry' });
  assert.strictEqual(retried.status, 200);
  assert.deepStrictEqual(retried.body.data, reversed.body.data);
  assert.strictEqual(api.getWrites(), writesAfter);
  assert.deepStrictEqual(api.getLedger(), ledgerAfter);
  assert(api.getDb().events.some(event => event.id === first.body.data.id));
  // Idempotence is persisted and survives a route/server restart.
  const restarted = makeApi(clock, api.getDb(), {}, api.getLedger());
  const restartRetry = await call(restarted, '/api/performance-settlement/reverse-latest', { settlementId: second.body.data.id });
  assert.strictEqual(restartRetry.status, 200);
  assert.strictEqual(restarted.getWrites(), 0);
  await reverse({ settlementId: first.body.data.id });
  const staleAfterReversal = await call(api, '/api/performance-settlement', { ...payload, previewToken: oldPreview.previewToken });
  assert.strictEqual(staleAfterReversal.status, 409);
  const replaced = await confirm(api);
  assert.strictEqual(replaced.status, 200);
  assert.strictEqual((await reverse({ settlementId: second.body.data.id })).status, 200);
  assert(api.getDb().events.some(event => event.id === replaced.body.data.id), 'retry must not reverse a replacement');
  // Tokens issued by a prior server registration fail closed after restart.
  const tokenBeforeRestart = await preview(makeApi(clock, fixture));
  assert.strictEqual((await call(makeApi(clock, fixture), '/api/performance-settlement', { ...payload, previewToken: tokenBeforeRestart.previewToken })).status, 409);

  let rate = 7.2, rateWrites = 0;
  const settings = makeApi(clock, fixture, { writeCnhRate: value => { rate = value; rateWrites++; } });
  const bad = await call(settings, '/api/settings', { cnhRate: 8, benchmarkClosePolicy: 'invalid' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(rate, 7.2);
  assert.strictEqual(rateWrites, 0);
  assert.strictEqual(settings.getWrites(), 0);
  const good = await call(settings, '/api/settings', { cnhRate: 8, benchmarkClosePolicy: 'previous' });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(rate, 8);
  assert.strictEqual(rateWrites, 1);
  console.log('Settlement confirmation, targeted reversal and settings regressions passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
