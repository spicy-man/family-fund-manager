(function (root) {
  // Consume the authoritative replay, including its historical member values.
  // Work in displayed cents so the reconciliation also holds on paper.
  const cents = value => Math.round((Number(value) || 0) * 100);

  const economicEvents = state => {
    const reversed = new Set(state.events.filter(event => event.type === 'performance_settlement_reversal').map(event => event.settlementId));
    return state.events.filter(event => event.type !== 'performance_settlement_reversal' && !reversed.has(event.id));
  };

  function periods(state, asOf, memberId) {
    const events = economicEvents(state);
    const settlements = events.map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'performance_settlement' && event.date <= asOf);
    if (!settlements.length) return [];
    const result = settlements.map(({ event, index }, position) => {
      const previous = settlements[position - 1];
      const start = previous ? previous.event.date : events[0].date;
      return { id: event.id, start, end: event.date, startIndex: previous?.index ?? -1, endIndex: index,
        ongoing: false, label: `${start} → ${event.date} · 已结算` };
    });
    const last = settlements.at(-1);
    result.push({ id: 'since-last-settlement', start: last.event.date, end: asOf,
      startIndex: last.index, endIndex: events.findLastIndex(event => event.date <= asOf),
      ongoing: true, label: `${last.event.date} → 至今` });
    const ordered = result.reverse();
    if (!memberId) return ordered;
    if (!state.members[memberId]) return [];
    const history = state.charts.memberHistory[memberId] || [];
    return ordered.filter(period => {
      const heldShares = history.slice(Math.max(0, period.startIndex), period.endIndex + 1)
        .some(point => point.shares !== 0);
      if (heldShares) return true;
      return buildRange(state, memberId, events, period.startIndex, period.endIndex)
        .rows.some(row => row.amount !== 0);
    });
  }

  function build(state, memberId, periodId, asOf) {
    const period = periods(state, asOf, memberId).find(item => item.id === periodId);
    if (!period) throw new Error('请选择已结算周期或最后一次结算至今');
    const events = economicEvents(state);
    const report = buildRange(state, memberId, events, period.startIndex, period.endIndex);
    const months = [];
    let cursor = period.start.slice(0, 7);
    let startIndex = period.startIndex;
    while (cursor <= period.end.slice(0, 7)) {
      let endIndex = startIndex;
      while (endIndex < period.endIndex && events[endIndex + 1].date.slice(0, 7) <= cursor) endIndex++;
      months.push({ month: cursor, startIndex, endIndex });
      startIndex = endIndex;
      const [year, month] = cursor.split('-').map(Number);
      cursor = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
    }
    return { ...report, period: period.id, start: period.start, end: period.end,
      ongoing: period.ongoing, periodLabel: period.label,
      months: months.map(item => ({ ...buildRange(state, memberId, events, item.startIndex, item.endIndex), month: item.month })) };
  }

  function buildRange(state, memberId, events, startIndex, endIndex) {
    if (!state?.members?.[memberId]) throw new Error('请选择家庭成员');
    const history = state.charts.memberHistory[memberId];
    if (!history || history.length !== events.length) throw new Error('成员历史数据不完整，请刷新后重试');
    let opening = 0, closing = 0, openingShares = 0, closingShares = 0;
    let openingNAV = 1, closingNAV = 1;
    const navHistory = state.charts.navHistory;
    if (!navHistory || navHistory.length !== events.length) throw new Error('净值历史数据不完整，请刷新后重试');
    let openingValuation = null, closingValuation = null, through = null;
    const totals = { deposits: 0, withdrawals: 0, transfersIn: 0, transfersOut: 0, feesPaid: 0, feesReceived: 0 };
    const rows = [];
    const names = id => state.members[id]?.name || id;
    events.forEach((event, index) => {
      if (index > endIndex) return;
      through = event.date;
      // Chart points are rounded for display; calculate returns from the
      // replay's transaction NAV so small changes are not rounded away.
      closingNAV = event._navAtTx;
      closing = cents(history[index].value);
      closingShares = history[index].shares;
      if (event.type === 'valuation') closingValuation = event.date;
      if (index <= startIndex) {
        openingNAV = closingNAV;
        opening = closing;
        openingShares = closingShares;
        openingValuation = closingValuation;
        return;
      }
      function add(key, amount, label) {
        const value = cents(amount);
        totals[key] += value;
        const direction = ['withdrawals', 'transfersOut', 'feesPaid'].includes(key) ? -1 : 1;
        rows.push({ date: event.date, label, amount: direction * value / 100, remark: event.remark || '' });
      }
      if (event.type === 'deposit' && event.member === memberId) add('deposits', event.amount, '入金');
      if (event.type === 'withdraw' && event.member === memberId) add('withdrawals', event._actualAmount, '出金（实收）');
      if (event.type === 'transfer') {
        if (event.toMember === memberId) add('transfersIn', event._actualAmount, `由 ${names(event.fromMember)} 转入`);
        if (event.fromMember === memberId) add('transfersOut', event._actualAmount, `向 ${names(event.toMember)} 转出`);
      }
      // Fee shares are the actual balance movement; rounded fee estimates can
      // differ from the transferred shares in historical disposal algorithms.
      if (event.type === 'withdraw' || event.type === 'transfer') {
        const fee = (event._performanceFeeShares || 0) * event._navAtTx;
        if (fee) {
          if ((event.member || event.fromMember) === memberId) add('feesPaid', fee, `向 ${names(event.performanceFee?.gpMember)} 支付报酬`);
          if (event.performanceFee?.gpMember === memberId) add('feesReceived', fee, `由 ${names(event.member || event.fromMember)} 收到报酬`);
        }
      }
      if (event.type === 'performance_settlement') {
        for (const item of event._breakdown || []) {
          const fee = item.feeShares * event._navAtTx;
          if (!fee) continue;
          if (item.member === memberId) add('feesPaid', fee, `向 ${names(event.gpMember)} 支付报酬（结算）`);
          if (event.gpMember === memberId) add('feesReceived', fee, `由 ${names(item.member)} 收到报酬（结算）`);
        }
      }
    });
    const investmentProfit = closing - opening - totals.deposits + totals.withdrawals - totals.transfersIn + totals.transfersOut + totals.feesPaid - totals.feesReceived;
    return {
      memberId, name: state.members[memberId].name, through,
      opening: opening / 100, closing: closing / 100, change: (closing - opening) / 100,
      openingShares, closingShares, openingValuation, closingValuation,
      openingNAV, closingNAV, navChange: closingNAV - openingNAV,
      navReturn: openingNAV > 0 ? (closingNAV / openingNAV - 1) * 100 : null,
      ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / 100])),
      investmentProfit: investmentProfit / 100, rows
    };
  }
  root.FundMemberStatement = { build, periods };
  if (typeof module !== 'undefined' && module.exports) module.exports = { build, periods };
})(typeof window === 'undefined' ? globalThis : window);
