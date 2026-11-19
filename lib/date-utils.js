/**
 * Shared backend date & dual-timezone utilities.
 *
 * Dual-timezone contract:
 * - US Eastern (`America/New_York`): market closes, ticker refresh windows,
 *   and valuation date cutoffs (same-day valuation opens at 04:05 ET).
 * - Beijing (`Asia/Shanghai`): ledger settlement date ceiling and ongoing
 *   potential performance-fee estimation ("today").
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(date) {
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function isSundayDate(date) {
  if (!isValidDate(date)) return false;
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
}

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function previousWeekday(date) {
  let candidate = addUtcDays(date, -1);
  while ([0, 6].includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) {
    candidate = addUtcDays(candidate, -1);
  }
  return candidate;
}

function getEasternParts(now = new Date(), { includeTime = false, includeWeekday = false } = {}) {
  const options = {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  };
  if (includeWeekday) options.weekday = 'short';
  if (includeTime) {
    Object.assign(options, { hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' });
  }
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return values;
}

function getMarketEasternDate(now = new Date()) {
  const parts = getEasternParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getLatestValuationDate(now = new Date()) {
  const values = getEasternParts(now, { includeTime: true });
  const cursor = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  if (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6 || minutes < 4 * 60 + 5) {
    do {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  }
  return cursor.toISOString().slice(0, 10);
}

function getLedgerBeijingDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const values = {};
  parts.forEach(part => { values[part.type] = part.value; });
  return `${values.year}-${values.month}-${values.day}`;
}

module.exports = {
  DATE_PATTERN,
  isValidDate,
  isSundayDate,
  addUtcDays,
  previousWeekday,
  getEasternParts,
  getMarketEasternDate,
  getLatestValuationDate,
  getLedgerBeijingDate
};
