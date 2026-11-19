const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadCssEntry } = require('./helpers/load-css');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'public', 'js', 'ledger-renderer.js'), 'utf8');
const settlementController = fs.readFileSync(path.join(root, 'public', 'js', 'settlement-controller.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = loadCssEntry(path.join(root, 'public', 'css', 'style.css'));

assert(renderer.includes("['withdraw', 'transfer'].includes(event.type) && event._disposedLots?.length"),
  'withdrawals and transfers must expose their lot disposal breakdown');
assert(renderer.includes('各批次按净额同比结晶'), 'ledger row must visibly disclose net-value proportional crystallization');
assert(renderer.includes('本次总扣减份额'), 'lot breakdown must show total disposed shares');
assert(renderer.includes('lot.totalShares') && renderer.includes('lot.cashShares') && renderer.includes('lot.feeShares'),
  'lot breakdown must reconcile LP cash shares and GP fee shares');
assert(renderer.includes('event._disposalVersion'),
  'historical disposal rows must disclose their original calculation method');
assert(renderer.includes('event._carrySharesDisposed'),
  'full exits must disclose separately settled GP carry shares');
assert(renderer.includes('其中内部结晶业绩报酬') && renderer.includes('isSelfGpDisposal'),
  'self-GP disposals must not describe internal crystallization as an extra fee');
assert(renderer.includes('formatRate(event.performanceFee?.annualRate)') && renderer.includes('按比例 ${annualRateLabel} 门槛'),
  'lot breakdown must label the proportional hurdle with its snapshotted rate');
assert(renderer.includes('formatRate(event.annualRate)') && renderer.includes('${annualRateLabel} 门槛'),
  'settlement breakdown must label its hurdle with its snapshotted rate');
assert(renderer.includes('本批次业绩报酬'), 'zero-fee and fee-bearing lots must show their own fee');
assert(settlementController.includes('preview.event.annualRate') && settlementController.includes('preview.event.feeRate'),
  'settlement preview must label the configured rates returned by the preview event');
assert(!settlementController.includes('25%报酬') && /<th(?:\s+scope="col")?>本期门槛<\/th>/.test(html),
  'settlement preview must not hard-code a rate that can differ from configuration');
assert(css.includes('.ledger-row--disposal:hover + .ledger-row--disposal-detail'),
  'hovering a disposal ledger row must reveal the audit breakdown');

console.log('Ledger disposal breakdown regression tests passed.');
