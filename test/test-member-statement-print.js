const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const classes = () => {
  const values = new Set();
  return { add: name => values.add(name), remove: name => values.delete(name), contains: name => values.has(name) };
};
for (const [width, height, initiallyOpen] of [[681, 750, false], [681, 2400, true], [1100, 800, false]]) {
  const listeners = {};
  let measured = 0, removed = 0;
  const properties = new Map();
  const method = { open: initiallyOpen };
  const elements = Object.fromEntries(['member-statement-modal', 'btn-member-statement', 'statement-member', 'statement-period', 'statement-content', 'btn-print-statement', 'statement-status'].map(id => [id, {
    value: id === 'statement-period' ? 'current' : 'member', classList: classes(),
    addEventListener(type, fn) { this[type] = fn; },
    style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) }
  }]));
  elements['statement-content'].querySelector = () => method;
  elements['statement-content'].cloneNode = () => {
    assert.equal(method.open, true, 'Print measurement must include expanded calculation notes');
    return {
    removeAttribute() {}, setAttribute() {}, classList: classes(), scrollWidth: width,
    getBoundingClientRect: () => ({ height }), remove: () => removed++
    };
  };
  const document = { title: 'Original title', getElementById: id => elements[id],
    body: { classList: classes(), appendChild: () => measured++ } };
  const report = { name: 'Member', start: '2025-01-01', end: '2026-01-01', months: [], rows: [],
    opening: 0, closing: 0, closingShares: 0, feesPaid: 0, feesReceived: 0, investmentProfit: 0,
    deposits: 0, withdrawals: 0, transfersIn: 0, transfersOut: 0, change: 0, openingNAV: 1, closingNAV: 1, navReturn: 0 };
  const window = { addEventListener: (type, fn) => listeners[type] = fn,
    FundMemberStatement: { build: () => report },
    print() {
      assert.equal(method.open, true);
      const initialScale = Number(properties.get('--statement-print-scale'));
      assert(initialScale > 0 && initialScale <= 1);
      assert(width * initialScale <= 180 * 96 / 25.4 + 0.001);
      assert(height * initialScale <= 265 * 96 / 25.4 + 0.001);
      listeners.beforeprint();
      assert.equal(Number(properties.get('--statement-print-scale')), initialScale);
      listeners.afterprint();
    }
  };
  vm.runInNewContext(fs.readFileSync('public/js/member-statement-controller.js', 'utf8'), { window, document, Intl, Date });
  window.FundMemberStatementController.create({ getState: () => ({}), getMembers: () => [],
    modal: { bindAccessible() {} }, ui: { escapeHtml: value => value || '', formatMoney: value => String(value) }, showToast: message => assert.fail(message) });
  elements['statement-period'].change();
  elements['btn-print-statement'].click();
  assert.equal(measured, 2);
  assert.equal(removed, 2);
  assert(!document.body.classList.contains('printing-member-statement'));
  assert(!properties.has('--statement-print-scale'));
  assert.equal(document.title, 'Original title');
  assert.equal(method.open, initiallyOpen, 'Restore the previous calculation notes state');
}
console.log('Single-page print sizing, repeated beforeprint and cleanup assertions passed.');
