const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/settings-controller.js'), 'utf8');
const storage = new Map();
const sessionStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key)
};

function load(ledger, { demo = false, store = sessionStorage } = {}) {
  const classes = new Set();
  let finishes = 0;
  const buttons = Array.from({ length: 5 }, () => ({
    attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(_type, handler) { this.click = handler; }
  }));
  const window = { FundCountUp: { finishAll() { finishes++; } }, sessionStorage: store, FundDemoMode: { enabled: demo }, FundLedger: { id: ledger } };
  const document = { body: { classList: {
    toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }
  } } };
  vm.runInNewContext(source, { window, document });
  window.FundSettingsController.create({
    elements: { benchmarkPolicyButtons: [], privacyButtons: buttons }, showToast() {}
  }).init();
  return {
    buttons, finishCount: () => finishes,
    assertPrivacy(active) {
      assert.strictEqual(classes.has('privacy-mode-active'), active);
      buttons.forEach(button => assert.strictEqual(button.attributes['aria-pressed'], String(active)));
    }
  };
}

const first = load('default');
first.assertPrivacy(true);
assert.equal(first.finishCount(), 1, 'Private initialization must finish pending CountUp animations');
first.buttons[0].click();
first.assertPrivacy(false);
const second = load('ledger-2');
second.assertPrivacy(true);
assert.equal(second.finishCount(), 1);
second.buttons[3].click();
second.assertPrivacy(false);
load('ledger-2').assertPrivacy(true);
function transfer(ledgerId, privacyMode) {
  sessionStorage.setItem('family_fund_ledger_privacy_transfer', JSON.stringify({ ledgerId, privacyMode }));
}
transfer('ledger-2', false);
load('ledger-2').assertPrivacy(false);
assert.strictEqual(storage.has('family_fund_ledger_privacy_transfer'), false);
load('ledger-2').assertPrivacy(true);
transfer('default', true);
load('default').assertPrivacy(true);
transfer('ledger-3', false);
load('default').assertPrivacy(true);
load('ledger-3').assertPrivacy(true);
second.buttons[3].click();
second.assertPrivacy(true);
assert.equal(second.finishCount(), 2, 'Enabling privacy must finish animations immediately');
load('default').assertPrivacy(true);
load('ledger-3').assertPrivacy(true);
const demo = load('demo', { demo: true });
demo.assertPrivacy(false);
demo.buttons[1].click();
demo.buttons[1].click();
load('default').assertPrivacy(true);
storage.set('family_fund_privacy_mode', 'false');
load('default').assertPrivacy(true);
storage.set('family_fund_ledger_privacy_transfer', 'invalid');
load('default').assertPrivacy(true);
const restricted = load('default', { store: {
  getItem() { throw new Error('storage blocked'); },
  setItem() { throw new Error('storage blocked'); }
} });
restricted.assertPrivacy(true);
restricted.buttons[4].click();
restricted.assertPrivacy(false);
console.log('Ledger privacy transfer is consumed once; refresh restores privacy, button sync, demo and storage fallback passed.');
