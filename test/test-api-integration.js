const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const express = require('express');
const { calculateStateFromDb } = require('../lib/calculator');
const { registerSettingsRoutes } = require('../routes/settings');
const { normalizeApiErrorResponses, apiErrorHandler } = require('../lib/api-errors');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-api-'));
process.env.FUND_DATA_DIR = dataDir;
process.env.FUND_BACKUP_DIR = path.join(dataDir, 'backups');
process.env.FUND_EXTERNAL_SYNC = '0';

const { startServer } = require('../server');

function request(server, method, pathname, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestBuffer(server, method, pathname, body, contentType = 'application/zip') {
  return new Promise((resolve, reject) => {
    const headers = body ? { 'Content-Type': contentType, 'Content-Length': body.length } : {};
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method,
      headers
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startExternalFailureServer() {
  const isolatedApp = express();
  isolatedApp.use('/api', normalizeApiErrorResponses);
  isolatedApp.use(express.json());
  registerSettingsRoutes(isolatedApp, {
    readDb: () => ({ cnhRate: 7.2, events: [] }),
    writeDb: () => {},
    ensureIndexCache: () => {},
    fetchCnhRateFromApi: async () => null
  }, {
    toFiniteNumber: value => Number(value)
  });
  isolatedApp.use('/api', apiErrorHandler);
  const server = isolatedApp.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return server;
}

(async () => {
  const browserUrls = [];
  const server = startServer({ port: 0, openBrowser: true,
    launchBrowser: url => {
      assert.strictEqual(server.listening, true, 'browser must wait for a successful listen');
      browserUrls.push(url);
    }
  });
  assert.strictEqual(browserUrls.length, 0, 'starting the server must not open the browser early');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    assert.deepStrictEqual(browserUrls, [`http://localhost:${server.address().port}`]);
    const firstPage = await requestBuffer(server, 'GET', '/');
    assert.strictEqual(firstPage.status, 200, 'the first page request after browser launch must succeed');
    assert(firstPage.body.toString().includes('<!DOCTYPE html>'));
    const failedLaunches = [];
    const occupied = startServer({ port: server.address().port, openBrowser: true,
      launchBrowser: url => failedLaunches.push(url) });
    const bindError = await new Promise(resolve => occupied.once('error', resolve));
    assert.strictEqual(bindError.code, 'EADDRINUSE');
    assert.deepStrictEqual(failedLaunches, [], 'a failed server must not open a browser');

    let response = await request(server, 'GET', '/api/state');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.summary.totalNAV, 0);

    response = await request(server, 'POST', '/api/transaction', {
      member: 'me', type: 'deposit', amount: 100.1, cnhAmount: 720.72, date: '2026-03-01', remark: 'initial funding'
    });
    assert.strictEqual(response.status, 200);

    response = await request(server, 'POST', '/api/valuation', {
      totalNAV: 0, date: '2026-03-02', remark: 'invalid zero valuation'
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.code, 'INPUT_ERROR');

    response = await request(server, 'POST', '/api/valuation', {
      totalNAV: 120.12, date: '2026-03-02', remark: 'mark to market'
    });
    assert.strictEqual(response.status, 200);
    const valuationId = response.body.data.id;

    response = await request(server, 'POST', '/api/transaction', {
      member: 'me', type: 'withdraw', amount: 200, date: '2026-03-08'
    });
    assert.strictEqual(response.status, 400);

    response = await request(server, 'POST', '/api/transaction', {
      member: 'me', type: 'withdraw', amount: 120, date: '2026-03-08'
    });
    assert.strictEqual(response.status, 200);

    // Editing the valuation down would also make the later withdrawal underfunded.
    response = await request(server, 'PUT', `/api/event/${valuationId}`, { totalNAV: 100 });
    assert.strictEqual(response.status, 400);

    // Removing the historical valuation would make the later $120 withdrawal
    // underfunded. Reject the mutation rather than silently capping the withdrawal.
    response = await request(server, 'DELETE', `/api/event/${valuationId}`);
    assert.strictEqual(response.status, 400);

    const customBenchmark1 = { name: '组合一', components: [{ ticker: 'VOO', weight: 100 }] };
    const customBenchmark2 = {
      name: '科技组合',
      components: [{ ticker: 'QQQM', weight: 60 }, { ticker: 'AAPL', weight: 40 }]
    };
    response = await request(server, 'POST', '/api/settings/custom-benchmark', {
      slot: 0, customBenchmark: customBenchmark1
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.name, 'VOO', 'single-component benchmark name must normalize to ticker');
    response = await request(server, 'POST', '/api/settings/custom-benchmark', {
      slot: 1, customBenchmark: customBenchmark2
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.name, '科技组合', 'multi-component benchmark name must preserve custom name');

    const exported = await requestBuffer(server, 'GET', '/api/backup/export');
    assert.strictEqual(exported.status, 200);
    assert.strictEqual(exported.headers['content-type'], 'application/zip');
    const backupZip = new AdmZip(exported.body);
    const exportedDb = JSON.parse(backupZip.readAsText('data/db.json'));
    const exportedConfig = JSON.parse(backupZip.readAsText('data/config.json'));
    const exportedSettlements = JSON.parse(backupZip.readAsText('data/settlements.json'));
    assert.strictEqual(exportedDb.events.length, 3);
    assert.deepStrictEqual(exportedDb.events.map(event => event.sequenceNumber), [1, 2, 3]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(exportedDb, 'indexCache'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(exportedDb, 'customBenchmarkCache'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(exportedDb, 'marketHistory'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(
      JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')), 'marketHistory'), false);
    assert(Array.isArray(exportedConfig.tickers));
    assert.deepStrictEqual(exportedConfig.customBenchmark, {
      name: 'VOO',
      components: [{ ticker: 'VOO', weight: 100 }]
    });
    assert.deepStrictEqual(exportedConfig.customBenchmark2, {
      name: '科技组合',
      components: [{ ticker: 'QQQM', weight: 60 }, { ticker: 'AAPL', weight: 40 }]
    });
    assert.deepStrictEqual(exportedSettlements, { version: 1, records: [] });

    // A valid future settlement snapshot must not bypass the live date guard
    // through either backup format, and rejection must preserve every core file.
    const futureDb = {
      ...exportedDb,
      performanceFee: { gpMemberId: 'me', annualRate: 0.06, feeRate: 0.25 },
      members: exportedDb.members.map(member => ({ ...member, roles: { lp: true, gp: member.id === 'me' } }))
    };
    const futureSettlement = {
      id: 'future_import_s', type: 'performance_settlement', date: '2030-12-31',
      gpMember: 'me', lpMembers: futureDb.members.map(member => member.id),
      annualRate: 0.06, feeRate: 0.25, algorithmVersion: 3, createdAt: Date.now(), sequenceNumber: 4
    };
    const futureComputed = calculateStateFromDb(JSON.parse(JSON.stringify({
      ...futureDb, events: [...futureDb.events, futureSettlement]
    }))).events.at(-1);
    futureSettlement.snapshot = {
      breakdown: futureComputed._breakdown, totalFee: futureComputed._totalFee,
      feeShares: futureComputed._feeShares, navPerShare: futureComputed._navAtTx
    };
    const coreFiles = ['db.json', 'config.json', 'settlements.json'];
    const beforeFutureImport = coreFiles.map(file => fs.readFileSync(path.join(dataDir, file)));
    for (const separateLedger of [false, true]) {
      const futureBackup = new AdmZip();
      futureBackup.addFile('data/db.json', Buffer.from(JSON.stringify({
        ...futureDb, events: separateLedger ? futureDb.events : [...futureDb.events, futureSettlement]
      })));
      futureBackup.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
      if (separateLedger) futureBackup.addFile('data/settlements.json', Buffer.from(JSON.stringify({
        version: 1, records: [futureSettlement]
      })));
      const futureImport = await requestBuffer(server, 'POST', '/api/backup/import', futureBackup.toBuffer());
      assert.strictEqual(futureImport.status, 400);
      assert.match(JSON.parse(futureImport.body).message, /不能晚于今天/);
      coreFiles.forEach((file, index) => assert.deepStrictEqual(
        fs.readFileSync(path.join(dataDir, file)), beforeFutureImport[index], 'rejected import must not replace core files'
      ));
    }

    const invalidDisposalVersionBackup = new AdmZip();
    invalidDisposalVersionBackup.addFile('data/db.json', Buffer.from(JSON.stringify({
      ...exportedDb,
      events: exportedDb.events.map((event, index) => index === exportedDb.events.length - 1
        ? {
            ...event,
            performanceFee: { gpMember: 'me', annualRate: 0.06, feeRate: 0.25, disposalVersion: 999 }
          }
        : event)
    })));
    invalidDisposalVersionBackup.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
    const rejectedDisposalVersionRestore = await requestBuffer(
      server,
      'POST',
      '/api/backup/import',
      invalidDisposalVersionBackup.toBuffer()
    );
    assert.strictEqual(rejectedDisposalVersionRestore.status, 400);

    const invalidCurrentRateBackup = new AdmZip();
    invalidCurrentRateBackup.addFile('data/db.json', Buffer.from(JSON.stringify({
      ...exportedDb,
      performanceFee: { ...exportedDb.performanceFee, annualRate: 1.01 }
    })));
    invalidCurrentRateBackup.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
    const rejectedCurrentRateRestore = await requestBuffer(
      server,
      'POST',
      '/api/backup/import',
      invalidCurrentRateBackup.toBuffer()
    );
    assert.strictEqual(rejectedCurrentRateRestore.status, 400, 'out-of-range current fee policy must be rejected');

    const historicalRateBackup = new AdmZip();
    historicalRateBackup.addFile('data/db.json', Buffer.from(JSON.stringify({
      ...exportedDb,
      performanceFee: { gpMemberId: 'me', annualRate: 0.08, feeRate: 0.3 },
      events: exportedDb.events.map((event, index) => index === exportedDb.events.length - 1
        ? {
            ...event,
            // Adding a fee snapshot lowers the LP net cash limit. Keep this
            // fixture a valid partial exit rather than an overdraw near gross NAV.
            amount: 60,
            cnhAmount: 432,
            performanceFee: { gpMember: 'me', annualRate: 0.07, feeRate: 0.2, disposalVersion: 2 }
          }
        : event)
    })));
    historicalRateBackup.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
    const historicalRateRestore = await requestBuffer(
      server,
      'POST',
      '/api/backup/import',
      historicalRateBackup.toBuffer()
    );
    assert.strictEqual(historicalRateRestore.status, 200, 'valid historical fee snapshots must survive import');
    const historicalRateRoundTrip = await requestBuffer(server, 'GET', '/api/backup/export');
    const historicalRateRoundTripDb = JSON.parse(new AdmZip(historicalRateRoundTrip.body).readAsText('data/db.json'));
    assert.strictEqual(historicalRateRoundTripDb.performanceFee.gpMemberId, 'me');
    assert.strictEqual(historicalRateRoundTripDb.members.find(member => member.id === 'me').roles.gp, true,
      'the imported GP configuration must remain the role source of truth');

    response = await request(server, 'POST', '/api/settings/tickers', {
      tickers: [{ ticker: 'AAPL' }]
    });
    assert.strictEqual(response.status, 200);

    const restored = await requestBuffer(server, 'POST', '/api/backup/import', exported.body);
    assert.strictEqual(restored.status, 200);
    const restoredPayload = JSON.parse(restored.body.toString('utf8'));
    assert.strictEqual(restoredPayload.success, true);

    response = await request(server, 'GET', '/api/settings/tickers');
    assert.deepStrictEqual(response.body.data, exportedConfig.tickers);

    // TASK-012: a configured GP cannot be deleted, and every newly persisted
    // disposal snapshot must point to that existing member throughout a ZIP
    // export/import round trip.
    response = await request(server, 'PUT', '/api/members/father/roles', {
      gp: true, primaryGp: true
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'DELETE', '/api/members/father');
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.code, 'BUSINESS_CONFLICT');

    response = await request(server, 'POST', '/api/transaction', {
      member: 'mother', type: 'deposit', amount: 100, date: '2026-03-15'
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/transaction', {
      member: 'mother', type: 'withdraw', amount: 10, date: '2026-03-22'
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/transfer', {
      fromMember: 'mother', toMember: 'me', amount: 10, cnhRate: 7.2, date: '2026-03-29'
    });
    assert.strictEqual(response.status, 200);

    // Once the GP role moves, the former GP is still referenced by immutable
    // historical disposal snapshots and therefore must remain undeletable.
    response = await request(server, 'PUT', '/api/members/me/roles', {
      gp: true, primaryGp: true
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'DELETE', '/api/members/father');
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.code, 'BUSINESS_CONFLICT');

    const gpInvariantExport = await requestBuffer(server, 'GET', '/api/backup/export');
    const gpInvariantZip = new AdmZip(gpInvariantExport.body);
    const gpInvariantDb = JSON.parse(gpInvariantZip.readAsText('data/db.json'));
    const disposalSnapshots = gpInvariantDb.events
      .filter(event => event.type === 'withdraw' || event.type === 'transfer')
      .map(event => event.performanceFee)
      .filter(Boolean);
    assert(disposalSnapshots.length >= 2);
    assert(disposalSnapshots.every(snapshot => snapshot.gpMember === 'father'));
    let invariantRestore = await requestBuffer(server, 'POST', '/api/backup/import', gpInvariantExport.body);
    assert.strictEqual(invariantRestore.status, 200);
    const beforeRejectedInvariantRestore = await request(server, 'GET', '/api/state');

    const danglingGpZip = new AdmZip(gpInvariantExport.body);
    danglingGpZip.updateFile('data/db.json', Buffer.from(JSON.stringify({
      ...gpInvariantDb,
      members: gpInvariantDb.members.filter(member => member.id !== 'father')
    })));
    invariantRestore = await requestBuffer(server, 'POST', '/api/backup/import', danglingGpZip.toBuffer());
    assert.strictEqual(invariantRestore.status, 400);
    assert.strictEqual(JSON.parse(invariantRestore.body.toString('utf8')).code, 'INPUT_ERROR');
    const afterRejectedInvariantRestore = await request(server, 'GET', '/api/state');
    assert.deepStrictEqual(afterRejectedInvariantRestore.body.data, beforeRejectedInvariantRestore.body.data,
      'a rejected dangling-GP restore must not mutate the live ledger');

    // Reset for the independent import and settlement scenarios below.
    invariantRestore = await requestBuffer(server, 'POST', '/api/backup/import', exported.body);
    assert.strictEqual(invariantRestore.status, 200);

    const externalFailureServer = await startExternalFailureServer();
    try {
      response = await request(externalFailureServer, 'POST', '/api/settings/sync-rate', {});
      assert.strictEqual(response.status, 502);
      assert.strictEqual(response.body.code, 'EXTERNAL_SERVICE_ERROR');
    } finally {
      await new Promise(resolve => externalFailureServer.close(resolve));
    }

    const zeroNavBackup = new AdmZip();
    zeroNavBackup.addFile('data/db.json', Buffer.from(JSON.stringify({
      ...exportedDb,
      events: [
        { id: 'zero_base', type: 'deposit', member: 'me', amount: 100, cnhAmount: 720, date: '2026-01-01', createdAt: 1 },
        { id: 'zero_mark', type: 'valuation', totalNAV: 0, date: '2026-01-02', createdAt: 2 }
      ]
    })));
    zeroNavBackup.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
    const rejectedZeroNavRestore = await requestBuffer(
      server,
      'POST',
      '/api/backup/import',
      zeroNavBackup.toBuffer()
    );
    assert.strictEqual(rejectedZeroNavRestore.status, 400);

    const preInceptionBackup = new AdmZip();
    preInceptionBackup.addFile('data/db.json', Buffer.from(JSON.stringify({
      ...exportedDb,
      events: [
        { id: 'early_mark', type: 'valuation', totalNAV: 500, date: '2026-01-01', createdAt: 1 },
        { id: 'later_deposit', type: 'deposit', member: 'me', amount: 100, cnhAmount: 720, date: '2026-01-02', createdAt: 2 }
      ]
    })));
    preInceptionBackup.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
    const rejectedPreInceptionRestore = await requestBuffer(
      server,
      'POST',
      '/api/backup/import',
      preInceptionBackup.toBuffer()
    );
    assert.strictEqual(rejectedPreInceptionRestore.status, 400);

    response = await request(server, 'GET', '/api/state');
    assert.strictEqual(response.body.data.summary.totalNAV, 0.12);
    assert.strictEqual(response.body.data.members.me.currentValue, 0.12);

    // Exercise the production settlement ledger merge: a reversed settlement
    // must disappear from the active event stream so the same date can be used
    // again.
    response = await request(server, 'PUT', '/api/members/father/roles', {
      gp: true, primaryGp: true
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/valuation', {
      totalNAV: 1.2, date: '2026-03-09', remark: 'settlement regression valuation'
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/performance-settlement', {
      date: '2026-03-09'
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/performance-settlement/reverse-latest', {
      remark: 'same-day settlement regression'
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/performance-settlement', {
      date: '2026-03-09'
    });
    assert.strictEqual(response.status, 200);

    // A pre-split legacy backup can interleave a settlement with ordinary
    // events at the same millisecond. The migration must retain that order.
    const embeddedDb = {
      cnhRate: 7.2,
      benchmarkClosePolicy: 'previous',
      performanceFee: { gpMemberId: 'father', annualRate: 0.06, feeRate: 0.25 },
      members: [
        { id: 'me', name: 'LP', roles: { lp: true, gp: false } },
        { id: 'father', name: 'GP', roles: { lp: true, gp: true } }
      ],
      events: [
        { id: 'embedded_d1', type: 'deposit', member: 'me', amount: 100, cnhAmount: 720, date: '2025-01-01', createdAt: 1 },
        { id: 'embedded_v', type: 'valuation', totalNAV: 120, date: '2026-01-01', createdAt: 2 }
      ]
    };
    const embeddedSettlement = {
      id: 'embedded_s', type: 'performance_settlement', algorithmVersion: 3,
      date: '2026-01-01', createdAt: 2, gpMember: 'father', lpMembers: ['me', 'father'],
      annualRate: 0.06, feeRate: 0.25, remark: 'embedded equal timestamp fixture'
    };
    const embeddedLaterDeposit = {
      id: 'embedded_d2', type: 'deposit', member: 'me', amount: 10, cnhAmount: 72,
      date: '2026-01-01', createdAt: 2
    };
    embeddedDb.events.push(embeddedSettlement, embeddedLaterDeposit);
    const embeddedState = calculateStateFromDb(embeddedDb);
    const computedEmbedded = embeddedState.events.find(item => item.id === embeddedSettlement.id);
    embeddedSettlement.snapshot = {
      breakdown: computedEmbedded._breakdown,
      totalFee: computedEmbedded._totalFee,
      feeShares: computedEmbedded._feeShares,
      navPerShare: computedEmbedded._navAtTx
    };
    const embeddedZip = new AdmZip();
    embeddedZip.addFile('data/db.json', Buffer.from(JSON.stringify(embeddedDb)));
    embeddedZip.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
    let embeddedResponse = await requestBuffer(server, 'POST', '/api/backup/import', embeddedZip.toBuffer());
    assert.strictEqual(embeddedResponse.status, 200);
    embeddedResponse = await requestBuffer(server, 'GET', '/api/backup/export');
    const embeddedRoundTrip = new AdmZip(embeddedResponse.body);
    const embeddedRoundTripDb = JSON.parse(embeddedRoundTrip.readAsText('data/db.json'));
    const embeddedRoundTripLedger = JSON.parse(embeddedRoundTrip.readAsText('data/settlements.json'));
    assert.strictEqual(embeddedRoundTripDb.events.find(item => item.id === 'embedded_v').sequenceNumber, 2);
    assert.strictEqual(embeddedRoundTripLedger.records.find(item => item.id === 'embedded_s').sequenceNumber, 3);
    assert.strictEqual(embeddedRoundTripDb.events.find(item => item.id === 'embedded_d2').sequenceNumber, 4);

    // Full cross-version lifecycle: import an active v1 settlement, reverse
    // it, confirm v2 on the same date, then export/import without state drift.
    const legacyBackupIndexCache = {
      '2025-01-01': {
        spx: 5881.63,
        ndx: 21012.17,
        spxPriceDate: '2024-12-31',
        ndxPriceDate: '2024-12-31',
        policy: 'previous'
      }
    };
    const crossVersionDb = {
      cnhRate: 7.2,
      benchmarkClosePolicy: 'previous',
      performanceFee: { gpMemberId: 'father', annualRate: 0.06, feeRate: 0.25 },
      members: [
        { id: 'me', name: 'LP', roles: { lp: true, gp: false } },
        { id: 'father', name: 'GP', roles: { lp: true, gp: true } }
      ],
      indexCache: legacyBackupIndexCache,
      events: [
        { id: 'cross_d', type: 'deposit', member: 'me', amount: 100, cnhAmount: 720, date: '2025-01-01', createdAt: 1 },
        { id: 'cross_v', type: 'valuation', totalNAV: 120, date: '2026-01-01', createdAt: 2 }
      ]
    };
    const legacySettlement = {
      id: 'cross_s_v1', type: 'performance_settlement', algorithmVersion: 1,
      date: '2026-01-01', createdAt: 3, gpMember: 'father', lpMembers: ['me', 'father'],
      annualRate: 0.06, feeRate: 0.25, remark: 'legacy v1 fixture'
    };
    const legacyState = calculateStateFromDb({
      ...crossVersionDb,
      events: [...crossVersionDb.events, legacySettlement]
    });
    const computedLegacy = legacyState.events.find(item => item.id === legacySettlement.id);
    legacySettlement.snapshot = {
      breakdown: computedLegacy._breakdown,
      totalFee: computedLegacy._totalFee,
      feeShares: computedLegacy._feeShares,
      navPerShare: computedLegacy._navAtTx
    };
    const crossVersionZip = new AdmZip();
    crossVersionZip.addFile('data/db.json', Buffer.from(JSON.stringify(crossVersionDb)));
    crossVersionZip.addFile('data/config.json', Buffer.from(JSON.stringify(exportedConfig)));
    crossVersionZip.addFile('data/settlements.json', Buffer.from(JSON.stringify({
      version: 1,
      records: [legacySettlement]
    })));
    let crossResponse = await requestBuffer(
      server, 'POST', '/api/backup/import', crossVersionZip.toBuffer()
    );
    assert.strictEqual(crossResponse.status, 200);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(dataDir, 'index-cache.json'), 'utf8')),
      legacyBackupIndexCache
    );
    response = await request(server, 'POST', '/api/performance-settlement/reverse-latest', {
      remark: 'cross-version reversal'
    });
    assert.strictEqual(response.status, 200);
    response = await request(server, 'POST', '/api/performance-settlement', {
      date: '2026-01-01', remark: 'replacement v3 settlement'
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.data.algorithmVersion, 3);
    const beforeRoundTrip = await request(server, 'GET', '/api/state');
    const crossExport = await requestBuffer(server, 'GET', '/api/backup/export');
    assert.strictEqual(crossExport.status, 200);
    const crossExportZip = new AdmZip(crossExport.body);
    const crossExportDb = JSON.parse(crossExportZip.readAsText('data/db.json'));
    const crossLedger = JSON.parse(crossExportZip.readAsText('data/settlements.json'));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(crossExportDb, 'indexCache'), false);
    assert.deepStrictEqual(
      crossLedger.records.filter(item => item.type === 'performance_settlement').map(item => item.algorithmVersion),
      [1, 3]
    );
    crossResponse = await requestBuffer(server, 'POST', '/api/backup/import', crossExport.body);
    assert.strictEqual(crossResponse.status, 200);
    const afterRoundTrip = await request(server, 'GET', '/api/state');
    assert.deepStrictEqual(afterRoundTrip.body.data.summary, beforeRoundTrip.body.data.summary);
    assert.deepStrictEqual(afterRoundTrip.body.data.members, beforeRoundTrip.body.data.members);

    // Both settlement types are immutable through the ordinary event API.
    const reversal = crossLedger.records.find(item => item.type === 'performance_settlement_reversal');
    const ledgerBefore = fs.readFileSync(path.join(dataDir, 'settlements.json'), 'utf8');
    for (const method of ['PUT', 'DELETE']) {
      response = await request(server, method, `/api/event/${reversal.id}`,
        method === 'PUT' ? { remark: 'must not change' } : undefined);
      assert.strictEqual(response.status, 409);
      assert.strictEqual(response.body.code, 'BUSINESS_CONFLICT');
    }
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'settlements.json'), 'utf8'), ledgerBefore);

    // After a successful core commit, a disposable rate-cache failure is a
    // warning, never a false failed restore. Use a different live book first.
    const storage = require('../lib/storage');
    const oldWriteRate = storage.writeCnhRateCache;
    const oldConsoleError = console.error;
    let warningRestore;
    try {
      storage.writeCnhRateCache = () => { throw new Error('injected rate cache failure'); };
      console.error = () => {};
      warningRestore = await requestBuffer(server, 'POST', '/api/backup/import', exported.body);
    } finally {
      storage.writeCnhRateCache = oldWriteRate;
      console.error = oldConsoleError;
    }
    assert.strictEqual(warningRestore.status, 200);
    const warningPayload = JSON.parse(warningRestore.body.toString('utf8'));
    assert.strictEqual(warningPayload.success, true);
    assert.match(warningPayload.warnings[0], /账目已恢复.*汇率未更新/);
    assert.deepStrictEqual(storage.readDb().events, exportedDb.events);

    // Omitting CNH retains historical FX; explicit clearing uses current FX.
    response = await request(server, 'POST', '/api/settings', { cnhRate: 7.8 });
    assert.strictEqual(response.status, 200);
    const depositId = exportedDb.events[0].id;
    response = await request(server, 'PUT', `/api/event/${depositId}`, { amount: 200 });
    assert.strictEqual(response.status, 200);
    assert(Math.abs(response.body.data.cnhAmount - 1440) < 1e-8);
    for (const cnhAmount of [null, '']) {
      response = await request(server, 'PUT', `/api/event/${depositId}`, { cnhAmount });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.data.cnhAmount, 1560);
    }
    response = await request(server, 'PUT', `/api/event/${depositId}`, { cnhAmount: 0 });
    assert.strictEqual(response.status, 400, 'zero CNH remains invalid');
    for (const cnhAmount of [null, '']) {
      response = await request(server, 'POST', '/api/transaction', {
        member: 'me', type: 'deposit', amount: 10, cnhAmount, date: '2026-03-08'
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.data.cnhAmount, 78);
    }

    response = await request(server, 'GET', '/api/does-not-exist');
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.body.code, 'NOT_FOUND');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('HTTP API integration tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
