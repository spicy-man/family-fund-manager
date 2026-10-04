// Build a snapshot for one calculation/refresh. Rebuild after source mutations;
// caching by object identity would miss in-place price updates.
function createDateLookup(values, isUsable = value => value != null) {
  const entries = Object.entries(values || {})
    .filter(([date, value]) => isUsable(value, date))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

  return {
    findBefore(date, inclusive = false) {
      let low = 0;
      let high = entries.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const candidate = entries[middle][0];
        if (candidate < date || (inclusive && candidate === date)) low = middle + 1;
        else high = middle;
      }
      if (low === 0) return null;
      const [matchedDate, value] = entries[low - 1];
      return { date: matchedDate, value };
    }
  };
}

module.exports = { createDateLookup };
