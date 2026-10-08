const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const timers = new Map();
let timerId = 0;
const document = { handlers: {}, activeElement: null, addEventListener(type, fn) {
  (this.handlers[type] ||= []).push(fn);
} };
const window = { innerWidth: 1000, innerHeight: 800, handlers: {}, addEventListener(type, fn) {
  (this.handlers[type] ||= []).push(fn);
} };
vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/metric-details.js'), 'utf8'), {
  window, document, getComputedStyle: node => ({ opacity: node.style.opacity || '1',
    transform: node.style.transform || 'none', clipPath: node.style.clipPath || 'inset(0)' }),
  setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); }
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
const annualHistory = [
  { date: '2025-06-21', navPerShare: 1, totalShares: 100 },
  { date: '2025-12-31', navPerShare: 1.228, totalShares: 100 },
  { date: '2026-01-01', navPerShare: 1.2292, totalShares: 100 },
  { date: '2026-10-05', navPerShare: 1.4015, totalShares: 200 }
];
const currentYearReturn = 1.4015 / 1.2292 - 1;
assert(Math.abs(calculate(annualHistory.slice(0, 3)).worstYear - 0.2292) < 1e-12,
  'January 1 of the next year closes the preceding year');
assert(Math.abs(calculate([
  { date: '2025-01-01', navPerShare: 1, totalShares: 100 },
  { date: '2025-12-31', navPerShare: 1.3, totalShares: 100 },
  { date: '2026-01-01', navPerShare: 0.9, totalShares: 100 },
  { date: '2026-10-05', navPerShare: 1.08, totalShares: 100 }
]).worstYear + 0.1) < 1e-12, 'shared boundary can change which year is worst');
assert(Math.abs(calculate(annualHistory).worstYear - currentYearReturn) < 1e-12,
  'use the first NAV of each year, matching recorded interval returns');
assert(Math.abs(calculate(annualHistory.slice(0, 2)).worstYear - 0.228) < 1e-12,
  'include partial inception year without annualizing');
assert.strictEqual(calculate(annualHistory.slice(0, 1)).worstYear, null, 'one snapshot has no return interval');
assert(Math.abs(calculate([
  { date: '2025-01-01', navPerShare: 1, totalShares: 100 },
  { date: '2025-12-31', navPerShare: 0.8, totalShares: 100 }
]).worstYear + 0.2) < 1e-12);
assert.strictEqual(calculate([
  annualHistory[0], { date: '2025-07-01', navPerShare: 1, totalShares: 0 }, annualHistory[1]
]).worstYear, null, 'do not bridge an empty fund reset');
assert(Math.abs(calculate([
  { date: '2024-06-30', navPerShare: 1, totalShares: 100 },
  { date: '2024-10-01', navPerShare: 0.9, totalShares: 100 },
  ...annualHistory
]).worstYear + 0.1) < 1e-12, 'include partial years without December records');
assert(Math.abs(calculate([
  annualHistory[0], { ...annualHistory[1], date: '2025-12-20' }
]).worstYear - 0.228) < 1e-12, 'include unfinished years');
const nodes = Object.fromEntries(['drawdown', 'annualized', 'mar', 'worst-year', 'sharpe', 'sortino', 'risk-samples', 'period']
  .map(name => [`nav-details-${name}`, {}]));
document.getElementById = id => nodes[id];
window.FundMetricDetails.render(monthly);
assert.strictEqual(nodes['nav-details-worst-year'].textContent, `${risk.worstYear > 0 ? '+' : ''}${(risk.worstYear * 100).toFixed(2)}%`);
assert.strictEqual(nodes['nav-details-sharpe'].textContent, risk.sharpe.toFixed(2));
assert.strictEqual(nodes['nav-details-sortino'].textContent, risk.sortino.toFixed(2));
window.FundMetricDetails.render([]);
assert.strictEqual(nodes['nav-details-sortino'].textContent, '—');
assert.strictEqual(nodes['nav-details-worst-year'].textContent, '—');
window.FundMetricDetails.render(annualHistory);
assert.strictEqual(nodes['nav-details-worst-year'].textContent, '+14.02%');
assert.strictEqual(nodes['nav-details-worst-year'].className, 'privacy-sensitive text-green');
window.FundMetricDetails.render([{ ...annualHistory[0], navPerShare: 2 }, annualHistory[1]]);
assert.strictEqual(nodes['nav-details-worst-year'].textContent, '-38.60%');
assert.strictEqual(nodes['nav-details-worst-year'].className, 'privacy-sensitive text-magenta');
function element(bounds = {}) {
  return { handlers: {}, attributes: {}, hidden: true, style: {}, children: [],
    querySelector() { return null; },
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
assert.strictEqual(panel.style.left, '800px', 'popover remains aligned with its card even at the viewport edge');
assert.strictEqual(panel.style.top, '208px', 'popover stays below its card');
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
const fadeCard = element({ left: 0, top: 100, bottom: 200 });
const fadePanel = element({ width: 600, height: 400 });
const fadeSurface = element();
fadePanel.querySelector = () => fadeSurface;
const fadeClose = element();
const fades = [];
fadePanel.animate = () => { throw new Error('Do not animate the glass ancestor: it isolates the backdrop'); };
fadeSurface.animate = (frames, options) => {
  const animation = { frames, options, cancel() { this.cancelled = true; } };
  fades.push(animation);
  return animation;
};
bind(fadeCard, fadePanel, fadeClose);
fadeCard.handlers.mouseenter();
assert.equal(fades[0].frames[0].opacity, 0);
assert.equal(fades[0].frames[1].opacity, 1);
assert.equal(fadePanel.style.opacity, undefined, 'Keep the backdrop ancestor fully opaque');
assert.equal(fadePanel.style.transform, undefined, 'Move only the glass surface');
assert.equal(fades[0].frames[0].transform, 'translateY(-18px)', 'Start above the final position');
assert.equal(fades[0].frames[1].transform, 'translateY(0)', 'Slide the whole panel downwards');
assert(fades[0].frames.every(frame => !('clipPath' in frame)), 'Keep the shadow visible throughout the animation');
fadeClose.handlers.click();
assert.equal(fadePanel.hidden, false, 'Keep the panel mounted until its fade-out ends');
assert.equal(fadePanel.inert, true, 'Closing panels must not accept input');
assert.equal(fadePanel.attributes['aria-hidden'], 'true');
const staleExit = fades[1];
assert.equal(staleExit.frames[1].transform, 'translateY(-18px)', 'Slide upwards when closing');
assert.equal(staleExit.frames[1].opacity, 0, 'Fade the panel and its shadow out together');
fadeCard.handlers.mouseenter();
assert(staleExit.cancelled, 'Re-entering interrupts fade-out');
staleExit.onfinish();
assert.equal(fadePanel.hidden, false, 'A stale exit must not hide the reopened panel');
assert.equal(fadePanel.inert, false);
fadeClose.handlers.click();
fades.at(-1).onfinish();
assert.equal(fadePanel.hidden, true, 'Completed fade-out hides the panel');
window.matchMedia = () => ({ matches: true });
const fadeCount = fades.length;
fadeCard.handlers.mouseenter();
fadeClose.handlers.click();
assert.equal(fades.length, fadeCount, 'Reduced-motion preference skips fades');
assert.equal(fadePanel.hidden, true);
// All three cards keep the same card-relative position, including clipping,
// content growth, scrolling, viewport resize and reopening.
for (const name of ['assets', 'nav', 'return']) {
  window.innerWidth = 1000; window.innerHeight = 500;
  const anchor = { left: 800, top: 100, bottom: 200 };
  const bounds = { width: 480, height: 476 };
  const trigger = element(anchor);
  const details = element(bounds);
  const dismiss = element();
  bind(trigger, details, dismiss);
  trigger.handlers.mouseenter();
  const initial = { ...details.style };
  assert.strictEqual(initial.left, '800px', `${name}: do not shift away from the card at the right edge`);
  assert.strictEqual(initial.top, '208px', `${name}: do not lift tall details above the card`);
  bounds.width = 600; bounds.height = 650;
  for (let repeat = 0; repeat < 6; repeat++) {
    trigger.handlers.mouseenter();
    trigger.handlers.focusin();
    trigger.handlers.click();
    assert.deepStrictEqual(details.style, initial, `${name}: clipping/reflow must not cause drift`);
  }
  window.innerWidth = 700; window.innerHeight = 300;
  for (const fn of window.handlers.resize) fn();
  assert.deepStrictEqual(details.style, initial, `${name}: smaller viewport must not shift details away from the card`);
  anchor.left = 650; anchor.top = 50; anchor.bottom = 150;
  for (const fn of window.handlers.scroll) fn({ target: document });
  assert.strictEqual(details.style.left, '650px', `${name}: follow the card horizontally on scroll`);
  assert.strictEqual(details.style.top, '158px', `${name}: preserve the vertical gap on scroll`);
  const scrolled = { ...details.style };
  for (const fn of window.handlers.scroll) fn({ target: details });
  assert.deepStrictEqual(details.style, scrolled, `${name}: internal scrolling must not move the panel`);
  dismiss.handlers.click();
  trigger.handlers.mouseenter();
  assert.deepStrictEqual(details.style, scrolled, `${name}: reopening preserves the card relationship`);
  dismiss.handlers.click();
}
console.log('Metric detail hover and NAV performance assertions passed.');
