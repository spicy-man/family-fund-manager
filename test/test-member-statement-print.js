const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const classes = () => {
  const values = new Set();
  return { add: name => values.add(name), remove: name => values.delete(name), contains: name => values.has(name) };
};
for (const [width, height, initiallyOpen, ongoing = false] of [[681, 750, false], [681, 2400, true], [1100, 800, false], [681, 4000, false], [681, 1000, false, true]]) {
  const listeners = {};
  let measured = 0, removed = 0, renderedHeight = 0;
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
    let zoom = 1;
    return {
    style: { setProperty(name, value) { if (name === 'zoom') zoom = Number(value); } },
    removeAttribute() {}, setAttribute() {}, classList: classes(), scrollWidth: width,
    getBoundingClientRect: () => {
      // Simulate cumulative line rounding in a long Windows print layout.
      renderedHeight = height * zoom + (height === 4000 && zoom < 1 ? 50 : 0);
      return { height: renderedHeight };
    }, remove: () => removed++
    };
  };
  const document = { title: 'Original title', getElementById: id => elements[id],
    body: { classList: classes(), appendChild: () => measured++ } };
  const report = { potentialFee: {amount:20,annualRate:0.06,feeRate:0.25,lots:[{currentValue:110,hurdle:106,fee:1},{currentValue:140,hurdle:125,fee:3.75}]}, ongoing, name: 'Member', start: '2025-01-01', end: '2026-01-01', months: [], rows: [],
    opening: 0, closing: 0, closingShares: 0, feesPaid: 0, feesReceived: 0, investmentProfit: 0,
    deposits: 0, withdrawals: 0, transfersIn: 0, transfersOut: 0, change: 0, openingNAV: 1, closingNAV: 1, navReturn: 0, openingHighWater: null,
    closingHighWater: { nav: 1.1, minNav: 1, maxNav: 1.2, lotCount: 2 },
    openingHighWaterLots: [], closingHighWaterLots: [
      { startDate: '2025-01-01', sourceType: 'deposit', shares: 100, highWaterNav: 1, basis: 100 },
      { startDate: '2025-02-01', sourceType: 'settlement_reset', shares: 100, highWaterNav: 1.2, basis: 120 }
    ] };
  const window = { addEventListener: (type, fn) => listeners[type] = fn,
    FundMemberStatement: { build: () => report },
    print() {
      const markup = elements['statement-content'].innerHTML;
      if (ongoing) {
        assert(!markup.includes('期末高水位'), 'Unsettled report must not display closing high-water');
        assert(!markup.includes('期末批次区间'));
        assert(markup.includes('<td>当前</td>'));
        assert(markup.includes('本期尚未结算'));
        assert(markup.includes('<span>潜在支付报酬</span><strong>$20</strong>'));
        assert(markup.includes('<span>当前权益</span>'));
        assert(markup.includes('未扣除预估报酬'));
        assert(markup.includes('<th>计提门槛</th><th>潜在报酬</th>'));
      } else {
        assert(markup.includes('期末高水位 · LP 加权<strong>1.1000</strong>'));
        assert(markup.includes('期末批次区间 1.0000–1.2000'));
        assert(markup.includes('<span>期末权益</span>'));
        assert(markup.includes('<span>本期支付报酬</span>'));
        assert(!markup.includes('<span>潜在支付报酬</span>'));
        assert(markup.includes('<td>期初</td>'));
        assert(markup.includes('<td>期末</td>'));
      }
      assert(markup.includes('本期投资一览'));
      assert(markup.includes('<span>本期净收益</span>'));
      assert(markup.includes('<span>本期净流入</span>'));
      assert(markup.includes('统计周期：2025-01-01 → 2026-01-01'));
      assert(!markup.includes('个人持仓回报率'));
      assert(elements['statement-content'].innerHTML.includes('2025-01-01 · 入金'));
      assert(elements['statement-content'].innerHTML.includes('2025-02-01 · 结算重置'));
      assert(elements['statement-content'].innerHTML.includes('<td>100.0000</td><td>1.2000</td><td>$120</td>'));
      assert(elements['statement-content'].innerHTML.includes('GP 签字：'), 'Report includes GP signature');
      assert(elements['statement-content'].innerHTML.includes('日期：'), 'Report includes signature date');
      assert.equal(method.open, true);
      const initialScale = Number(properties.get('--statement-print-scale'));
      assert(initialScale > 0 && initialScale <= 1);
      assert(renderedHeight <= 260 * 96 / 25.4 + 0.001, 'Zoomed layout must fit, including line rounding');
      assert(width * initialScale <= 180 * 96 / 25.4 + 0.001);
      assert(height * initialScale <= 260 * 96 / 25.4 + 0.001);
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
