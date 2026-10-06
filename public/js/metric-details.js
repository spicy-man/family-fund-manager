(function () {
  let closeCurrent = null;

  function calculateWorstYear(history) {
    const years = new Map();
    const resetYears = new Set();
    let segment = 0;
    for (const point of history) {
      const year = Number(point.date.slice(0, 4));
      if (point.totalShares <= 0) { segment++; resetYears.add(year); continue; }
      const entry = years.get(year);
      if (entry) entry.last = { ...point, segment };
      else years.set(year, { first: { ...point, segment }, last: { ...point, segment } });
    }
    const returns = [];
    for (const [year, { first, last }] of years) {
      if (resetYears.has(year)) continue;
      const start = first;
      // January 1 is shared by the preceding year's end and this year's start.
      const nextStart = years.get(year + 1)?.first;
      const end = nextStart?.date === `${year + 1}-01-01` ? nextStart : last;
      if (start.date === end.date || start.segment !== end.segment || start.navPerShare <= 0) continue;
      const value = end.navPerShare / start.navPerShare - 1;
      if (Number.isFinite(value)) returns.push(value);
    }
    return returns.length ? Math.min(...returns) : null;
  }

  function calculateRisk(history) {
    const months = new Map();
    let segment = 0;
    for (const point of history) {
      if (point.totalShares <= 0) segment++;
      if (point.type !== 'valuation' || point.totalShares <= 0) continue;
      const month = point.date.slice(0, 7);
      months.set(month, { ...point, segment }); // Replay order preserves the final valuation of each month.
    }
    const samples = [...months.values()];
    const latest = history.at(-1)?.date;
    const latestDate = latest ? new Date(`${latest}T00:00:00Z`) : null;
    const endsAtMonthEnd = latestDate && latestDate.getUTCDate() ===
      new Date(Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth() + 1, 0)).getUTCDate();
    const complete = samples.filter(point => point.date.slice(0, 7) !== latest?.slice(0, 7) || endsAtMonthEnd);
    const monthIndex = point => Number(point.date.slice(0, 4)) * 12 + Number(point.date.slice(5, 7));
    const returns = [];
    for (let i = 1; i < complete.length; i++) {
      const previous = complete[i - 1], current = complete[i];
      // Never treat a multi-month gap as a one-month return or fill it with zeroes.
      if (monthIndex(current) - monthIndex(previous) !== 1 || current.segment !== previous.segment || previous.navPerShare <= 0) continue;
      const value = current.navPerShare / previous.navPerShare - 1;
      if (Number.isFinite(value)) returns.push(value);
    }
    const result = { volatility: null, sharpe: null, sortino: null, monthlySamples: returns.length };
    if (returns.length < 12) return result;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const deviation = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1));
    // The target and risk-free rate are explicitly zero. Downside deviation uses all samples.
    const downside = Math.sqrt(returns.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / returns.length);
    result.volatility = deviation * Math.sqrt(12);
    if (deviation > 1e-12) result.sharpe = mean / deviation * Math.sqrt(12);
    if (downside > 1e-12) result.sortino = mean / downside * Math.sqrt(12);
    for (const key of ['volatility', 'sharpe', 'sortino']) {
      if (!Number.isFinite(result[key])) result[key] = null;
    }
    return result;
  }

  function calculate(history = []) {
    // Empty-fund NAV resets are accounting defaults, not strategy returns.
    const points = history.filter(point => point.totalShares > 0);
    const empty = { drawdown: null, annualized: null, worstYear: null, mar: null, start: null, end: null,
      volatility: null, sharpe: null, sortino: null, monthlySamples: 0 };
    if (!points.length || points.some(point => !Number.isFinite(point.navPerShare) || point.navPerShare < 0)) return empty;
    let peak = points[0].navPerShare;
    if (peak <= 0) return empty;
    let drawdown = 0;
    for (const point of points) {
      peak = Math.max(peak, point.navPerShare);
      drawdown = Math.max(drawdown, (peak - point.navPerShare) / peak);
    }
    const first = points[0], last = points.at(-1);
    const days = (Date.parse(last.date) - Date.parse(first.date)) / 86400000;
    const growth = days > 0 ? Math.pow(last.navPerShare / first.navPerShare, 365 / days) - 1 : null;
    const annualized = Number.isFinite(growth) ? growth : null;
    const ratio = annualized !== null && drawdown > 0 ? annualized / drawdown : null;
    return { drawdown, annualized, worstYear: calculateWorstYear(history), mar: Number.isFinite(ratio) ? ratio : null, start: first.date, end: last.date,
      ...calculateRisk(history) };
  }

  function render(history) {
    const stats = calculate(history);
    const percent = value => value === null ? '—' : `${(value * 100).toFixed(2)}%`;
    document.getElementById('nav-details-drawdown').textContent = percent(stats.drawdown);
    const annualized = document.getElementById('nav-details-annualized');
    annualized.textContent = stats.annualized > 0 ? `+${percent(stats.annualized)}` : percent(stats.annualized);
    annualized.className = `privacy-sensitive${stats.annualized === null ? '' : stats.annualized >= 0 ? ' text-green' : ' text-magenta'}`;
    document.getElementById('nav-details-mar').textContent = stats.mar === null ? '—' : stats.mar.toFixed(2);
    const worstYear = document.getElementById('nav-details-worst-year');
    worstYear.textContent = stats.worstYear > 0 ? `+${percent(stats.worstYear)}` : percent(stats.worstYear);
    worstYear.className = `privacy-sensitive${stats.worstYear === null ? '' : stats.worstYear >= 0 ? ' text-green' : ' text-magenta'}`;
    for (const key of ['sharpe', 'sortino']) {
      document.getElementById(`nav-details-${key}`).textContent = stats[key] === null ? '—' : stats[key].toFixed(2);
    }
    document.getElementById('nav-details-risk-samples').textContent = `月度收益样本：${stats.monthlySamples} 个`;
    document.getElementById('nav-details-period').textContent = stats.start
      ? `${stats.start} 至 ${stats.end} · 成立以来` : '暂无净值历史';
  }

  function bind(card, panel, closeButton) {
    const surface = panel.querySelector('.modal-content') || panel;
    let hideTimer;
    let suppressFocus = false;
    let animation = null;
    let isOpen = false;
    const canAnimate = () => surface.animate && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const animateDrawer = (opening, duration, onFinish) => {
      const styles = getComputedStyle(surface);
      const from = { opacity: Number(styles.opacity),
        transform: styles.transform || 'none' };
      animation?.cancel();
      const current = surface.animate([from, {
        opacity: opening ? 1 : 0,
        transform: opening ? 'translateY(0)' : 'translateY(-18px)'
      }], {
        duration, easing: 'cubic-bezier(.2, .75, .25, 1)', fill: 'both'
      });
      animation = current;
      current.onfinish = () => {
        if (animation !== current) return;
        onFinish?.();
        current.cancel();
        animation = null;
      };
    };
    const cancelHide = () => clearTimeout(hideTimer);
    const close = (restoreFocus = false) => {
      cancelHide();
      if (!isOpen) return;
      isOpen = false;
      panel.inert = true;
      if (canAnimate()) animateDrawer(false, 180, () => { panel.hidden = true; });
      else { animation?.cancel(); animation = null; panel.hidden = true; }
      panel.setAttribute('aria-hidden', 'true');
      card.setAttribute('aria-expanded', 'false');
      if (closeCurrent === close) closeCurrent = null;
      if (restoreFocus && panel.contains(document.activeElement)) {
        suppressFocus = true;
        card.focus({ preventScroll: true });
        suppressFocus = false;
      }
    };
    const position = () => {
      const anchor = card.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12));
      const below = anchor.bottom + 8;
      const top = below + bounds.height <= window.innerHeight - 12 ? below
        : Math.max(12, Math.min(anchor.top - bounds.height - 8, window.innerHeight - bounds.height - 12));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const show = () => {
      if (suppressFocus) return;
      cancelHide();
      if (isOpen) { position(); return; }
      if (closeCurrent && closeCurrent !== close) closeCurrent();
      closeCurrent = close;
      const wasHidden = panel.hidden;
      panel.hidden = false;
      panel.inert = false;
      isOpen = true;
      panel.setAttribute('aria-hidden', 'false');
      card.setAttribute('aria-expanded', 'true');
      position();
      if (canAnimate()) {
        // Fade the glass surface itself. An ancestor opacity below 1 creates a
        // backdrop root, leaving the SVG glass filter with an empty black input.
        if (wasHidden) {
          surface.style.opacity = '0';
          surface.style.transform = 'translateY(-18px)';
        }
        animateDrawer(true, 280);
        surface.style.opacity = '';
        surface.style.transform = '';
      } else { animation?.cancel(); animation = null; }
    };
    const scheduleHide = () => {
      cancelHide();
      hideTimer = setTimeout(() => {
        if (!card.contains(document.activeElement) && !panel.contains(document.activeElement)) close();
      }, 160);
    };
    card.addEventListener('mouseenter', show);
    card.addEventListener('mouseleave', scheduleHide);
    card.addEventListener('focusin', show);
    card.addEventListener('focusout', scheduleHide);
    // Touch devices retain a way to reveal details without hover.
    card.addEventListener('click', show);
    card.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      show();
      closeButton.focus({ preventScroll: true });
    });
    panel.addEventListener('mouseenter', cancelHide);
    panel.addEventListener('mouseleave', scheduleHide);
    panel.addEventListener('focusin', cancelHide);
    panel.addEventListener('focusout', scheduleHide);
    closeButton.addEventListener('click', () => close(true));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close(true); }
    });
    document.addEventListener('pointerdown', event => {
      if (!panel.hidden && !card.contains(event.target) && !panel.contains(event.target)) close();
    });
    window.addEventListener('resize', () => { if (!panel.hidden) position(); });
    window.addEventListener('scroll', event => {
      if (panel.hidden || panel.contains(event.target)) return;
      const anchor = card.getBoundingClientRect();
      if (anchor.bottom < 0 || anchor.top > window.innerHeight) close();
      else position();
    }, true);
  }

  window.FundMetricDetails = { calculate, render, bind };
})();
