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
  { id: 'alex', name: 'John Titor', roles: { lp: true, gp: true } },
  { id: 'lin', name: 'Alice Liddell', roles: { lp: true, gp: false } },
  { id: 'zhou', name: 'Giovanni Giorgio', roles: { lp: true, gp: false } }
];

const performanceFee = { gpMemberId: 'alex', annualRate: 0.06, feeRate: 0.25 };
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

function buildDemoLedger() {
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
    createdAt: Date.parse(`${event.date}T12:00:00Z`) + sequenceNumber,
    sequenceNumber: ++sequenceNumber
  });
  const historicalCnhAmount = (amount, date) => Number((amount * marketByDate[date].cnh).toFixed(2));
  const deposit = (id, member, amount, date, remark) => {
    const cnhAmount = historicalCnhAmount(amount, date);
    push({ id, type: 'deposit', member, amount, cnhAmount, date, remark });
    totalShares += amount / currentNav;
  };
  const withdraw = (id, member, amount, date, remark) => {
    const cnhAmount = historicalCnhAmount(amount, date);
    push({
      id, type: 'withdraw', member, amount, cnhAmount, date, remark,
      performanceFee: { gpMember: 'alex', annualRate: 0.06, feeRate: 0.25 }
    });
    totalShares -= amount / currentNav;
  };

  deposit('demo_deposit_alex', 'alex', 60000, first.date, '发起人首期入金');
  deposit('demo_deposit_lin', 'lin', 40000, first.date, '家庭成员首期入金');

  weeklyMarket.weeks.forEach((row, index) => {
    // Value the existing holdings before issuing or redeeming shares that day.
    const aaplReturn = row.aapl / first.aapl;
    const googlReturn = row.googl / first.googl;
    const vgtReturn = row.vgt / first.vgt;
    const grossFundNav = 0.2 * aaplReturn + 0.2 * googlReturn + 0.6 * vgtReturn;
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
      deposit('demo_deposit_zhou', 'zhou', 25000, row.date, '新增合伙人入金');
    }
    if (row.date === '2023-07-14') {
      push({
        id: 'demo_transfer', type: 'transfer', fromMember: 'lin', toMember: 'zhou',
        amount: 8000, cnhRate: row.cnh, date: row.date, remark: '成员间份额转让',
        performanceFee: { gpMember: 'alex', annualRate: 0.06, feeRate: 0.25 }
      });
    }
    if (row.date === '2024-04-12') {
      withdraw('demo_withdraw_lin', 'lin', 5000, row.date, '成员部分退出');
    }
    if (row.date === '2025-02-14') {
      deposit('demo_deposit_alex_2', 'alex', 18000, row.date, '发起人追加投资');
    }
    if (row.date === '2026-06-12') {
      withdraw('demo_withdraw_zhou', 'zhou', 3500, row.date, '成员部分退出');
    }


    const isLastSeptemberWeek = row.date.slice(5, 7) === '09' &&
      weeklyMarket.weeks[index + 1]?.date.slice(0, 7) !== row.date.slice(0, 7);
    if (isLastSeptemberWeek && row.date.slice(0, 4) <= '2025') {
      push({
        id: `demo_settlement_${row.date.slice(0, 4)}`,
        type: 'performance_settlement',
        date: row.date,
        gpMember: 'alex',
        lpMembers: members.map(member => member.id),
        annualRate: 0.06,
        feeRate: 0.25,
        algorithmVersion: 3,
        remark: `${row.date.slice(0, 4)} 年度业绩报酬结算`
      });
    }

    indexCache[row.date] = {
      policy: 'previous', spx: row.spx, ndx: row.ndx,
      spxPriceDate: row.priceDate, ndxPriceDate: row.priceDate
    };
    customBenchmarkCache[row.date] = customCacheEntry(row);
  });

  weeklyMarket.anchors.forEach(row => {
    indexCache[row.date] = {
      policy: 'previous', spx: row.spx, ndx: row.ndx,
      spxPriceDate: row.priceDate, ndxPriceDate: row.priceDate
    };
    customBenchmarkCache[row.date] = customCacheEntry(row);
  });

  return {
    members,
    performanceFee,
    cnhRate: weeklyMarket.latestCnh.rate,
    events,
    indexCache,
    customBenchmarkCache,
    customBenchmark: portfolio1,
    customBenchmark2: portfolio2
  };
}

module.exports = { buildDemoLedger, portfolio1, portfolio2 };
