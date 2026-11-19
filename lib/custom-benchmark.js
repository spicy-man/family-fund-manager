const TICKER_PATTERN = /^[\^A-Z0-9.\-=]{1,20}$/;
const MAX_COMPONENTS = 10;
const MAX_NAME_LENGTH = 40;
const MAX_CUSTOM_BENCHMARKS = 2;

function normalizeCustomBenchmark(value, ErrorType = Error) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ErrorType('自定义标的配置格式无效');
  }

  if (!Array.isArray(value.components) || value.components.length < 1 || value.components.length > MAX_COMPONENTS) {
    throw new ErrorType(`自定义标的必须包含 1-${MAX_COMPONENTS} 个成分`);
  }

  const components = value.components.map(item => {
    const ticker = typeof item?.ticker === 'string' ? item.ticker.trim().toUpperCase() : '';
    const weight = Number(item?.weight);
    if (!TICKER_PATTERN.test(ticker)) {
      throw new ErrorType(`标的代码格式非法：${ticker || '(空)'}`);
    }
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
      throw new ErrorType(`${ticker} 的权重必须大于 0 且不超过 100%`);
    }
    const normalizedWeight = Number(weight.toFixed(4));
    if (normalizedWeight <= 0) {
      throw new ErrorType(`${ticker} 的权重精度最多为 4 位小数，且舍入后必须大于 0`);
    }
    return { ticker, weight: normalizedWeight };
  });

  if (new Set(components.map(item => item.ticker)).size !== components.length) {
    throw new ErrorType('自定义标的中的代码不能重复');
  }
  const totalWeight = components.reduce((sum, item) => sum + item.weight, 0);
  if (Math.abs(totalWeight - 100) > 0.01) {
    throw new ErrorType(`成分权重合计必须为 100%（当前为 ${totalWeight.toFixed(2)}%）`);
  }

  let name = '';
  if (components.length === 1) {
    name = components[0].ticker;
  } else {
    name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new ErrorType(`自定义标的名称长度必须为 1-${MAX_NAME_LENGTH} 个字符`);
    }
  }

  return { name, components };
}

function customBenchmarkSignature(benchmark) {
  if (!benchmark) return null;
  return 'adjusted-close:' + benchmark.components.map(item => `${item.ticker}:${item.weight.toFixed(4)}`).join('|');
}

function isUsableCustomEntry(entry, navDate, benchmark) {
  if (!entry || entry.signature !== customBenchmarkSignature(benchmark) || !entry.components) return false;
  return benchmark.components.every(({ ticker }) => {
    const component = entry.components[ticker];
    return component && Number.isFinite(component.price) && component.price > 0 &&
      typeof component.priceDate === 'string' && component.priceDate < navDate;
  });
}

function customEntryForSlot(cacheEntry, slot = 0) {
  if (!cacheEntry || typeof cacheEntry !== 'object' || Array.isArray(cacheEntry)) return null;
  if (slot === 0) return cacheEntry.signature ? cacheEntry : (cacheEntry.primary || null);
  if (slot === 1) return cacheEntry.secondary || null;
  return null;
}

function mergeCustomEntryForSlot(cacheEntry, slot, entry) {
  const primary = customEntryForSlot(cacheEntry, 0);
  const secondary = customEntryForSlot(cacheEntry, 1);
  if (slot === 0) {
    return secondary ? { ...entry, secondary } : entry;
  }
  if (slot === 1) {
    return primary ? { ...primary, secondary: entry } : { secondary: entry };
  }
  throw new RangeError(`Custom benchmark slot must be between 0 and ${MAX_CUSTOM_BENCHMARKS - 1}.`);
}

module.exports = {
  TICKER_PATTERN,
  MAX_CUSTOM_BENCHMARKS,
  normalizeCustomBenchmark,
  customBenchmarkSignature,
  isUsableCustomEntry,
  customEntryForSlot,
  mergeCustomEntryForSlot
};
