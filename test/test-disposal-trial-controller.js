const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
function harness(demo = null) {
  const elements = {};
  class Element {
    constructor(id) { this.id = id; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.handlers = {}; this.classList = { add() {}, remove() {} }; }
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
    dispatchEvent(event) {
      let result;
      for (const handler of this.handlers[event.type] || []) result = handler(event);
      if (event.bubbles && this.form) this.form.dispatchEvent(event);
      return result;
    }
    reportValidity() { return true; }
  }
  for (const prefix of ['tx', 'tf']) {
    const form = elements[prefix === 'tx' ? 'form-transaction' : 'form-transfer'] = new Element('form');
    for (const suffix of ['trial', 'trial-result', 'trial-apply', 'trial-partial', 'trial-full', 'trial-modal', 'trial-view', 'trial-close', 'trial-subtitle', 'trial-cancel', 'date', 'amount', 'member', 'cnh-amount', 'remark', 'from-member', 'to-member', 'rate']) {
      const el = elements[prefix + '-' + suffix] = new Element(prefix + '-' + suffix);
      el.form = form;
    }
    elements[prefix + '-date'].value = '2026-01-11';
    elements[prefix + '-amount'].value = '300';
  }
  elements['tx-member'].value = 'a';
  elements['tx-cnh-amount'].value = '2100';
  elements['tf-from-member'].value = 'a';
  elements['tf-to-member'].value = 'b';
  elements['tf-rate'].value = '7';
  elements['t-select-withdraw'] = new Element('withdraw');
  elements['t-select-withdraw'].checked = true;
  const window = { FundDemoMode: demo };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/disposal-trial-controller.js'), 'utf8'), {
    window, document: { getElementById: id => elements[id] }, Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  });
  const pending = [];
  const controller = window.FundDisposalTrial.init({ modal: { bindAccessible() {}, open(dialog) { dialog.open = true; }, close(dialog) { dialog.open = false; } }, api: { previewDisposal: input => new Promise((resolve, reject) => pending.push({ input, resolve, reject })) }, formatMoney: n => Number(n).toFixed(2) });
  return { elements, pending, controller };
}
const account = { currentValue: 1000, remainingPrincipal: 500, lpShares: 500, gpCarryShares: 0 };
const response = input => ({ input: { ...input, previewToken: 'token' }, date: input.date, valuationDate: '2026-01-09', nav: 2,
  actualAmount: 300, cnhAmount: 2100, performanceFee: 10, sharesDeducted: 155, sender: { before: account, after: account }, fullExit: false });
(async () => {
  const { elements: e, pending, controller } = harness();
  const first = e['tx-trial-partial'].dispatchEvent({ type: 'click' });
  assert.strictEqual(e['tx-trial-partial'].disabled, true);
  assert.strictEqual(e['tx-trial-modal'].open, false, 'wait for the complete preview before animating the dialog');
  e['tx-amount'].value = '400';
  e['form-transaction'].dispatchEvent({ type: 'input' });
  pending[0].resolve(response(pending[0].input));
  await first;
  assert.strictEqual(e['tx-trial-result'].hidden, true, 'late response must not restore an estimate for changed inputs');
  assert.strictEqual(e['tx-trial-modal'].open, false, 'stale results must not reopen the dialog');
  const second = e['tx-trial-partial'].dispatchEvent({ type: 'click' });
  pending[1].resolve(response(pending[1].input));
  await second;
  assert.strictEqual(e['tx-trial-result'].hidden, false);
  assert.strictEqual(e['tx-trial-modal'].open, true, 'show the populated preview with one entry animation');
  assert.strictEqual(controller.token('tx'), undefined, 'unapplied estimates must not be attached to a different registration');
  e['tx-trial-apply'].dispatchEvent({ type: 'click' });
  assert.strictEqual(controller.token('tx'), 'token');
  assert.strictEqual(e['tx-trial-result'].hidden, false, 'input event during apply must not lose the selected estimate');
  assert.strictEqual(e['tx-trial-modal'].open, false, 'applying must return to the registration form');
  assert.strictEqual(e['tx-trial-view'].hidden, false);
  assert(e['tx-trial-view'].innerHTML.includes('<span class="privacy-sensitive">'), 'mask the estimate amount without disabling its review button');
  e['tx-trial-view'].dispatchEvent({ type: 'click' });
  assert.strictEqual(e['tx-trial-modal'].open, true, 'selected estimate must remain reviewable');
  e['tx-date'].value = '2026-01-18';
  e['form-transaction'].dispatchEvent({ type: 'change' });
  assert.strictEqual(controller.token('tx'), undefined);
  assert.strictEqual(e['tx-trial-result'].hidden, true);
  const full = e['tf-trial-full'].dispatchEvent({ type: 'click' });
  assert.strictEqual(pending[2].input.fullExit, true);
  pending[2].reject(new Error('余额不足'));
  await full;
  assert.strictEqual(e['tf-trial-result'].textContent, '余额不足');
  assert.strictEqual(e['tf-trial-modal'].open, true, 'failed requests must still show the error dialog');
  assert.strictEqual(e['tf-trial-apply'].hidden, true);
  assert.strictEqual(e['tf-trial-full'].disabled, false);
  controller.invalidate();
  assert.strictEqual(e['tf-trial-result'].hidden, true);
  const readonly = harness({ enabled: true, sandbox: false });
  assert.strictEqual(readonly.pending.length, 0);
  assert.strictEqual(readonly.controller.token('tx'), undefined);
  console.log('Disposal trial controller: late responses, apply, changed inputs, API failures and read-only Demo passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
