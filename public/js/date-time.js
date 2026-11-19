(function () {
  function getEasternParts(now = new Date(), includeTime = false) {
    const options = {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    };
    if (includeTime) Object.assign(options, {
      hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
    });
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
    const values = {};
    parts.forEach(part => { values[part.type] = part.value; });
    return values;
  }

  // Dual-timezone contract:
  // - Market/valuation/chart range dates use US Eastern (`America/New_York`).
  // - Ledger settlement caps & member statement "today" use Beijing (`Asia/Shanghai`).
  function getMarketEasternDate(now = new Date()) {
    const parts = getEasternParts(now, false);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function getLedgerBeijingDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const values = {};
    parts.forEach(part => { values[part.type] = part.value; });
    return `${values.year}-${values.month}-${values.day}`;
  }

  function getLatestValuationDate(now = new Date()) {
    const values = getEasternParts(now, true);
    const cursor = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
    const minutes = Number(values.hour) * 60 + Number(values.minute);
    if (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6 || minutes < 4 * 60 + 5) {
      do {
        cursor.setUTCDate(cursor.getUTCDate() - 1);
      } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
    }
    return cursor.toISOString().split('T')[0];
  }

  function startClock(element) {
    if (!element) return;
    const update = () => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, hourCycle: 'h23', timeZoneName: 'short'
      }).formatToParts(new Date());
      const values = {};
      parts.forEach(part => { values[part.type] = part.value; });
      element.textContent = `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} ${values.timeZoneName}`;
    };
    update();
    window.setInterval(update, 1000);
  }

  function parseCompactDate(raw) {
    if (!raw) return '';
    const trimmed = String(raw).trim();
    const isoMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(trimmed);
    const digits = isoMatch
      ? `${isoMatch[1]}${isoMatch[2].padStart(2, '0')}${isoMatch[3].padStart(2, '0')}`
      : trimmed.replace(/\D/g, '');
    if (digits.length !== 8) return '';
    const year = Math.min(2099, Math.max(1970, Number(digits.slice(0, 4))));
    const month = Math.min(12, Math.max(1, Number(digits.slice(4, 6))));
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = Math.min(maxDay, Math.max(1, Number(digits.slice(6, 8))));
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function snapToNearestSunday(dateStr) {
    const normalized = parseCompactDate(dateStr) || (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : '');
    if (!normalized) return '';
    const cursor = new Date(`${normalized}T00:00:00Z`);
    if (Number.isNaN(cursor.getTime())) return '';
    const day = cursor.getUTCDay();
    if (day !== 0) {
      // Nearest Sunday: Mon-Wed (1-3) snap back to previous Sunday; Thu-Sat (4-6) snap forward to upcoming Sunday.
      cursor.setUTCDate(cursor.getUTCDate() + (day >= 4 ? 7 - day : -day));
    }
    return cursor.toISOString().split('T')[0];
  }

  function snapToValuationDate(dateStr, latestDateStr = getLatestValuationDate()) {
    const normalized = parseCompactDate(dateStr) || (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : '');
    if (!normalized) return '';
    if (latestDateStr && normalized > latestDateStr) return latestDateStr;
    const cursor = new Date(`${normalized}T00:00:00Z`);
    if (Number.isNaN(cursor.getTime())) return '';
    while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    const snapped = cursor.toISOString().split('T')[0];
    return latestDateStr && snapped > latestDateStr ? latestDateStr : snapped;
  }

  function enhanceDateInput(input, snapFn) {
    if (!input || input.dataset?.dateEnhanced === 'true') return;
    if (input.dataset) input.dataset.dateEnhanced = 'true';
    let lastValidIso = input.value || '';
    let keepNativePicker = false;

    const toDigits = value => {
      const parsed = parseCompactDate(value);
      return parsed ? parsed.replace(/-/g, '') : String(value || '').replace(/\D/g, '').slice(0, 8);
    };

    const enterEditMode = event => {
      if (input.disabled || input.readOnly) return;
      if (event?.type === 'pointerdown') {
        const rect = typeof input.getBoundingClientRect === 'function' ? input.getBoundingClientRect() : null;
        // Clicking the right-edge calendar icon area (last 34px) keeps native date picker behavior.
        keepNativePicker = Boolean(rect && rect.width > 60 && Number.isFinite(event.clientX) && event.clientX >= rect.right - 34);
        if (keepNativePicker) return;
      } else if (event?.type === 'focus' && keepNativePicker) {
        keepNativePicker = false;
        return;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(input.value)) lastValidIso = input.value;
      if (input.type === 'date') {
        const digits = toDigits(input.value || lastValidIso);
        input.type = 'text';
        input.inputMode = 'numeric';
        input.maxLength = 10;
        input.placeholder = 'YYYYMMDD';
        input.value = digits;
        window.requestAnimationFrame?.(() => input.select?.());
      }
    };

    const exitEditMode = () => {
      const raw = input.value;
      const parsed = parseCompactDate(raw) || lastValidIso;
      const snapped = parsed ? (snapFn ? snapFn(parsed) : parsed) : '';
      const finalIso = snapped || parsed || '';
      if (finalIso) lastValidIso = finalIso;
      if (input.type === 'text') {
        input.type = 'date';
      }
      if (finalIso && input.value !== finalIso) {
        input.value = finalIso;
      }
      input.setCustomValidity?.('');
      return input.value;
    };

    input.addEventListener?.('pointerdown', enterEditMode);
    input.addEventListener?.('focus', enterEditMode);
    input.addEventListener?.('input', () => {
      if (input.type === 'text') {
        const cleaned = input.value.replace(/[^\d-/.]/g, '');
        if (cleaned !== input.value) input.value = cleaned;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(input.value)) {
        lastValidIso = input.value;
      }
      input.setCustomValidity?.('');
    });
    input.addEventListener?.('keydown', event => {
      if (event.key === 'Enter') {
        exitEditMode();
      } else if (event.key === 'Escape' && input.type === 'text') {
        event.preventDefault?.();
        event.stopPropagation?.();
        input.value = lastValidIso;
        exitEditMode();
      }
    });
    input.addEventListener?.('blur', () => {
      const before = lastValidIso;
      const after = exitEditMode();
      if (after && after !== before && typeof Event === 'function') {
        input.dispatchEvent?.(new Event('input', { bubbles: true }));
        input.dispatchEvent?.(new Event('change', { bubbles: true }));
      }
    });
    input.addEventListener?.('change', () => {
      if (input.type === 'text') return;
      exitEditMode();
    });
  }

  function setDefaultDates({ transactionDate, valuationDate, transferDate, settlementDate }) {
    const today = getMarketEasternDate();
    const latestSunday = new Date(`${today}T00:00:00Z`);
    latestSunday.setUTCDate(latestSunday.getUTCDate() - latestSunday.getUTCDay());
    transactionDate.value = latestSunday.toISOString().split('T')[0];
    const latestValuation = getLatestValuationDate();
    valuationDate.max = latestValuation;
    valuationDate.value = latestValuation;
    if (transferDate) transferDate.value = latestSunday.toISOString().split('T')[0];
    if (settlementDate) {
      settlementDate.value = today;
      enhanceDateInput(settlementDate);
    }
  }

  window.FundDateTime = {
    getEasternParts,
    getMarketEasternDate,
    getLedgerBeijingDate,
    getLatestValuationDate,
    parseCompactDate,
    snapToNearestSunday,
    snapToValuationDate,
    enhanceDateInput,
    startClock,
    setDefaultDates
  };
})();
