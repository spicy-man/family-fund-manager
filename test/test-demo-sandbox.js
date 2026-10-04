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
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-sandbox-test-'));
const clone = value => JSON.parse(JSON.stringify(value));
function storage() { const map = new Map(); return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; }
function openTab(store) {
  const seed = JSON.parse(fs.readFileSync(path.join(output, 'demo-data/seed.json'), 'utf8'));
  const context = vm.createContext({ window: { location: { href: 'https://example.org/project/' }, sessionStorage: store },
    document: { querySelector: () => ({}) }, fetch: async () => ({ ok: true, json: async () => clone(seed) }),
    crypto: webcrypto, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, setTimeout, clearTimeout, console });
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
    assert.deepStrictEqual(clone((await get('/api/members')).data.map(member => member.name)), ['John Titor', 'Alice Liddell', 'Sherlock Holmes']);
    const sunday = '2026-08-23'; const friday = '2026-08-28';
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
    const reloaded = await openTab(store);
    assert.strictEqual((await reloaded.request('/api/members')).data.find(item => item.id === member.id).name, 'Miku');
    const isolated = await openTab(storage());
    assert.strictEqual((await isolated.request('/api/members')).data.length, 3);
    sandbox.reset();
    const reset = await openTab(store);
    assert.strictEqual((await reset.request('/api/members')).data.length, 3);
    assert.strictEqual((await reset.request('/api/state')).data.summary.totalNAV, initial.summary.totalNAV);
    console.log('Browser bundle: deposits, withdrawals, transfers, editing, settlement tokens, locks, reversal, ZIP restore, reload, isolation and reset passed.');
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
