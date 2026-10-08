const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const { Buffer } = require('buffer');
const { buildStaticDemo } = require('../scripts/build-static-demo');
const { calculateStateFromDb } = require('../lib/calculator');
const { buildDemoLedger } = require('../demo/build-ledger');
const weeklyMarket = require('../demo/weekly-market.json');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-sandbox-test-'));
const clone = value => JSON.parse(JSON.stringify(value));
function storage() { const map = new Map(); return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; }
function openTab(store) {
  const seed = JSON.parse(fs.readFileSync(path.join(output, 'demo-data/seed.json'), 'utf8'));
  // Keep the mutation scenario one week beyond the seed, independent of the
  // wall clock and the application's future-valuation guard.
  const scenarioNow = Date.parse(weeklyMarket.endDate) + 8 * 86400000 + 12 * 3600000;
  class ScenarioDate extends Date {
    constructor(...args) { super(...(args.length ? args : [scenarioNow])); }
    static now() { return scenarioNow; }
  }
  const context = vm.createContext({ window: { location: { href: 'https://example.org/project/' }, sessionStorage: store },
    document: { querySelector: () => ({}) }, fetch: async () => ({ ok: true, json: async () => clone(seed) }),
    crypto: webcrypto, URL, Date: ScenarioDate, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, console });
  vm.runInContext(fs.readFileSync(path.join(output, 'js/demo-sandbox.js'), 'utf8'), context);
  return context.window.FundDemoSandbox.ready;
}
(async () => {
  try {
    buildStaticDemo(output);
    const store = storage(); const sandbox = await openTab(store);
    const get = url => sandbox.request(url);
    const post = (url, body) => sandbox.request(url, { method: 'POST', body: JSON.stringify(body) });
    const mutate = (method, url, body) => sandbox.request(url, { method, body: JSON.stringify(body) });
    const initial = (await get('/api/state')).data;
    assert.deepStrictEqual(clone(initial.summary), clone(calculateStateFromDb(buildDemoLedger()).summary));
    assert.deepStrictEqual(clone(initial.settings.customBenchmark), { name: 'VGT', components: [{ ticker: 'VGT', weight: 100 }] });
    assert.deepStrictEqual(clone(initial.settings.customBenchmark2), { name: 'BRK-B', components: [{ ticker: 'BRK-B', weight: 100 }] });
    assert.strictEqual(initial.settings.customBenchmarkCacheReady, true);
    assert.strictEqual(initial.settings.customBenchmark2CacheReady, true);
    assert.deepStrictEqual(clone((await get('/api/members')).data.map(member => member.name)), ['John Titor', 'Alice Liddell', 'Giovanni Giorgio']);
    const afterCutoff = days => new Date(Date.parse(weeklyMarket.endDate) + days * 86400000).toISOString().slice(0, 10);
    const sunday = afterCutoff(2); const friday = afterCutoff(7);
    const tracked = (await get('/api/ticker-ath')).data;
    assert.strictEqual(Object.keys(tracked).length, Object.keys(weeklyMarket.tickers).length);
    assert(Object.values(tracked).every(quote => quote.regularCloseDate === weeklyMarket.endDate));
    const member = (await post('/api/members', { name: 'Hatsune Miku' })).data;
    await mutate('PUT', '/api/members/' + member.id, { name: 'Miku Hatsune' });
    const deposit = (await post('/api/transaction', { member: member.id, type: 'deposit', amount: 2000, cnhAmount: 14000, date: sunday })).data;
    assert((await get('/api/state')).data.events.some(event => event.id === deposit.id));
    const beforeFailure = JSON.stringify((await get('/api/state')).data);
    await assert.rejects(post('/api/transaction', { member: member.id, type: 'withdraw', amount: 999999, date: sunday }), /余额不足/);
    assert.strictEqual(JSON.stringify((await get('/api/state')).data), beforeFailure);
    await post('/api/transaction', { member: member.id, type: 'withdraw', amount: 100, date: sunday });
    await post('/api/transfer', { fromMember: member.id, toMember: 'lin', amount: 100, cnhRate: 7, date: sunday });
    const valuation = (await post('/api/valuation', { totalNAV: 300000, date: friday, remark: 'sandbox valuation' })).data;
    await mutate('PUT', '/api/event/' + valuation.id, { totalNAV: 310000, date: friday, remark: 'updated valuation' });
    const previewBody = { date: friday, remark: 'sandbox settlement', gpMember: 'alex' };
    let preview = (await post('/api/performance-settlement/preview', previewBody)).data;
    await mutate('PUT', '/api/members/' + member.id, { name: 'Miku' });
    await assert.rejects(post('/api/performance-settlement', { ...previewBody, previewToken: preview.previewToken }), /预览已失效/);
    preview = (await post('/api/performance-settlement/preview', previewBody)).data;
    const settlement = (await post('/api/performance-settlement', { ...previewBody, previewToken: preview.previewToken })).data;
    await assert.rejects(mutate('DELETE', '/api/event/' + valuation.id), /锁定/);
    await post('/api/performance-settlement/reverse-latest', { settlementId: settlement.id });
    await post('/api/performance-settlement/reverse-latest', { settlementId: settlement.id });
    await mutate('DELETE', '/api/event/' + valuation.id);
    await post('/api/settings', { cnhRate: 7.1 });
    assert.strictEqual((await get('/api/state')).data.summary.cnhRate, 7.1);
    await post('/api/settings/custom-benchmark', { slot: 1, customBenchmark: { name: 'AAPL sandbox', components: [{ ticker: 'AAPL', weight: 100 }] } });
    assert.strictEqual((await get('/api/state')).data.settings.customBenchmark2.components[0].ticker, 'AAPL');
    await post('/api/settings/custom-benchmark', { slot: 1, customBenchmark: { name: 'Blue chips sandbox', components: [
      { ticker: 'VOO', weight: 50 }, { ticker: 'BRK-B', weight: 50 }
    ] } });
    const blueChipState = (await get('/api/state')).data;
    assert.strictEqual(blueChipState.settings.customBenchmark2CacheReady, true);
    assert.strictEqual(blueChipState.settings.customBenchmark2.components[1].ticker, 'BRK-B');
    await assert.rejects(post('/api/settings/tickers', { tickers: [{ ticker: 'UNKNOWN' }] }), /离线行情支持/);
    await post('/api/settings/tickers', { tickers: [{ ticker: 'AAPL' }] });
    const quotes = await post('/api/ticker-ath/refresh', {});
    assert(quotes.refreshSuccess);
    const backup = await sandbox.exportBackup();
    assert(Buffer.from(backup.binary).subarray(0, 2).equals(Buffer.from('PK')));
    const AdmZip = require('adm-zip');
    const nativeZip = new AdmZip(Buffer.from(backup.binary));
    assert(nativeZip.getEntry('data/db.json'));
    const repacked = new AdmZip();
    for (const entry of nativeZip.getEntries()) repacked.addFile(entry.entryName, entry.getData());
    const nativeBackup = repacked.toBuffer();
    await sandbox.request('/api/backup/import', { method: 'POST', body: {
      size: nativeBackup.length, arrayBuffer: async () => Uint8Array.from(nativeBackup).buffer
    } });
    const backupBody = { size: backup.binary.length, arrayBuffer: async () => Uint8Array.from(backup.binary).buffer };
    const beforeBackup = clone((await get('/api/state')).data);
    await mutate('PUT', '/api/members/' + member.id, { name: 'Temporary name' });
    await sandbox.request('/api/backup/import', { method: 'POST', body: backupBody });
    const restored = (await get('/api/state')).data;
    assert.strictEqual((await get('/api/members')).data.find(item => item.id === member.id).name, 'Miku');
    assert.strictEqual(restored.summary.totalNAV, beforeBackup.summary.totalNAV);
    await assert.rejects(sandbox.request('/api/backup/import', { method: 'POST', body: { size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } }), /ZIP/);
    assert.strictEqual((await get('/api/state')).data.summary.totalNAV, restored.summary.totalNAV);
    const firstLedgerState = clone((await get('/api/state')).data);
    const second = (await post('/api/ledgers', { name: '第二账本' })).data;
    assert.strictEqual(second.id, 'ledger-2');
    const selected = (url, method = 'GET', body) => sandbox.request(url, {
      method, headers: { 'X-Ledger-Id': second.id }, body: body && JSON.stringify(body)
    });
    assert.strictEqual((await selected('/api/state')).data.events.length, 0);
    const secondMembers = (await selected('/api/members')).data;
    assert(secondMembers.every(item => /^[1-9][0-9]{5}$/.test(item.id)));
    // Align one member identifier to demonstrate aggregation by identity.
    await selected('/api/members/' + secondMembers[0].id, 'PUT', { name: 'Miku', memberId: member.id });
    await selected('/api/transaction', 'POST', { member: member.id, type: 'deposit', amount: 1000, cnhAmount: 7000, date: sunday });
    assert.strictEqual((await selected('/api/state')).data.summary.totalNAV, 1000);
    assert.deepStrictEqual(clone((await get('/api/state')).data), firstLedgerState);
    await mutate('PATCH', '/api/ledgers/' + second.id, { name: '第二账本已改名' });
    await mutate('PATCH', '/api/ledgers/default', { name: '第一账本' });
    await assert.rejects(post('/api/ledgers', { name: ' ' }), /账本名称/);
    await assert.rejects(selected('/api/state?ledger=default'), /选择不一致/);
    await assert.rejects(get('/api/state?ledger=missing'), /不存在/);
    const combined = (await get('/api/ledgers/combined')).data;
    assert.strictEqual(combined.ledgers.length, 2);
    assert.strictEqual(combined.summary.totalNAV, firstLedgerState.summary.totalNAV + 1000);
    assert.strictEqual(combined.members.find(item => item.id === member.id).breakdown.length, 2);
    // Shared benchmarks must stay ready for both ledgers after either one changes them.
    await selected('/api/settings/custom-benchmark', 'POST', { slot: 1, customBenchmark: { components: [{ ticker: 'AAPL', weight: 100 }] } });
    assert.strictEqual((await get('/api/state')).data.settings.customBenchmark2CacheReady, true);
    assert.strictEqual((await get('/api/state')).data.settings.customBenchmark2.components[0].ticker, 'AAPL');
    const secondBackup = await sandbox.exportBackup(second.id);
    const secondZip = new AdmZip(Buffer.from(secondBackup.binary));
    assert.strictEqual(JSON.parse(secondZip.getEntry('data/db.json').getData()).events.length, 1);
    // Restoring into an additional ledger leaves the default ledger and shared settings intact.
    await sandbox.request('/api/backup/import', { method: 'POST', headers: { 'X-Ledger-Id': second.id }, body: backupBody });
    assert.strictEqual((await selected('/api/state')).data.summary.totalNAV, beforeBackup.summary.totalNAV);
    assert.strictEqual((await get('/api/state')).data.summary.totalNAV, firstLedgerState.summary.totalNAV);
    assert.strictEqual((await get('/api/state')).data.settings.customBenchmark2.components[0].ticker, 'AAPL');
    const reloaded = await openTab(store);
    assert.strictEqual((await reloaded.request('/api/ledgers')).data[1].name, '第二账本已改名');
    assert.strictEqual((await reloaded.request('/api/state?ledger=ledger-2')).data.summary.totalNAV, beforeBackup.summary.totalNAV);
    assert.strictEqual((await reloaded.request('/api/members')).data.find(item => item.id === member.id).name, 'Miku');
    const isolated = await openTab(storage());
    assert.strictEqual((await isolated.request('/api/members')).data.length, 3);
    sandbox.reset();
    const reset = await openTab(store);
    assert.strictEqual((await reset.request('/api/ledgers')).data.length, 1);
    assert.strictEqual((await reset.request('/api/members')).data.length, 3);
    assert.strictEqual((await reset.request('/api/state')).data.summary.totalNAV, initial.summary.totalNAV);
    console.log('Browser bundle: deposits, withdrawals, transfers, editing, settlement tokens, locks, reversal, ZIP restore, reload, isolation and reset passed.');
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
