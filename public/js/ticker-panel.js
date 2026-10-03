/**
 * Ticker 市场数据面板：独立于账本状态，便于单独维护和测试。
 */
const TICKER_REFRESH_POLL_INTERVAL = 1000;
const TICKER_REFRESH_MAX_POLLS = 30;
let tickerRefreshPollTimer = null;

window.FundTickerPanel = {
  async load({ container, api, ui, pollAttempt = 0 }) {
    if (!container) return;
    const { escapeHtml, formatMonthDay } = ui;

    if (tickerRefreshPollTimer) {
      clearTimeout(tickerRefreshPollTimer);
      tickerRefreshPollTimer = null;
    }

    try {
      const result = await api.getTickerAth();
      const data = result.data;
      const rows = Object.keys(data).map(ticker => {
        const item = data[ticker];
        const safeTicker = escapeHtml(ticker);

        if (item.error) {
          return `
            <tr class="ticker-table-error">
              <th scope="row" class="ticker-table-symbol">${safeTicker}</th>
              <td colspan="4">获取失败</td>
            </tr>`;
        }

        const safeLongName = escapeHtml(item.longName || item.name || ticker);
        const athDate = item.athDate ? formatMonthDay(item.athDate) : '--';
        const drawdownClass = item.drawdown >= 0 ? 'text-green' : 'text-magenta';
        const drawdownPrefix = item.drawdown > 0 ? '+' : '';
        const hasYtdChange = Number.isFinite(item.ytdChange);
        const ytdClass = hasYtdChange
          ? (item.ytdChange >= 0 ? 'text-green' : 'text-magenta')
          : '';
        const ytdPrefix = hasYtdChange && item.ytdChange > 0 ? '+' : '';
        const ytdText = hasYtdChange ? `${ytdPrefix}${item.ytdChange.toFixed(2)}%` : '--';

        return `
          <tr data-ticker="${safeTicker}">
            <th scope="row" class="ticker-table-symbol font-outfit">${safeTicker}</th>
            <td class="ticker-table-number ticker-table-ath font-outfit">$${item.ath.toFixed(2)}</td>
            <td class="ticker-table-number font-outfit">$${item.regularClose.toFixed(2)}</td>
            <td class="ticker-table-number ticker-table-drawdown ${drawdownClass} font-outfit">${drawdownPrefix}${item.drawdown.toFixed(2)}%</td>
            <td class="ticker-table-number ticker-table-ytd ${ytdClass} font-outfit">${ytdText}</td>
          </tr>`;
      }).join('');

      container.innerHTML = `
        <table class="ticker-table" aria-label="美股标的 ATH 追踪">
          <thead>
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col">ATH</th>
              <th scope="col">收盘</th>
              <th scope="col">回调幅度</th>
              <th scope="col">今年涨幅</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
      bindTickerTooltips(container, data, formatMonthDay);

      // The first request deliberately returns disk cache immediately while the
      // server refreshes Yahoo in the background. Follow that worker briefly so
      // the panel replaces the stale snapshot as soon as it is ready.
      if (result.refreshing && pollAttempt < TICKER_REFRESH_MAX_POLLS) {
        tickerRefreshPollTimer = setTimeout(() => {
          tickerRefreshPollTimer = null;
          void window.FundTickerPanel.load({
            container,
            api,
            ui,
            pollAttempt: pollAttempt + 1
          });
        }, TICKER_REFRESH_POLL_INTERVAL);
      }
    } catch (error) {
      // textContent keeps unexpected network error text out of HTML parsing.
      container.replaceChildren();
      const state = document.createElement('div');
      state.className = 'ticker-table-state error';
      state.textContent = `无法从服务器同步美股标的 ATH 历史数据：${error.message}`;
      container.appendChild(state);
    }
  }
};

function bindTickerTooltips(container, data, formatMonthDay) {
  const panel = container.closest('.ticker-ath-bar');
  if (!panel) return;

  let tooltip = panel.querySelector('.ticker-external-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'glass-tooltip chart-external-tooltip ticker-external-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    panel.appendChild(tooltip);
  }
  tooltip.classList.add('glass-tooltip');
  tooltip.style.opacity = '0';

  const hideTooltip = () => {
    tooltip.style.opacity = '0';
  };

  const fitDescriptionToTwoLines = description => {
    const panelInset = 12;
    const maxWidth = Math.max(176, panel.clientWidth - panelInset * 2);
    const minWidth = Math.min(200, maxWidth);

    tooltip.style.width = '';
    tooltip.style.maxWidth = '';
    description.style.fontSize = '';

    const getLineCount = () => {
      const range = document.createRange();
      range.selectNodeContents(description);
      return new Set(
        Array.from(range.getClientRects(), rect => Math.round(rect.top))
      ).size;
    };

    const initialLineCount = getLineCount();
    if (initialLineCount < 2) return;

    let tooltipWidth = tooltip.offsetWidth;

    if (initialLineCount === 2) {
      while (tooltipWidth - 8 >= minWidth) {
        const candidateWidth = tooltipWidth - 8;
        tooltip.style.width = `${candidateWidth}px`;
        if (getLineCount() > 2) {
          tooltip.style.width = `${tooltipWidth}px`;
          break;
        }
        tooltipWidth = candidateWidth;
      }
      return;
    }

    tooltip.style.width = `${tooltipWidth}px`;
    tooltip.style.maxWidth = `${maxWidth}px`;
    while (getLineCount() > 2 && tooltipWidth < maxWidth) {
      tooltipWidth = Math.min(tooltipWidth + 8, maxWidth);
      tooltip.style.width = `${tooltipWidth}px`;
    }

    let fontSize = Number.parseFloat(window.getComputedStyle(description).fontSize);
    let fitAttempts = 0;
    while (getLineCount() > 2 && fitAttempts < 48) {
      fontSize = Math.max(fontSize - 0.25, 1);
      description.style.fontSize = `${fontSize}px`;
      fitAttempts += 1;
    }
  };

  const alignValuesWithDescription = description => {
    const range = document.createRange();
    range.selectNodeContents(description);
    const lineRects = Array.from(range.getClientRects());
    const lineTops = new Set(lineRects.map(rect => Math.round(rect.top)));

    if (lineTops.size < 2) {
      tooltip.style.setProperty('--ticker-value-right-inset', '0px');
      return;
    }

    const descriptionRight = description.getBoundingClientRect().right;
    const textRight = lineRects.reduce(
      (rightmost, rect) => Math.max(rightmost, rect.right),
      Number.NEGATIVE_INFINITY
    );
    const rightInset = Number.isFinite(textRight)
      ? Math.max(0, descriptionRight - textRight)
      : 0;
    tooltip.style.setProperty('--ticker-value-right-inset', `${rightInset}px`);
  };

  const renderTooltip = item => {
    tooltip.replaceChildren();

    const title = document.createElement('div');
    title.className = 'chart-external-tooltip-title';
    const titleTicker = document.createElement('span');
    titleTicker.className = 'ticker-tooltip-symbol';
    titleTicker.textContent = `${item.ticker} ·`;
    const titleDescription = document.createElement('span');
    titleDescription.className = 'ticker-tooltip-description';
    titleDescription.textContent = item.longName || item.name || item.ticker;
    title.append(titleTicker, titleDescription);
    tooltip.appendChild(title);
    fitDescriptionToTwoLines(titleDescription);
    alignValuesWithDescription(titleDescription);

    [
      ['ATH', `$${item.ath.toFixed(2)}`, 'var(--color-primary)'],
      ['最新收盘', `$${item.regularClose.toFixed(2)}`, 'var(--color-cyan)'],
      ['回调幅度', `${item.drawdown > 0 ? '+' : ''}${item.drawdown.toFixed(2)}%`, item.drawdown >= 0 ? 'var(--color-green)' : 'var(--color-magenta)']
    ].forEach(([labelText, valueText, color]) => {
      const row = document.createElement('div');
      row.className = 'chart-external-tooltip-row';
      const marker = document.createElement('i');
      marker.className = 'chart-external-tooltip-marker';
      marker.style.setProperty('--tooltip-series-color', color);
      const label = document.createElement('span');
      label.textContent = labelText;
      const value = document.createElement('strong');
      value.textContent = valueText;
      row.append(marker, label, value);
      tooltip.appendChild(row);
    });

    const details = document.createElement('div');
    details.className = 'chart-external-tooltip-details';
    const formatFullDate = value => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
      return match ? `${match[1]}/${match[2]}/${match[3]}` : '--';
    };
    details.textContent = `ATH 日期：${formatFullDate(item.athDate)}\n收盘日期：${formatFullDate(item.regularCloseDate)}`;
    tooltip.appendChild(details);
    tooltip.dataset.ticker = item.ticker;
  };

  const positionTooltip = event => {
    const panelBounds = panel.getBoundingClientRect();
    const inset = 12;
    const halfHeight = Math.ceil(tooltip.offsetHeight / 2);
    const left = Math.min(Math.max(event.clientX - panelBounds.left + 14, inset), panel.clientWidth - tooltip.offsetWidth - inset);
    const top = Math.min(Math.max(event.clientY - panelBounds.top, inset + halfHeight), panel.clientHeight - halfHeight - inset);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.opacity = '1';


  };

  const showTooltip = (item, event) => {
    if (tooltip.dataset.ticker !== item.ticker) {
      renderTooltip(item);
    }
    positionTooltip(event);
  };

  container.querySelectorAll('tr[data-ticker]').forEach(row => {
    const item = data[row.dataset.ticker];
    if (!item || item.error) return;
    row.addEventListener('mouseenter', event => showTooltip(item, event));
    row.addEventListener('mousemove', event => showTooltip(item, event));
    row.addEventListener('mouseleave', hideTooltip);
  });
}
