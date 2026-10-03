const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function element() {
  return {
    value: '', handlers: {}, innerHTML: '', textContent: '',
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setCustomValidity() {}, reportValidity() {}
  };
}
function load(file, document = {}) {
  const context = { window: {}, document };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
  return context.window;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settlementTests() {
  const names = ['btnReverseSettlement', 'settleGp', 'settleDate', 'settleRemark',
    'settlementPreviewModal', 'btnPreviewSettlement', 'settlementPreviewSubtitle',
    'settlementPreviewSummary', 'settlementPreviewBody', 'btnConfirmSettlement', 'formSettlement'];
  const elements = Object.fromEntries(names.map(name => [name, element()]));
  const requests = [], confirmations = [], errors = [];
  let opened = 0;
  load('settlement-controller.js').FundSettlementController.init({
    elements,
    api: {
      previewSettlement(payload) {
        const request = deferred(); requests.push({ ...request, payload }); return request.promise;
      },
      async confirmSettlement(payload) { confirmations.push(payload); }
    },
    modal: { open() { opened++; }, close() {} },
    submission: { runOnce: async (_form, fn) => fn() }, getMembers: () => [],
    loadAllData: async () => {}, showToast: message => errors.push(message),
    showSubmissionSuccess() {}, escapeHtml: value => value, formatMoney: value => value.toFixed(2)
  });
  elements.settleGp.value = 'gp';
  const preview = fee => ({ event: { annualRate: .06, feeRate: .25 }, breakdown: [],
    valuationDate: '2026-03-02', navPerShare: 1.2, totalFee: fee });
  const start = date => {
    elements.settleDate.value = date;
    elements.settleDate.handlers.input();
    return elements.btnPreviewSettlement.handlers.click();
  };
  const first = start('2026-03-03');
  await elements.btnConfirmSettlement.handlers.click();
  assert.strictEqual(confirmations.length, 0, 'an unresolved preview must not be confirmable');
  const second = start('2026-03-04');
  requests[1].resolve(preview(20)); await second;
  requests[0].resolve(preview(10)); await first;
  assert(elements.settlementPreviewSummary.innerHTML.includes('$20.00'));
  assert(elements.settlementPreviewSubtitle.textContent.includes('2026-03-04'));
  assert.strictEqual(opened, 1, 'stale success must not reopen the modal');
  await elements.btnConfirmSettlement.handlers.click();
  assert.strictEqual(confirmations[0].date, '2026-03-04');

  const invalidated = start('2026-03-05');
  elements.settleRemark.value = 'changed'; elements.settleRemark.handlers.input();
  requests[2].resolve(preview(30)); await invalidated;
  await elements.btnConfirmSettlement.handlers.click();
  assert.strictEqual(confirmations.length, 1, 'input changes must invalidate in-flight previews');
  assert.strictEqual(opened, 1);

  const staleFailure = start('2026-03-06');
  const current = start('2026-03-07');
  requests[4].resolve(preview(40)); await current;
  requests[3].reject(new Error('stale failure')); await staleFailure;
  assert.strictEqual(errors.length, 0, 'stale failure must not clear a newer successful preview');
  await elements.btnConfirmSettlement.handlers.click();
  assert.strictEqual(confirmations[1].date, '2026-03-07');
}

async function transactionTests() {
  const names = ['txDate', 'tfDate', 'valDate', 'editDate', 'editEventType', 'tfAmount', 'tfRate',
    'tfCnhDisplay', 'inputCnhRate', 'formTransfer', 'tfFromMember', 'tfToMember', 'tfRemark',
    'editAmount', 'editCnhAmount', 'formEditEvent', 'editEventId', 'editRemark', 'editMember',
    'editFromMember', 'editToMember', 'editCnhRate', 'editEventModal', 'formTransaction',
    'elTxMember', 'txAmount', 'txCnhAmount', 'txRemark', 'formValuation', 'valTotalNav', 'valRemark'];
  const elements = Object.fromEntries(names.map(name => [name, element()]));
  const edits = [], additions = [];
  const window = load('transaction-controller.js', {
    getElementById: () => null, querySelector: () => ({ value: 'deposit' })
  });
  const controller = window.FundTransactionController.init({
    elements, api: {
      async updateEvent(_id, payload) { edits.push(payload); },
      async addTransaction(payload) { additions.push(payload); }
    }, submission: { runOnce: async (_form, fn) => fn() }, resetDefaultDates() {},
    loadAllData: async () => {}, showToast() {}, showSubmissionSuccess() {}, closeModal() {},
    getLatestValuationDate: () => '2026-09-29', formatMoney: value => value.toFixed(2)
  });
  elements.editEventType.value = 'deposit'; elements.editDate.value = '2026-03-01';
  elements.editMember.value = 'lp'; elements.inputCnhRate.value = '7.8';
  controller.prepareEdit({ amount: 100, cnhAmount: 700 });
  elements.editAmount.value = '200'; elements.editAmount.handlers.input();
  assert.strictEqual(elements.editCnhAmount.value, '1400.00');
  await elements.formEditEvent.handlers.submit({ preventDefault() {} });
  assert.strictEqual(edits[0].cnhAmount, 1400);
  elements.editCnhAmount.value = '1500'; elements.editCnhAmount.handlers.input();
  elements.editAmount.value = '300'; elements.editAmount.handlers.input();
  assert.strictEqual(elements.editCnhAmount.value, '1500', 'manual CNH must survive later USD edits');
  elements.editCnhAmount.value = ''; elements.editCnhAmount.handlers.input();
  elements.editAmount.value = '400'; elements.editAmount.handlers.input();
  await elements.formEditEvent.handlers.submit({ preventDefault() {} });
  assert.strictEqual(edits[1].cnhAmount, null, 'clearing explicitly requests current-rate conversion');
  controller.prepareEdit({ amount: 100, cnhAmount: 650 });
  elements.editAmount.value = '200'; elements.editAmount.handlers.input();
  assert.strictEqual(elements.editCnhAmount.value, '1300.00', 'reopening must reset manual state and historical rate');

  elements.txDate.value = '2026-03-01'; elements.elTxMember.value = 'lp';
  elements.txAmount.value = '100'; elements.formTransaction.reset = () => {};
  await elements.formTransaction.handlers.submit({ preventDefault() {} });
  assert.strictEqual(additions[0].cnhAmount, undefined, 'blank new CNH must omit the amount');
}

async function restoreWarningTest() {
  const names = ['memberModal', 'backupModal', 'formAddMember', 'newMemberName',
    'btnTriggerUpload', 'fileImport', 'fileNameLabel', 'btnConfirmImport'];
  const elements = Object.fromEntries(names.map(name => [name, element()]));
  elements.fileImport.files = [{}];
  elements.btnConfirmImport.setAttribute = () => {};
  elements.btnConfirmImport.removeAttribute = () => {};
  const notices = [];
  load('management-controller.js').FundManagementController.init({ elements,
    api: { importBackup: async () => ({ message: '账目已恢复，但汇率未更新', warnings: ['rate'] }) },
    modal: { close() {} }, loadAllData: async () => {},
    showToast: (...args) => notices.push(args)
  });
  await elements.btnConfirmImport.handlers.click();
  assert.deepStrictEqual(notices[0], ['账目已恢复，但汇率未更新', 'warning']);
}

async function deleteUndoTests() {
  const appSource = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const handlerSource = appSource.slice(appSource.indexOf('  function handleDeleteEvent('),
    appSource.indexOf('  // 弹出编辑账目模态框'));
  const create = () => {
    const undoButton = element(), row = { style: {}, querySelectorAll: () => [{ _deleteEventId: 'd' }] };
    const timer = {}, notices = [], deletion = deferred();
    let deletes = 0;
    const context = {
      ledgerTbody: { querySelectorAll: () => [row] },
      document: { createElement: () => ({ style: {} }), getElementById: id =>
        id === 'toast-container' ? { appendChild() {} } : undoButton },
      setTimeout(fn) { timer.fn = fn; return timer; }, clearTimeout() { timer.cleared = true; },
      Api: { deleteEvent() { deletes++; return deletion.promise; } },
      formatMoney: value => value.toFixed(2), dismissToast() {},
      showToast: message => notices.push(message), loadAllData() {}
    };
    vm.runInNewContext(handlerSource, context);
    context.handleDeleteEvent('d', 'LP', 'deposit', 100);
    return { undoButton, row, timer, notices, deletion, getDeletes: () => deletes };
  };
  const cancelled = create();
  cancelled.undoButton.handlers.click();
  cancelled.undoButton.handlers.click();
  cancelled.timer.fn();
  assert.strictEqual(cancelled.getDeletes(), 0);
  assert.strictEqual(cancelled.timer.cleared, true);
  assert.strictEqual(cancelled.row.style.opacity, '1');
  assert.strictEqual(cancelled.notices.length, 1, 'repeated undo must have no effect');

  const started = create();
  started.timer.fn();
  assert.strictEqual(started.getDeletes(), 1);
  assert.strictEqual(started.undoButton.disabled, true);
  // Invoke the handler directly to model a late queued click as well as the
  // browser's disabled-button protection.
  started.undoButton.handlers.click();
  assert.strictEqual(started.notices.length, 0, 'late undo must not claim deletion was cancelled');
  assert.strictEqual(started.row.style.opacity, '0.2');
  started.deletion.reject(new Error('write failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(started.row.style.opacity, '1');
  assert.match(started.notices[0], /删除失败/);
}

function navigationScrollTest() {
  const listeners = {}, frames = [];
  let writes = 0, geometryReads = 0;
  const navigation = { style: { setProperty() { writes++; } } };
  const sections = ['dashboard-home', 'trends-section'].map((id, index) => ({
    id, getBoundingClientRect: () => ({ top: index * 600 - window.scrollY })
  }));
  const links = sections.map((section, index) => ({
    hash: `#${section.id}`,
    get offsetTop() { geometryReads++; return index * 50; },
    get offsetHeight() { geometryReads++; return 44; },
    closest: () => navigation,
    classList: { toggle() { writes++; } },
    setAttribute() { writes++; }, removeAttribute() { writes++; },
    addEventListener() {}
  }));
  const window = {
    scrollY: 0, innerHeight: 1000,
    addEventListener(type, handler) { listeners[type] = handler; }
  };
  const context = { window, document: {
    querySelectorAll: () => links,
    querySelector: hash => sections.find(section => `#${section.id}` === hash)
  }, requestAnimationFrame: callback => { frames.push(callback); return frames.length; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/navigation.js'), 'utf8'), context);
  window.FundNavigation.init();
  const initialWrites = writes, initialReads = geometryReads;
  for (let i = 0; i < 20; i++) {
    window.scrollY = 100 + i;
    listeners.scroll(); frames.shift()();
  }
  assert.strictEqual(writes, initialWrites, 'scrolling within one section must not rewrite navigation');
  assert.strictEqual(geometryReads, initialReads, 'unchanged selection must not read link layout');
  window.scrollY = 650;
  listeners.scroll(); frames.shift()();
  assert(writes > initialWrites, 'crossing a section must update selection');
  const selectedWrites = writes;
  listeners.resize();
  assert(writes > selectedWrites, 'resize must refresh indicator geometry even for the same section');
}

(async () => {
  navigationScrollTest();
  await settlementTests(); await transactionTests(); await restoreWarningTest(); await deleteUndoTests();
  console.log('Settlement race, historical FX and restore warning controller regressions passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
