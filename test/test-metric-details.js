const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const timers = new Map();
let timerId = 0;
const document = { handlers: {}, activeElement: null, addEventListener(type, fn) {
  (this.handlers[type] ||= []).push(fn);
} };
const window = { innerWidth: 1000, innerHeight: 800, addEventListener() {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/metric-details.js'), 'utf8'), {
  window, document, setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); }
});
const { calculate, bind } = window.FundMetricDetails;
const history = [
  { date: '2025-01-01', navPerShare: 1, totalShares: 100 },
  { date: '2025-04-01', navPerShare: 1.5, totalShares: 100 },
  { date: '2025-07-01', navPerShare: 1.2, totalShares: 200 },
  { date: '2026-01-01', navPerShare: 1.3, totalShares: 200 }
];
const stats = calculate(history);
assert(Math.abs(stats.drawdown - 0.2) < 1e-12);
assert(Math.abs(stats.annualized - 0.3) < 1e-12);
assert(Math.abs(stats.mar - 1.5) < 1e-12);
assert.strictEqual(calculate([]).drawdown, null);
assert.strictEqual(calculate(history.slice(0, 1)).annualized, null);
assert.strictEqual(calculate(history.slice(0, 2)).mar, null, 'zero drawdown has no valid ratio');
assert.strictEqual(calculate(history.map(point => ({ ...point, date: '2025-01-01' }))).mar, null);
assert.strictEqual(calculate([...history, { date: '2026-02-01', navPerShare: 1, totalShares: 0 }]).end, '2026-01-01');
const loss = calculate([history[0], { ...history.at(-1), navPerShare: 0.8 }]);
assert(Math.abs(loss.mar + 1) < 1e-12, 'losses retain a negative ratio');
const totalLoss = calculate([history[0], { ...history.at(-1), navPerShare: 0 }]);
assert.strictEqual(totalLoss.drawdown, 1);
assert.strictEqual(totalLoss.annualized, -1);
assert.strictEqual(calculate([{ ...history[0], navPerShare: NaN }]).drawdown, null);
// A known alternating return series verifies annualization and downside denominators.
function monthlyHistory(returns) {
  let nav = 1;
  return [0, ...returns].map((value, index) => {
    if (index) nav *= 1 + value;
    return { date: new Date(Date.UTC(2024, index + 1, 0)).toISOString().slice(0, 10),
      type: 'valuation', navPerShare: nav, totalShares: 100 };
  });
}
const monthly = monthlyHistory(Array.from({ length: 12 }, (_, i) => i % 2 ? -0.05 : 0.1));
const risk = calculate(monthly);
const sd = Math.sqrt(12 * 0.075 ** 2 / 11);
assert.strictEqual(risk.monthlySamples, 12);
assert(Math.abs(risk.volatility - sd * Math.sqrt(12)) < 1e-12);
assert(Math.abs(risk.sharpe - 0.025 / sd * Math.sqrt(12)) < 1e-12);
assert(Math.abs(risk.sortino - 0.025 / Math.sqrt(0.05 ** 2 / 2) * Math.sqrt(12)) < 1e-12);
const withCashFlows = monthly.flatMap(point => [point, { ...point, type: 'deposit', totalShares: 200 }]);
assert.strictEqual(calculate(withCashFlows).sharpe, risk.sharpe, 'cash flow entries do not create return samples');
assert.strictEqual(calculate([...monthly, { ...monthly.at(-1), date: '2025-02-03', navPerShare: 20 }]).sharpe,
  risk.sharpe, 'partial final month is excluded');
assert.strictEqual(calculate(monthly.slice(0, 12)).volatility, null, 'requires twelve monthly returns');
const missingMonth = calculate(monthly.filter((_, index) => index !== 6));
assert.strictEqual(missingMonth.monthlySamples, 10, 'both sides of a missing month are excluded');
assert.strictEqual(missingMonth.sharpe, null);
const flat = calculate(monthlyHistory(Array(12).fill(0)));
assert.strictEqual(flat.volatility, 0);
assert.strictEqual(flat.sharpe, null);
assert.strictEqual(flat.sortino, null);
assert.strictEqual(calculate(monthlyHistory(Array(12).fill(0.02))).sortino, null, 'no downside means no ratio');
assert(calculate(monthlyHistory(Array(12).fill(-0.02))).sortino < 0);
const reset = [...monthly];
reset.splice(6, 0, { date: '2024-07-01', type: 'withdraw', navPerShare: 1, totalShares: 0 });
assert.strictEqual(calculate(reset).monthlySamples, 11, 'empty fund reset breaks the return series');
const nodes = Object.fromEntries(['drawdown', 'annualized', 'mar', 'volatility', 'sharpe', 'sortino', 'risk-samples', 'period']
  .map(name => [`nav-details-${name}`, {}]));
document.getElementById = id => nodes[id];
window.FundMetricDetails.render(monthly);
assert.strictEqual(nodes['nav-details-volatility'].textContent, `${(risk.volatility * 100).toFixed(2)}%`);
assert.strictEqual(nodes['nav-details-sharpe'].textContent, risk.sharpe.toFixed(2));
assert.strictEqual(nodes['nav-details-sortino'].textContent, risk.sortino.toFixed(2));
window.FundMetricDetails.render([]);
assert.strictEqual(nodes['nav-details-sortino'].textContent, '—');
function element(bounds = {}) {
  return { handlers: {}, attributes: {}, hidden: true, style: {}, children: [],
    addEventListener(type, fn) { this.handlers[type] = fn; },
    setAttribute(name, value) { this.attributes[name] = value; },
    contains(node) { return node === this || this.children.includes(node); },
    getBoundingClientRect() { return bounds; },
    focus() { document.activeElement = this; this.handlers.focusin?.(); }
  };
}
const card = element({ left: 800, top: 100, bottom: 200 });
const panel = element({ width: 600, height: 400 });
const close = element(); panel.children.push(close);
bind(card, panel, close);
card.handlers.mouseenter();
assert.strictEqual(panel.hidden, false, 'hover opens without a click');
assert.strictEqual(card.attributes['aria-expanded'], 'true');
assert.strictEqual(panel.style.left, '388px', 'popover stays within viewport');
card.handlers.mouseleave(); panel.handlers.mouseenter();
assert.strictEqual(timers.size, 0, 'moving into details cancels dismissal');
panel.handlers.mouseleave();
for (const fn of timers.values()) fn();
assert.strictEqual(panel.hidden, true);
card.focus();
assert.strictEqual(panel.hidden, false, 'keyboard focus reveals details');
card.handlers.keydown({ key: 'Enter', preventDefault() {} });
assert.strictEqual(document.activeElement, close);
for (const fn of document.handlers.keydown) fn({ key: 'Escape', preventDefault() {} });
assert.strictEqual(panel.hidden, true, 'Escape closes without focus reopening');
assert.strictEqual(document.activeElement, card);
const otherCard = element({ left: 0, top: 100, bottom: 200 });
const otherPanel = element({ width: 600, height: 400 });
bind(otherCard, otherPanel, element());
card.handlers.mouseenter(); otherCard.handlers.mouseenter();
assert.strictEqual(panel.hidden, true, 'only one metric detail is visible');
assert.strictEqual(otherPanel.hidden, false);
console.log('Metric detail hover and NAV performance assertions passed.');
