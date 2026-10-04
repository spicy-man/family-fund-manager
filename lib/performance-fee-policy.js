const DEFAULT_ANNUAL_RATE = 0.06;
const DEFAULT_FEE_RATE = 0.25;
const CURRENT_DISPOSAL_VERSION = 2;
const { InputError, ConflictError } = require('./api-errors');

const DEFAULT_PERFORMANCE_FEE_CONFIG = Object.freeze({
  gpMemberId: null,
  annualRate: DEFAULT_ANNUAL_RATE,
  feeRate: DEFAULT_FEE_RATE
});

function isValidPerformanceFeeRates(value) {
  return value &&
    typeof value.annualRate === 'number' && Number.isFinite(value.annualRate) &&
    value.annualRate >= 0 && value.annualRate <= 1 &&
    typeof value.feeRate === 'number' && Number.isFinite(value.feeRate) &&
    value.feeRate >= 0 && value.feeRate <= 1;
}

function configuredPerformanceFeeRates(config = {}) {
  const rates = {
    annualRate: config.annualRate ?? DEFAULT_ANNUAL_RATE,
    feeRate: config.feeRate ?? DEFAULT_FEE_RATE
  };
  if (!isValidPerformanceFeeRates(rates)) {
    throw new InputError('业绩报酬配置必须包含 0 到 1 之间的有效年化门槛和报酬费率。');
  }
  return rates;
}

function createDisposalFeeSnapshot(config, members = []) {
  if (!config?.gpMemberId) return null;
  const gpMember = members.find(member => member.id === config.gpMemberId);
  if (!gpMember || gpMember.roles?.gp !== true) {
    throw new ConflictError('业绩报酬配置引用的GP成员不存在或角色无效。');
  }
  return {
    gpMember: config.gpMemberId,
    ...configuredPerformanceFeeRates(config),
    disposalVersion: CURRENT_DISPOSAL_VERSION
  };
}

function createSettlementFeeSnapshot(config) {
  return configuredPerformanceFeeRates(config);
}

function isValidDisposalFeeSnapshot(snapshot, memberIds) {
  return snapshot &&
    memberIds.has(snapshot.gpMember) &&
    isValidPerformanceFeeRates(snapshot) &&
    (snapshot.disposalVersion === undefined || [1, CURRENT_DISPOSAL_VERSION].includes(snapshot.disposalVersion));
}

module.exports = {
  DEFAULT_ANNUAL_RATE,
  DEFAULT_FEE_RATE,
  CURRENT_DISPOSAL_VERSION,
  DEFAULT_PERFORMANCE_FEE_CONFIG,
  isValidPerformanceFeeRates,
  configuredPerformanceFeeRates,
  createDisposalFeeSnapshot,
  createSettlementFeeSnapshot,
  isValidDisposalFeeSnapshot
};
