const { InputError, handleApiError } = require('../lib/api-errors');

function registerTickerRoutes(app, deps) {
  const { readConfig, writeConfig, readTickerCache, writeTickerCache,
    fetchTickerAthData, now: getNow } = deps;

// Persisted stale-while-revalidate cache. Requests never wait for Yahoo when a
// usable snapshot exists, and all tabs share one background refresh worker.
const TICKER_CLOSE_RETRY_DURATION = 10 * 60 * 1000;
const TICKER_MISSING_DAY_RETRY_DURATION = 2 * 60 * 60 * 1000;
const TICKER_WEEKEND_RETRY_DURATION = 6 * 60 * 60 * 1000;
let tickerRefreshPromise = null;
let queuedTickerConfig = null;
let activeTickerConfigSignature = null;
const tickerRefreshAttempts = new Map();
const tickerRefreshOutcomes = new Map();

function selectTickerData(cache, config, includeMissing = false) {
  const selected = {};
  for (const item of config.tickers) {
    const ticker = item.ticker;
    if (cache.tickers?.[ticker]?.priceBasis === 'adjusted-close') {
      selected[ticker] = cache.tickers[ticker];
    } else if (includeMissing) {
      selected[ticker] = { ticker, error: true, pending: true };
    }
  }
  return selected;
}

function getEasternMarketDay(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', hour12: false
  }).formatToParts(now);
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday,
    hour: Number(values.hour)
  };
}

function previousWeekday(date) {
  const cursor = new Date(`${date}T12:00:00Z`);
  do {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return cursor.toISOString().slice(0, 10);
}

function getTickerRefreshPolicy(now) {
  const eastern = getEasternMarketDay(now);
  const isWeekend = eastern.weekday === 'Sat' || eastern.weekday === 'Sun';
  const isClosePublicationWindow = !isWeekend && eastern.hour >= 20 && eastern.hour < 22;
  const expectedCloseDate = !isWeekend && eastern.hour >= 20
    ? eastern.date
    : previousWeekday(eastern.date);
  const retryDuration = isWeekend
    ? TICKER_WEEKEND_RETRY_DURATION
    : isClosePublicationWindow
      ? TICKER_CLOSE_RETRY_DURATION
      : TICKER_MISSING_DAY_RETRY_DURATION;
  return { expectedCloseDate, retryDuration };
}

function isTickerCacheStale(cache, config, now = getNow()) {
  const nowMs = now.getTime();
  const { expectedCloseDate, retryDuration } = getTickerRefreshPolicy(now);
  return config.tickers.some(({ ticker }) => {
    const cachedTicker = cache.tickers?.[ticker];
    if (!cachedTicker || cachedTicker.priceBasis !== 'adjusted-close') {
      const lastAttemptAt = tickerRefreshAttempts.get(ticker);
      return !lastAttemptAt || nowMs - lastAttemptAt >= retryDuration;
    }
    if (cachedTicker.regularCloseDate >= expectedCloseDate) return false;
    const updatedAt = Date.parse(cachedTicker.updatedAt || '');
    const lastAttemptAt = tickerRefreshAttempts.get(ticker) || 0;
    const lastCheckedAt = Math.max(Number.isFinite(updatedAt) ? updatedAt : 0, lastAttemptAt);
    return lastCheckedAt === 0 || nowMs - lastCheckedAt >= retryDuration;
  });
}

async function refreshTickerCache(config) {
  const cache = readTickerCache();
  const attemptedAt = getNow().getTime();
  config.tickers.forEach(({ ticker }) => {
    tickerRefreshAttempts.set(ticker, attemptedAt);
    tickerRefreshOutcomes.set(ticker, false);
  });
  const fetched = await fetchTickerAthData(config, cache.tickers || {});
  let changed = false;
  for (const { ticker } of config.tickers) {
    const candidate = fetched[ticker];
    if (candidate && !candidate.error) {
      cache.tickers[ticker] = candidate;
      tickerRefreshOutcomes.set(ticker, true);
      changed = true;
    }
  }
  if (changed) {
    cache.updatedAt = new Date().toISOString();
    writeTickerCache(cache);
  }
  return cache;
}

function queueTickerRefresh(config) {
  const configSignature = JSON.stringify(config.tickers);
  if (tickerRefreshPromise) {
    if (configSignature !== activeTickerConfigSignature) {
      queuedTickerConfig = JSON.parse(JSON.stringify(config));
    }
    return tickerRefreshPromise;
  }
  queuedTickerConfig = JSON.parse(JSON.stringify(config));

  tickerRefreshPromise = (async () => {
    let latest = readTickerCache();
    while (queuedTickerConfig) {
      const nextConfig = queuedTickerConfig;
      queuedTickerConfig = null;
      activeTickerConfigSignature = JSON.stringify(nextConfig.tickers);
      try {
        latest = await refreshTickerCache(nextConfig);
      } catch (error) {
        console.error('[Ticker ATH Background Refresh]:', error.message);
      }
    }
    return latest;
  })().finally(() => {
    tickerRefreshPromise = null;
    activeTickerConfigSignature = null;
  });
  return tickerRefreshPromise;
}

app.get('/api/ticker-ath', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    const config = readConfig();
    let cache = readTickerCache();
    const hasEveryTicker = config.tickers.every(({ ticker }) => cache.tickers?.[ticker]?.priceBasis === 'adjusted-close');
    const stale = isTickerCacheStale(cache, config);

    if (hasEveryTicker) {
      const refreshing = Boolean(tickerRefreshPromise) || stale;
      res.json({
        success: true,
        data: selectTickerData(cache, config),
        cached: true,
        stale,
        refreshing,
        updatedAt: cache.updatedAt
      });
      if (stale) setImmediate(() => { void queueTickerRefresh(config); });
      return;
    }

    // A newly-added ticker has no value to serve yet. Bootstrap it once; all
    // subsequent requests, including after a process restart, use disk first.
    cache = await queueTickerRefresh(config);
    res.json({
      success: true,
      data: selectTickerData(cache, config, true),
      cached: false,
      stale: isTickerCacheStale(cache, config),
      refreshing: false,
      updatedAt: cache.updatedAt
    });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 获取当前配置的标的列表
app.get('/api/settings/tickers', (req, res, next) => {
  try {
    const config = readConfig();
    res.json({ success: true, data: config.tickers });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 保存用户配置的标的列表
app.post('/api/settings/tickers', (req, res, next) => {
  try {
    const { tickers } = req.body;
    if (!Array.isArray(tickers)) {
      throw new InputError('无效的标的列表数据格式');
    }
    if (tickers.length < 1) {
      throw new InputError('至少需要追踪 1 个标的');
    }

    const cleanedTickers = tickers.map(e => {
      if (typeof e?.ticker !== 'string' || !e.ticker.trim()) {
        throw new InputError('标的代码不能为空');
      }
      const cleanTicker = e.ticker.trim().toUpperCase();
      // [Fix #1] 白名单校验：仅允许股票代码合法字符（字母、数字、连字符、点、脱字符），长度 1-20
      if (!/^[\^A-Z0-9.\-]{1,20}$/.test(cleanTicker)) {
        throw new InputError(`标的代码格式非法（只允许字母、数字、.-^符号）: ${cleanTicker}`);
      }
      return {
        ticker: cleanTicker
      };
    });

    const config = readConfig();
    config.tickers = cleanedTickers;
    writeConfig(config);

    void queueTickerRefresh(config);

    res.json({ success: true, message: '标的配置保存成功！', data: cleanedTickers });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

app.post('/api/ticker-ath/refresh', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    const config = readConfig();
    const cache = await queueTickerRefresh(config);
    const failedTickers = config.tickers
      .map(({ ticker }) => ticker)
      .filter(ticker => tickerRefreshOutcomes.get(ticker) !== true);
    res.json({
      success: true,
      data: selectTickerData(cache, config, true),
      refreshSuccess: failedTickers.length === 0,
      failedTickers,
      updatedAt: cache.updatedAt
    });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

  return { queueTickerRefresh };
}

module.exports = { registerTickerRoutes };
