const WARNING_RATIO = 0.8;

// These budgets are operational guardrails for the supported single-user,
// loopback deployment. They deliberately describe both workload shape and
// elapsed time for the full audit-detail replay used by production state
// reads: passing a time assertion does not imply linear complexity.
const REPLAY_PERFORMANCE_BUDGETS = Object.freeze({
  typical: Object.freeze({
    label: '典型账本',
    eventCount: 37,
    peakActiveLotCount: 24,
    disposalLotVisits: 576,
    maxElapsedMs: 1500
  }),
  householdUpper: Object.freeze({
    label: '家庭账本建议上限',
    eventCount: 231,
    peakActiveLotCount: 150,
    disposalLotVisits: 24000,
    maxElapsedMs: 8000
  }),
  importLimit: Object.freeze({
    label: '导入事件硬上限',
    eventCount: 10000,
    peakActiveLotCount: 250,
    disposalLotVisits: 50000,
    maxElapsedMs: 15000
  })
});

function evaluateReplayBudget(elapsedMs, budget) {
  const utilization = elapsedMs / budget.maxElapsedMs;
  return {
    utilization,
    status: utilization > 1 ? 'exceeded' : utilization >= WARNING_RATIO ? 'warning' : 'ok'
  };
}

module.exports = { REPLAY_PERFORMANCE_BUDGETS, evaluateReplayBudget };
