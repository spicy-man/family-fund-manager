const Decimal = require('decimal.js');

const summaryFields = ['totalNAV', 'remainingPrincipal', 'activeProfit', 'profit', 'totalDeposit', 'totalWithdraw',
  'cnhTotalNAV', 'cnhRemainingPrincipal', 'cnhActiveProfit', 'cnhProfit', 'cnhTotalDeposit', 'cnhTotalWithdraw'];
const memberFields = ['currentValue', 'remainingPrincipal', 'profit', 'totalDeposit', 'totalWithdraw',
  'cnhCurrentValue', 'cnhRemainingPrincipal', 'cnhProfit', 'cnhDeposit', 'cnhWithdraw', 'lpCurrentValue', 'gpCarryValue'];
const rate = (profit, principal, empty = null) => principal === 0 ? empty
  : new Decimal(profit).div(principal).mul(100).toDecimalPlaces(2).toNumber();
function sum(items, fields) {
  return Object.fromEntries(fields.map(field => [field, items.reduce((total, item) =>
    total.plus(item[field] || 0), new Decimal(0)).toDecimalPlaces(2).toNumber()]));
}

// Aggregate the same calculated snapshots that power the dashboard and member cards.
// Shares and NAV belong to individual ledgers and are deliberately kept in details.
function combineLedgers(entries) {
  const ledgers = entries.map(({ id, name, state }) => ({ id, name, summary: state.summary,
    valuationDate: state.events.filter(event => event.type === 'valuation').map(event => event.date).sort().at(-1) || null }));
  const summary = sum(ledgers.map(ledger => ledger.summary), summaryFields);
  summary.activeProfitRate = rate(summary.activeProfit, summary.remainingPrincipal);
  summary.cnhActiveProfitRate = rate(summary.cnhActiveProfit, summary.cnhRemainingPrincipal);
  summary.profitRate = rate(summary.profit, summary.totalDeposit);
  summary.cnhProfitRate = rate(summary.cnhProfit, summary.cnhTotalDeposit);
  if (ledgers.length === 1) {
    // Preserve the calculator's rates before monetary display rounding.
    for (const field of ['activeProfitRate', 'cnhActiveProfitRate']) summary[field] = ledgers[0].summary[field];
    if (summary.totalDeposit > 0) summary.profitRate = ledgers[0].summary.profitRate;
    if (summary.cnhTotalDeposit > 0) summary.cnhProfitRate = ledgers[0].summary.cnhProfitRate;
  }
  // Compare dates across all ledgers. Stable ties retain each ledger's durable
  // event sequence; members without any record remain at the end.
  const firstRecord = new Map();
  entries.flatMap(entry => entry.state.events).sort((a, b) => a.date.localeCompare(b.date))
    .forEach((event, index) => {
      [event.member, event.fromMember, event.toMember, event.gpMember, event.performanceFee?.gpMember,
        ...(event.lpMembers || [])].forEach(id => { if (id && !firstRecord.has(id)) firstRecord.set(id, index); });
    });
  const groups = new Map();
  for (const { id: ledgerId, name: ledgerName, state } of entries) {
    for (const [id, account] of Object.entries(state.members)) {
      if (!groups.has(id)) groups.set(id, { id, name: account.name, names: new Set(), breakdown: [] });
      const group = groups.get(id);
      group.names.add(account.name);
      group.breakdown.push({ ledgerId, ledgerName, ...account });
    }
  }
  const members = [...groups.values()].sort((a, b) =>
    (firstRecord.get(a.id) ?? Infinity) - (firstRecord.get(b.id) ?? Infinity)).map(group => {
    const account = sum(group.breakdown, memberFields);
    return { id: group.id, name: group.name, names: [...group.names], ...account,
      // Member cards use historical cash-flow returns, including GP carry.
      profitRate: group.breakdown.length === 1 ? group.breakdown[0].profitRate : rate(account.profit, account.totalDeposit, 0),
      cnhProfitRate: group.breakdown.length === 1 ? group.breakdown[0].cnhProfitRate : rate(account.cnhProfit, account.cnhDeposit, 0), breakdown: group.breakdown };
  });
  return { summary, ledgers, members };
}
module.exports = { combineLedgers };
