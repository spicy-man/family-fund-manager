const assert = require('assert');
const AdmZip = require('adm-zip');
const { registerBackupRoutes } = require('../routes/backup');
const { InputError } = require('../lib/api-errors');
const { calculateStateFromDb } = require('../lib/calculator');
const { MAX_BACKUP_BYTES, readBackupEntry } = require('../lib/backup-import');

function normalizeRemark(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > 500) throw new InputError('备注无效。');
  return value.trim();
}
const isValidDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const baseDb = {
  members: [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }],
  performanceFee: { gpMemberId: 'b', annualRate: 0.06, feeRate: 0.25 },
  events: [
    { id: 'd', type: 'deposit', member: 'a', amount: 100, cnhAmount: 720, date: '2026-01-01', createdAt: 1, sequenceNumber: 1 },
    { id: 'v', type: 'valuation', totalNAV: 120, date: '2026-01-02', createdAt: 2, sequenceNumber: 2 }
  ]
};
function archive(db = baseDb, ledger, config = { tickers: [{ ticker: 'VOO' }] }) {
  const zip = new AdmZip();
  zip.addFile('data/db.json', Buffer.from(JSON.stringify(db)));
  zip.addFile('data/config.json', Buffer.from(JSON.stringify(config)));
  if (ledger) zip.addFile('data/settlements.json', Buffer.from(JSON.stringify(ledger)));
  return zip.toBuffer();
}
async function restore(buffer) {
  let handler;
  let saved;
  let writes = 0;
  let cacheWrites = 0;
  registerBackupRoutes({ get() {}, post(path, ...handlers) { handler = handlers.at(-1); } }, {
    readDb: () => structuredClone(baseDb), readConfig: () => ({}), readSettlements: () => ({ version: 1, records: [] }),
    writeSnapshot: (db, config, ledger) => { writes++; saved = structuredClone({ db, config, ledger }); },
    writeCnhRate: () => { cacheWrites++; }, writeIndexCache: () => { cacheWrites++; }, ensureIndexCache() {},
    normalizeRemark, isValidDate
  }, {
    toFiniteNumber: Number, findLedgerIssue: db => { calculateStateFromDb(structuredClone(db)); return null; },
    rejectLedgerIssue() {}, rejectFutureSettlementDate() {}
  }, { queueTickerRefresh: async () => {} });
  let status = 200;
  let body;
  await handler({ body: buffer }, { status(value) { status = value; return this; }, json(value) { body = value; } });
  return { status, body, saved, writes, cacheWrites };
}
function forgeSize(buffer, size) {
  const result = Buffer.from(buffer);
  for (let offset = 0; offset < result.length - 30; offset++) {
    const signature = result.readUInt32LE(offset);
    if (signature === 0x04034b50) result.writeUInt32LE(size, offset + 22);
    if (signature === 0x02014b50) result.writeUInt32LE(size, offset + 24);
  }
  return result;
}
async function rejected(buffer) {
  const result = await restore(buffer);
  assert.strictEqual(result.status, 400, JSON.stringify(result.body));
  assert.strictEqual(result.writes, 0);
  assert.strictEqual(result.cacheWrites, 0);
  return result;
}
(async () => {
  const clean = await restore(archive());
  assert.strictEqual(clean.status, 200);
  assert.deepStrictEqual(clean.saved.db.events, baseDb.events);

  const noisyDb = structuredClone(baseDb);
  noisyDb.events[0].remark = '  deposit  ';
  noisyDb.events[0]._shares = -100;
  noisyDb.events[0].fullExit = true; // irrelevant to deposits
  noisyDb.events[0].unknown = { polluted: true };
  const stripped = await restore(archive(noisyDb));
  assert.strictEqual(stripped.status, 200);
  assert.strictEqual(stripped.saved.db.events[0].remark, 'deposit');
  for (const key of ['_shares', 'unknown', 'fullExit']) assert(!(key in stripped.saved.db.events[0]));

  const transfer = { id: 't', type: 'transfer', fromMember: 'a', toMember: 'b', amount: 10,
    cnhRate: 7.2, cnhAmount: 72, date: '2026-01-03', createdAt: 3, sequenceNumber: 3,
    performanceFee: { gpMember: 'b', annualRate: 0.06, feeRate: 0.25, disposalVersion: 2, unknown: true } };
  const validTransfer = await restore(archive({ ...baseDb, events: [...baseDb.events, transfer] }));
  assert.strictEqual(validTransfer.status, 200);
  assert.strictEqual(validTransfer.saved.db.events.at(-1).cnhAmount, 72);
  assert(!('unknown' in validTransfer.saved.db.events.at(-1).performanceFee));
  for (const changes of [
    { fullExit: 'false' }, { fullExit: 1 }, { requestedGrossAmount: -1 }, { requestedGrossAmount: '10' },
    { cnhAmount: -1 }, { cnhAmount: '72' }, { performanceFee: null },
    { remark: {} }, { remark: 'x'.repeat(501) }
  ]) await rejected(archive({ ...baseDb, events: [...baseDb.events, { ...transfer, ...changes }] }));

  // Persisted full exits store net cash plus the original requested gross amount.
  const withdrawal = { id: 'w', type: 'withdraw', member: 'a', amount: 120, fullExit: true,
    requestedGrossAmount: 120, date: '2026-01-03', createdAt: 3, sequenceNumber: 3 };
  const full = await restore(archive({ ...baseDb, events: [...baseDb.events, withdrawal] }));
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.saved.db.events.at(-1).fullExit, true);
  assert.strictEqual(full.saved.db.events.at(-1).requestedGrossAmount, 120);

  const settlement = { id: 's', type: 'performance_settlement', gpMember: 'b', lpMembers: ['a', 'b'],
    annualRate: 0.06, feeRate: 0.25, algorithmVersion: 3, date: '2026-01-03', createdAt: 3, sequenceNumber: 3 };
  const computed = calculateStateFromDb({ ...baseDb, events: structuredClone([...baseDb.events, settlement]) }).events.at(-1);
  settlement.snapshot = { breakdown: computed._breakdown, totalFee: computed._totalFee, feeShares: computed._feeShares, navPerShare: computed._navAtTx };
  for (const separate of [false, true]) {
    const withSettlement = record => separate
      ? archive(baseDb, { version: 1, records: [record] })
      : archive({ ...baseDb, events: [...baseDb.events, record] });
    const valid = await restore(withSettlement({ ...settlement, _totalFee: -100, unknown: true }));
    assert.strictEqual(valid.status, 200);
    assert.deepStrictEqual(valid.saved.ledger.records[0], settlement);
    for (const lpMembers of ['a', ['missing'], ['a', 'a'], [null]]) await rejected(withSettlement({ ...settlement, lpMembers }));
    await rejected(withSettlement({ ...settlement, remark: 3 }));
    for (const algorithmVersion of [1, 2]) {
      const historical = { ...settlement, algorithmVersion };
      const replay = calculateStateFromDb({ ...baseDb, events: structuredClone([...baseDb.events, historical]) }).events.at(-1);
      historical.snapshot = { breakdown: replay._breakdown, totalFee: replay._totalFee, feeShares: replay._feeShares, navPerShare: replay._navAtTx };
      assert.strictEqual((await restore(withSettlement(historical))).status, 200);
    }
    const badSnapshot = structuredClone(settlement);
    badSnapshot.snapshot.totalFee = { hidden: 'value' };
    await rejected(withSettlement(badSnapshot));
    const legacy = { ...settlement }; delete legacy.lpMembers;
    assert.strictEqual((await restore(withSettlement(legacy))).status, 200);
  }

  // Unsequenced embedded records can share a millisecond with ordinary events.
  const interleaved = structuredClone(baseDb);
  interleaved.events.forEach(event => { delete event.sequenceNumber; });
  const unsequenced = { ...settlement, createdAt: 2 };
  delete unsequenced.sequenceNumber;
  const laterDeposit = { ...interleaved.events[0], id: 'later', amount: 10, cnhAmount: 72, date: unsequenced.date, createdAt: 2 };
  interleaved.events.push(unsequenced, laterDeposit);
  const interleavedState = calculateStateFromDb(structuredClone(interleaved));
  const interleavedComputed = interleavedState.events.find(event => event.id === unsequenced.id);
  unsequenced.snapshot = { breakdown: interleavedComputed._breakdown, totalFee: interleavedComputed._totalFee,
    feeShares: interleavedComputed._feeShares, navPerShare: interleavedComputed._navAtTx };
  const recoveredOrder = await restore(archive(interleaved));
  assert.strictEqual(recoveredOrder.status, 200, JSON.stringify(recoveredOrder.body));
  assert.strictEqual(recoveredOrder.saved.db.events.find(event => event.id === 'v').sequenceNumber, 2);
  assert.strictEqual(recoveredOrder.saved.ledger.records[0].sequenceNumber, 3);
  assert.strictEqual(recoveredOrder.saved.db.events.find(event => event.id === 'later').sequenceNumber, 4);

  await rejected(forgeSize(archive(), 0));
  // A tiny compressed entry expands beyond the budget with a zero declaration.
  const bomb = new AdmZip();
  bomb.addFile('data/db.json', Buffer.from(' '.repeat(MAX_BACKUP_BYTES + 1)));
  bomb.addFile('data/config.json', Buffer.from('{}'));
  const bombResult = await rejected(forgeSize(bomb.toBuffer(), 0));
  assert.match(bombResult.body.message, /过大/);
  // Budget is shared across entries, not allocated independently per file.
  await rejected(archive({ ...baseDb, padding: 'x'.repeat(6 * 1024 * 1024) }, undefined,
    { tickers: [{ ticker: 'VOO' }], padding: 'x'.repeat(5 * 1024 * 1024) }));

  const raw = new AdmZip();
  raw.addFile('db.json', Buffer.from('{}'));
  const normal = new AdmZip(raw.toBuffer()).getEntry('db.json');
  assert.deepStrictEqual(readBackupEntry(normal, 2), Buffer.from('{}'));
  assert.throws(() => readBackupEntry(normal, 1), InputError);
  // Stored ZIP files remain supported.
  // Build STORED data from a newly added entry, not a previously deflated one.
  const fresh = new AdmZip(); fresh.addFile('db.json', Buffer.from('{}'));
  fresh.getEntry('db.json').header.method = 0;
  assert.deepStrictEqual(readBackupEntry(new AdmZip(fresh.toBuffer()).getEntry('db.json'), 2), Buffer.from('{}'));
  const descriptor = Buffer.from(raw.toBuffer());
  for (let offset = 0; offset < descriptor.length - 30; offset++) {
    const signature = descriptor.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      descriptor.writeUInt16LE(descriptor.readUInt16LE(offset + 6) | 8, offset + 6);
      descriptor.writeUInt32LE(0, offset + 14);
      descriptor.writeUInt32LE(0, offset + 18);
      descriptor.writeUInt32LE(0, offset + 22);
    }
    if (signature === 0x02014b50) descriptor.writeUInt16LE(descriptor.readUInt16LE(offset + 8) | 8, offset + 8);
  }
  assert.deepStrictEqual(readBackupEntry(new AdmZip(descriptor).getEntry('db.json'), 2), Buffer.from('{}'));
  await rejected(archive({ ...baseDb, events: [null] }));
  for (const type of ['unknown', 'constructor', '__proto__']) {
    await rejected(archive(baseDb, { version: 1, records: [{ ...settlement, type }] }));
  }
  const collision = { ...settlement, id: 'd' };
  await rejected(archive(baseDb, { version: 1, records: [collision] }));
  const corrupt = new AdmZip(raw.toBuffer()); corrupt.getEntry('db.json').header.crc = 0;
  assert.throws(() => readBackupEntry(corrupt.getEntry('db.json'), 2), InputError);
  console.log('Backup import validation and bounded ZIP tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
