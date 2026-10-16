const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function element() {
  return { value: '', handlers: {}, children: [], style: {}, parentElement: { classList: { toggle() {} } },
    addEventListener(type, fn) { this.handlers[type] = fn; }, replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
    querySelector(selector) { return (this.nodes ||= {})[selector] ||= element(); },
    querySelectorAll(selector) { return selector === '.custom-benchmark-component-row' ? this.children : this.children.map(child => child.querySelector(selector)); } };
}
async function benchmarkRace() {
  const names = ['btnConfigCustomBenchmark', 'btnConfigCustomBenchmark2', 'customBenchmarkModal', 'btnCloseCustomBenchmarkModal', 'customBenchmarkModalTitle', 'customBenchmarkName', 'customBenchmarkComponents', 'customBenchmarkTotal', 'btnAddCustomBenchmarkRow', 'btnSaveCustomBenchmark', 'btnRemoveCustomBenchmark'];
  const elements = Object.fromEntries(names.map(name => [name, element()]));
  const requests = [], writes = [], opened = [];
  const context = { window: {}, document: { createElement: element }, clearTimeout() {}, setTimeout() {}, confirm: () => true };
  vm.runInNewContext(read('custom-benchmark-controller.js'), context);
  const saving = deferred();
  context.window.FundCustomBenchmark.init({ elements,
    api: { getCustomBenchmark(slot) { const request = deferred(); requests.push({ slot, ...request }); return request.promise; }, saveCustomBenchmark(config, slot) { writes.push({ config, slot }); return saving.promise; } },
    modal: { bindAccessible() {}, open(_modal, trigger) { opened.push(trigger); }, close() {} },
    loadAllData: async () => ({ settings: { customBenchmark2CacheReady: true } }), showToast() {} });
  const first = elements.btnConfigCustomBenchmark.handlers.click({ currentTarget: 'first' });
  const second = elements.btnConfigCustomBenchmark2.handlers.click({ currentTarget: 'second' });
  requests[1].resolve({ components: [{ ticker: 'QQQM', weight: 100 }] }); await second;
  requests[0].resolve({ components: [{ ticker: 'VOO', weight: 100 }] }); await first;
  assert.deepStrictEqual(opened, ['second']); assert.strictEqual(elements.customBenchmarkName.value, 'QQQM');
  const save = elements.btnSaveCustomBenchmark.handlers.click();
  await elements.btnSaveCustomBenchmark.handlers.click(); await elements.btnRemoveCustomBenchmark.handlers.click();
  await elements.btnConfigCustomBenchmark.handlers.click({ currentTarget: 'first' });
  assert.strictEqual(writes.length, 1); assert.strictEqual(writes[0].slot, 1);
  saving.resolve(); await save; assert.strictEqual(elements.btnSaveCustomBenchmark.disabled, false);
}
async function dataRace() {
  const members = [], states = [], errors = [], rendered = []; const noop = () => {};
  const context = { window: { FundMemberRenderer: { sortByFirstRecord: list => list }, FundCustomBenchmark: { sync: noop } },
    Api: { getMembers() { const request = deferred(); members.push(request); return request.promise; }, getState() { const request = deferred(); states.push(request); return request.promise; } },
    disposalTrial: { invalidate: noop }, settingsController: { syncBenchmarkPolicy: noop }, populateDynamicSelectors: noop,
    renderDashboard() { rendered.push(context.appState.tag); }, renderMembersGrid: noop, memberStatement: { sync: noop }, renderLedger: noop, renderCharts: noop,
    onboardingController: { showIfEmpty: () => true }, showToast: text => errors.push(text), dataLoadSequence: 0, membersList: [], appState: null };
  const source = read('app.js'), begin = source.indexOf('  async function loadAllData()'), end = source.indexOf('  // 动态构建', begin);
  vm.runInNewContext(source.slice(begin, end), context);
  const first = context.loadAllData(), second = context.loadAllData();
  members[1].resolve([]); states[1].resolve({ tag: 'new', events: [] }); await second;
  members[0].resolve([]); states[0].resolve({ tag: 'old', events: [] }); await first;
  assert.strictEqual(context.appState.tag, 'new'); assert.deepStrictEqual(rendered, ['new']);
  const third = context.loadAllData(), fourth = context.loadAllData();
  members[3].resolve([]); states[3].resolve({ tag: 'latest', events: [] }); await fourth;
  members[2].reject(new Error('stale failure')); states[2].resolve({}); await third; assert.strictEqual(errors.length, 0);
}
async function deletionBarrier() {
  const deletion = deferred(), fetched = [];
  const context = { window: { FundLedgerActions: { flushPending: () => deletion.promise } }, AbortController, URL, setTimeout, clearTimeout,
    fetch: async (url, options) => { fetched.push({ url, options }); return { ok: true, json: async () => ({ success: true }) }; } };
  vm.runInNewContext(read('api.js'), context);
  const write = context.requestApi('/api/transaction', { method: 'POST' }); assert.strictEqual(fetched.length, 0);
  await context.requestApi('/api/event/test', { method: 'DELETE' }); assert.strictEqual(fetched.length, 1);
  const removeMember = context.requestApi('/api/members/test', { method: 'DELETE' }); assert.strictEqual(fetched.length, 1);
  deletion.resolve(); await write; await removeMember; assert.strictEqual(fetched.length, 3);
}
(async () => { await benchmarkRace(); await dataRace(); await deletionBarrier(); console.log('Review frontend races and deletion ordering passed.'); })().catch(error => { console.error(error); process.exitCode = 1; });
