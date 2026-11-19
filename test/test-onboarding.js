const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeButton() {
  return {
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; }
  };
}

const onboardingModal = { dataset: { modalPersistent: 'true' }, classList: { contains: () => false } };
const btnStartLedger = fakeButton();
const calls = [];
const context = {
  window: {
    requestAnimationFrame(callback) { callback(); }
  }
};
vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'onboarding-controller.js'), 'utf8');
vm.runInContext(source, context);

const controller = context.window.FundOnboarding.init({
  elements: { onboardingModal, btnStartLedger },
  modal: {
    bindAccessible(modal) { calls.push(['bind', modal]); },
    open(modal) { calls.push(['open', modal]); },
    close(modal) { calls.push(['close', modal]); }
  },
  management: { openMembersPanel() { calls.push(['members']); } },
  isDemoMode: false
});

assert.strictEqual(controller.showIfEmpty({ events: [] }), true);
assert.deepStrictEqual(calls.slice(0, 2), [['bind', onboardingModal], ['open', onboardingModal]]);
assert.strictEqual(controller.showIfEmpty({ events: [{ id: 'deposit' }] }), false);

btnStartLedger.listeners.click();
assert.deepStrictEqual(calls.slice(-2), [['close', onboardingModal], ['members']]);
assert.strictEqual(controller.showIfEmpty({ events: [] }), false, 'start choice must dismiss onboarding for this session');

const demoController = context.window.FundOnboarding.init({
  elements: { onboardingModal, btnStartLedger: fakeButton() },
  modal: { bindAccessible() {}, open() { throw new Error('demo must not open onboarding'); }, close() {} },
  management: { openMembersPanel() {} },
  isDemoMode: true
});
assert.strictEqual(demoController.showIfEmpty({ events: [] }), false);

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
assert(html.includes('id="onboarding-modal"'));
assert(html.includes('id="btn-view-demo" href="/demo"'));
assert(html.includes('id="btn-start-ledger"'));
assert(html.includes('data-modal-persistent="true"'));

const modalListeners = {};
const focusCalls = [];
let modalActive = true;
const firstFocusable = { offsetParent: {}, focus() { focusCalls.push('first'); } };
const lastFocusable = { offsetParent: {}, focus() { focusCalls.push('last'); } };
const persistentModal = {
  dataset: { modalPersistent: 'true' },
  classList: {
    contains(name) { return name === 'active' && modalActive; },
    add() { modalActive = true; },
    remove() { modalActive = false; }
  },
  addEventListener(type, listener) { modalListeners[type] = listener; },
  querySelectorAll() { return [firstFocusable, lastFocusable]; },
  querySelector() { return null; },
  setAttribute() {}
};
const inertClassList = { add() {}, remove() {} };
const modalContext = {
  window: {},
  document: {
    activeElement: lastFocusable,
    documentElement: { classList: inertClassList },
    body: { classList: inertClassList },
    querySelector() { return null; }
  },
  requestAnimationFrame(callback) { callback(); }
};
vm.createContext(modalContext);
const modalSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modal-manager.js'), 'utf8');
vm.runInContext(modalSource, modalContext);
modalContext.window.FundModal.bindAccessible(persistentModal);

modalListeners.click({ target: persistentModal });
assert.strictEqual(modalActive, true, 'persistent onboarding must ignore backdrop clicks');
modalListeners.keydown({ key: 'Escape', preventDefault() { throw new Error('persistent Escape must not be consumed'); } });
assert.strictEqual(modalActive, true, 'persistent onboarding must ignore Escape');
modalListeners.keydown({ key: 'Tab', shiftKey: false, preventDefault() {} });
assert.deepStrictEqual(focusCalls, ['first'], 'persistent onboarding must keep keyboard focus inside the dialog');

const dismissableListeners = {};
let dismissableActive = true;
const dismissableModal = {
  dataset: {},
  classList: {
    contains(name) { return name === 'active' && dismissableActive; },
    add() { dismissableActive = true; },
    remove() { dismissableActive = false; }
  },
  addEventListener(type, listener) { dismissableListeners[type] = listener; },
  querySelectorAll() { return [firstFocusable, lastFocusable]; },
  querySelector() { return null; },
  setAttribute() {}
};
modalContext.window.FundModal.bindAccessible(dismissableModal);
dismissableListeners.pointerdown({ target: firstFocusable });
dismissableListeners.click({ target: dismissableModal });
assert.strictEqual(dismissableActive, true, 'a text-selection drag starting inside the modal and releasing on the backdrop must not close it');
dismissableListeners.pointerdown({ target: dismissableModal });
dismissableListeners.click({ target: dismissableModal });
assert.strictEqual(dismissableActive, false, 'a genuine backdrop press and release must close the modal');

console.log('Empty-ledger onboarding assertions passed.');
