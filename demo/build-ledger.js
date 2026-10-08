const weeklyMarket = require('./weekly-market.json');
const { customBenchmarkSignature, mergeCustomEntryForSlot } = require('../lib/custom-benchmark');

const portfolio1 = {
  name: 'VGT',
  components: [{ ticker: 'VGT', weight: 100 }]
};

const portfolio2 = {
  name: 'BRK-B',
  components: [{ ticker: 'BRK-B', weight: 100 }]
};

const members = [
  { id: '100001', name: 'John Titor', roles: { lp: true, gp: true } },
  { id: '100002', name: 'Alice Liddell', roles: { lp: true, gp: false } },
  { id: '100003', name: 'Giovanni Giorgio', roles: { lp: true, gp: false } }
];

const performanceFee = { gpMemberId: '100001', annualRate: 0.06, feeRate: 0.25 };
const signature1 = customBenchmarkSignature(portfolio1);
const signature2 = customBenchmarkSignature(portfolio2);

function customCacheEntry(row) {
  const primary = {
    signature: signature1,
    components: { VGT: { price: row.vgt, priceDate: row.priceDate } }
  };
  const secondary = {
    signature: signature2,
    components: {
      'BRK-B': { price: weeklyMarket.historyPrices['BRK-B'][row.priceDate], priceDate: row.priceDate }
    }
  };
  return mergeCustomEntryForSlot(primary, 1, secondary);
}

function buildDemoLedger({ secondary = false } = {}) {
  const ledgerMembers = members.map(member => ({ ...member, roles: { ...member.roles } }));
  if (secondary) ledgerMembers[2] = { id: '100004', name: 'Makise Kurisu', roles: { lp: true, gp: false } };
  const memberId = id => secondary && id === '100003' ? '100004' : id;
  const capitalScale = secondary ? 0.4 : 1;
  const events = [];
  const indexCache = {};
  const customBenchmarkCache = {};
  const first = weeklyMarket.weeks[0];
  const marketByDate = Object.fromEntries(weeklyMarket.weeks.map(row => [row.date, row]));
  let sequenceNumber = 0;
  let totalShares = 0;
  let currentNav = 1;

  const push = event => events.push({
    ...event,
    ...(event.member ? { member: memberId(event.member) } : {}),
    ...(event.fromMember ? { fromMember: memberId(event.fromMember), toMember: memberId(event.toMember) } : {}),
    ...(event.lpMembers ? { lpMembers: ledgerMembers.map(member => member.id) } : {}),
    createdAt: Date.parse(`${event.date}T12:00:00Z`) + sequenceNumber,
    sequenceNumber: ++sequenceNumber
  });
  const historicalCnhAmount = (amount, date) => Number((amount * marketByDate[date].cnh).toFixed(2));
  const deposit = (id, member, amount, date, remark) => {
    amount *= capitalScale;
    const cnhAmount = historicalCnhAmount(amount, date);
    push({ id, type: 'deposit', member, amount, cnhAmount, date, remark });
    totalShares += amount / currentNav;
  };
  const withdraw = (id, member, amount, date, remark) => {
    amount *= capitalScale;
    const cnhAmount = historicalCnhAmount(amount, date);
    push({
      id, type: 'withdraw', member, amount, cnhAmount, date, remark,
      performanceFee: { gpMember: '100001', annualRate: 0.06, feeRate: 0.25 }
    });
    totalShares -= amount / currentNav;
  };

  deposit('demo_deposit_alex', '100001', 60000, first.date, '发起人首期入金');
  deposit('demo_deposit_lin', '100002', 40000, first.date, '家庭成员首期入金');

  weeklyMarket.weeks.forEach((row, index) => {
    // Value the existing holdings before issuing or redeeming shares that day.
    const aaplReturn = row.aapl / first.aapl;
    const googlReturn = row.googl / first.googl;
    const vgtReturn = row.vgt / first.vgt;
    const grossFundNav = secondary
      ? 0.7 * row.spx / first.spx + 0.3 * row.ndx / first.ndx
      : 0.2 * aaplReturn + 0.2 * googlReturn + 0.6 * vgtReturn;
    const annualCostFactor = Math.max(0.98, 1 - (0.0015 * index / 52));
    const targetNav = grossFundNav * annualCostFactor;
    push({
      id: `demo_week_${row.date}`,
      type: 'valuation',
      totalNAV: Number((totalShares * targetNav).toFixed(2)),
      date: row.date,
      remark: index === 0 ? '建仓周估值' : '周度估值'
    });
    currentNav = targetNav;


    if (row.date === '2022-06-10') {
      deposit('demo_deposit_zhou', '100003', 25000, row.date, '新增合伙人入金');
    }
    if (row.date === '2023-07-14') {
      push({
        id: 'demo_transfer', type: 'transfer', fromMember: '100002', toMember: '100003',
        amount: 8000 * capitalScale, cnhRate: row.cnh, date: row.date, remark: '成员间份额转让',
        performanceFee: { gpMember: '100001', annualRate: 0.06, feeRate: 0.25 }
      });
    }
    if (row.date === '2024-04-12') {
      withdraw('demo_withdraw_lin', '100002', 5000, row.date, '成员部分退出');
    }
    if (row.date === '2025-02-14') {
      deposit('demo_deposit_alex_2', '100001', 18000, row.date, '发起人追加投资');
    }
    if (row.date === '2026-06-12') {
      withdraw('demo_withdraw_zhou', '100003', 3500, row.date, '成员部分退出');
    }


    const isLastSeptemberWeek = row.date.slice(5, 7) === '09' &&
      weeklyMarket.weeks[index + 1]?.date.slice(0, 7) !== row.date.slice(0, 7);
    if (isLastSeptemberWeek && row.date.slice(0, 4) <= '2025') {
      push({
        id: `demo_settlement_${row.date.slice(0, 4)}`,
        type: 'performance_settlement',
        date: row.date,
        gpMember: '100001',
        lpMembers: members.map(member => member.id),
        annualRate: 0.06,
        feeRate: 0.25,
        algorithmVersion: 3,
        remark: `${row.date.slice(0, 4)} 年度业绩报酬结算`
      });
    }

    indexCache[row.date] = {
      policy: 'previous', source: weeklyMarket.priceBasis === 'adjusted-close' ? 'VOO/QQQM:adjusted-close' : 'legacy-index-close', spx: row.spx, ndx: row.ndx,
      spxPriceDate: row.priceDate, ndxPriceDate: row.priceDate
    };
    customBenchmarkCache[row.date] = customCacheEntry(row);
  });

  weeklyMarket.anchors.forEach(row => {
    indexCache[row.date] = {
      policy: 'previous', source: weeklyMarket.priceBasis === 'adjusted-close' ? 'VOO/QQQM:adjusted-close' : 'legacy-index-close', spx: row.spx, ndx: row.ndx,
      spxPriceDate: row.priceDate, ndxPriceDate: row.priceDate
    };
    customBenchmarkCache[row.date] = customCacheEntry(row);
  });

  return {
    members: ledgerMembers,
    performanceFee: { ...performanceFee },
    cnhRate: weeklyMarket.latestCnh.rate,
    events,
    indexCache,
    customBenchmarkCache,
    customBenchmark: portfolio1,
    customBenchmark2: portfolio2
  };
}

function buildDemoLedgers() {
  return [
    { id: 'default', name: '成长账本', isDefault: true, ledger: buildDemoLedger() },
    { id: 'ledger-2', name: '稳健账本', isDefault: false, ledger: buildDemoLedger({ secondary: true }) }
  ];
}
module.exports = { buildDemoLedger, buildDemoLedgers, portfolio1, portfolio2 };
