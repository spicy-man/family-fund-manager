/**
 * 图表与趋势统计渲染器。Chart.js 实例由调用方持有，避免模块私有状态。
 */
window.FundChartRenderer = {
  operationTypes: {
    deposit: { symbol: '↑', label: '入金', color: '#23845a' },
    withdraw: { symbol: '↓', label: '出金', color: '#c45b60' },
    transfer: { symbol: '⇄', label: '内部转让', color: '#62738b' },
    performance_settlement: { symbol: '◆', label: '业绩结算', color: '#a67b36' }
  },

  groupOperations(history, events = []) {
    const byId = new Map(events.map(event => [event.id, event]));
    const days = new Map();
    history.forEach((point, index) => {
      // Match the operation point on the curve, not a later same-day valuation.
      if (!this.operationTypes[point.type]) return;
      let day = days.get(point.date);
      if (!day) {
        day = { date: point.date, index, events: [] };
        days.set(point.date, day);
      }
      day.index = index;
      day.events.push(byId.get(point.eventId) || point);
    });
    return [...days.values()];
  },

  clusterOperations(days, scale, gap = 30) {
    const clusters = [];
    days.forEach(day => {
      const x = scale.getPixelForValue(day.index);
      const last = clusters.at(-1);
      if (last && x - last.firstX < gap) {
        last.days.push(day);
        last.lastX = x;
        // Anchor merged markers to the first date so neighbouring groups stay separated.
      } else {
        clusters.push({ x, firstX: x, lastX: x, days: [day] });
      }
    });
    return clusters;
  },

  operationTrackPlugin: {
    id: 'operationTrack',
    afterDestroy(chart) {
      clearTimeout(chart.$operationHideTimer);
      const container = chart.canvas?.parentElement;
      container?.querySelector('.chart-operation-track')?.remove();
      container?.querySelector('.chart-operation-tooltip')?.remove();
    },
    afterDraw(chart) {
      const model = chart.$operationTrack;
      const container = chart.canvas.parentElement;
      if (!model || !container || !chart.chartArea || !chart.scales.x) return;
      let track = container.querySelector('.chart-operation-track');
      if (!track) {
        track = document.createElement('div');
        track.className = 'chart-operation-track';
        track.setAttribute('role', 'group');
        track.setAttribute('aria-label', '图表操作轨道');
        container.appendChild(track);
      }
      const clusters = window.FundChartRenderer.clusterOperations(model.days, chart.scales.x);
      const y = chart.chartArea.bottom + 12;
      const key = JSON.stringify([model.version, chart.width, y, clusters.map(group => group.x)]);
      if (track.dataset.layout !== key) {
        track.dataset.layout = key;
        track.replaceChildren();
        chart.$activeOperation = null;
        track.style.top = `${y}px`;
        track.style.left = `${chart.chartArea.left}px`;
        track.style.width = `${chart.chartArea.right - chart.chartArea.left}px`;
        clusters.forEach(group => {
          const events = group.days.flatMap(day => day.events);
          const type = window.FundChartRenderer.operationTypes[events[0].type];
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'chart-operation-marker';
          button.style.left = `${group.x - chart.chartArea.left}px`;
          button.style.setProperty('--operation-color', events.length > 1 ? '#858b95' : type.color);
          button.textContent = events.length > 1 ? String(events.length) : type.symbol;
          const dates = group.days.map(day => day.date);
          button.setAttribute('aria-label', `${dates.join('、')}，${events.length} 笔操作：${[...new Set(events.map(event => window.FundChartRenderer.operationTypes[event.type].label))].join('、')}`);
          const show = () => {
            clearTimeout(chart.$operationHideTimer);
            chart.$activeOperation = group;
            const existing = container.querySelector('.chart-external-tooltip');
            if (existing) existing.style.opacity = '0';
            let tooltip = container.querySelector('.chart-operation-tooltip');
            if (!tooltip) {
              tooltip = document.createElement('div');
              tooltip.className = 'glass-tooltip chart-operation-tooltip';
              tooltip.setAttribute('role', 'tooltip');
              tooltip.addEventListener('mouseenter', () => clearTimeout(chart.$operationHideTimer));
              tooltip.addEventListener('mouseleave', () => {
                if (chart.$pinnedOperation) return;
                chart.$activeOperation = null; tooltip.hidden = true;
                chart.$operationTrack.renderStats(); chart.draw();
              });
              container.appendChild(tooltip);
            }
            tooltip.replaceChildren();
            group.days.forEach(day => {
              const title = document.createElement('div');
              title.className = 'chart-external-tooltip-title';
              title.textContent = `${day.date} · ${day.events.length} 笔操作`;
              tooltip.appendChild(title);
              day.events.forEach(event => {
                const row = document.createElement('div');
                row.className = 'chart-operation-detail privacy-sensitive';
                row.textContent = chart.$operationTrack.describe(event);
                tooltip.appendChild(row);
              });
            });
            tooltip.hidden = false;
            const position = window.FundChartRenderer.calculateTooltipPosition({
              caretX: group.x, caretY: y,
              tooltipWidth: tooltip.offsetWidth, tooltipHeight: tooltip.offsetHeight,
              containerWidth: container.clientWidth, containerHeight: container.clientHeight, inset: 12
            });
            tooltip.style.left = `${position.left}px`;
            // Keep the entire card above the marker, even beyond the chart bounds.
            tooltip.style.top = `${y - tooltip.offsetHeight - 16}px`;
            chart.$operationTrack.renderStats(group.days.at(-1).index);
            chart.draw();
          };
          const hide = () => {
            if (chart.$pinnedOperation === group) return;
            chart.$activeOperation = null;
            const tooltip = container.querySelector('.chart-operation-tooltip');
            if (tooltip) tooltip.hidden = true;
            chart.$operationTrack.renderStats();
            chart.draw();
          };
          button.addEventListener('mouseenter', show);
          button.addEventListener('mouseleave', () => { chart.$operationHideTimer = setTimeout(hide, 150); });
          button.addEventListener('focus', show);
          button.addEventListener('blur', () => { chart.$pinnedOperation = null; hide(); });
          button.addEventListener('click', () => {
            if (chart.$pinnedOperation === group) { chart.$pinnedOperation = null; hide(); }
            else { chart.$pinnedOperation = group; show(); }
          });
          button.addEventListener('keydown', event => {
            if (event.key === 'Escape') { chart.$pinnedOperation = null; hide(); }
          });
          track.appendChild(button);
        });
        chart.$pinnedOperation = null;
        const tooltip = container.querySelector('.chart-operation-tooltip');
        if (tooltip) tooltip.hidden = true;
      }
      const toggle = document.getElementById('chk-chart-operations');
      track.hidden = toggle ? !toggle.checked : false;
      if (track.hidden) {
        chart.$activeOperation = null;
        chart.$pinnedOperation = null;
        const tooltip = container.querySelector('.chart-operation-tooltip');
        if (tooltip) tooltip.hidden = true;
      }
      if (chart.$activeOperation) {
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.strokeStyle = chart.$operationTrack.dark ? 'rgba(203,213,225,.55)' : 'rgba(98,115,139,.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        chart.$activeOperation.days.forEach(day => {
          const x = chart.scales.x.getPixelForValue(day.index);
          ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        });
        ctx.restore();
      }
    }
  },

  allocationLabelsPlugin: {
    id: 'allocationLabels',
    beforeLayout(chart) {
      // Keep the legend out of the leader labels' way on narrow panels.
      const position = chart.width < 560 ? 'bottom' : 'right';
      chart.options.plugins.legend.position = position;
      if (chart.legend) {
        // Chart.js caches the legend's options separately during beforeUpdate.
        // Keep its orientation and layout box in sync on the first resize.
        chart.legend.options.position = position;
        chart.legend.position = position;
      }
    },
    afterDatasetsDraw(chart, _args, options) {
      if (options.empty) return;
      const values = chart.data.datasets[0].data;
      const total = values.reduce((sum, value) => sum + Number(value), 0);
      if (!(total > 0)) return;
      const { ctx, chartArea } = chart;
      const sides = [[], []];
      chart.getDatasetMeta(0).data.forEach((arc, index) => {
        if (!(values[index] > 0) || !chart.getDataVisibility(index)) return;
        const { x, y, startAngle, endAngle, outerRadius } = arc.getProps(
          ['x', 'y', 'startAngle', 'endAngle', 'outerRadius'], true
        );
        if (!(outerRadius > 0)) return;
        const angle = (startAngle + endAngle) / 2;
        const direction = Math.cos(angle) >= 0 ? 1 : -1;
        sides[direction === 1 ? 1 : 0].push({
          x: x + Math.cos(angle) * outerRadius,
          y: y + Math.sin(angle) * outerRadius,
          elbowX: x + direction * (outerRadius + 12),
          labelY: y + Math.sin(angle) * (outerRadius + 14),
          direction,
          text: `${(values[index] / total * 100).toFixed(2)}%`
        });
      });
      ctx.save();
      ctx.font = '600 12px Inter, sans-serif';
      ctx.fillStyle = chart.options.plugins.legend.labels.color;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.textBaseline = 'middle';
      const top = chartArea.top + 6;
      const bottom = chartArea.bottom - 6;
      sides.forEach(labels => {
        labels.sort((a, b) => a.labelY - b.labelY);
        const gap = Math.min(20, (bottom - top) / Math.max(1, labels.length - 1));
        // Separate nearby small slices, then pull the group back inside the canvas.
        labels.forEach((label, index) => {
          label.labelY = Math.max(top, label.labelY, index ? labels[index - 1].labelY + gap : top);
        });
        for (let index = labels.length - 1; index >= 0; index--) {
          labels[index].labelY = Math.min(labels[index].labelY,
            index === labels.length - 1 ? bottom : labels[index + 1].labelY - gap);
        }
        labels.forEach(label => {
          const textWidth = ctx.measureText(label.text).width;
          const rightEdge = chart.legend?.position === 'right' ? chart.legend.left - 8 : chart.width - 8;
          const endX = label.direction === 1
            ? Math.min(label.elbowX + 14, rightEdge - textWidth - 4)
            : Math.max(label.elbowX - 14, textWidth + 12);
          ctx.beginPath();
          ctx.moveTo(label.x, label.y);
          ctx.lineTo(label.elbowX, label.labelY);
          ctx.lineTo(endX, label.labelY);
          ctx.stroke();
          ctx.textAlign = label.direction === 1 ? 'left' : 'right';
          ctx.fillText(label.text, endX + label.direction * 4, label.labelY);
        });
      });
      ctx.restore();
    }
  },

  datasetOpacityPlugin: {
    id: 'trendDatasetOpacity',
    beforeDatasetDraw(chart, args) {
      const opacity = chart.data.datasets[args.index]?.$visibilityOpacity;
      if (!Number.isFinite(opacity)) return;
      chart.ctx.save();
      chart.ctx.globalAlpha *= opacity;
    },
    afterDatasetDraw(chart, args) {
      const opacity = chart.data.datasets[args.index]?.$visibilityOpacity;
      if (Number.isFinite(opacity)) chart.ctx.restore();
    }
  },

  animateDatasetVisibility(chart, datasetIndex, visible, options = {}) {
    const dataset = chart?.data?.datasets?.[datasetIndex];
    if (!dataset) return;

    const duration = options.duration ?? (visible ? 320 : 240);
    const currentVisible = chart.isDatasetVisible
      ? chart.isDatasetVisible(datasetIndex)
      : !dataset.hidden;
    const from = Number.isFinite(dataset.$visibilityOpacity)
      ? dataset.$visibilityOpacity
      : (currentVisible ? 1 : 0);
    const target = visible ? 1 : 0;
    const applyOpacity = opacity => {
      dataset.$setVisibilityOpacity?.(opacity);
      const renderedDataset = chart.getDatasetMeta?.(datasetIndex)?.dataset;
      if (renderedDataset?.options && dataset.backgroundColor !== undefined) {
        renderedDataset.options.backgroundColor = dataset.backgroundColor;
      }
      dataset.$visibilityOpacity = opacity;
    };

    chart.$datasetVisibilityAnimations ??= new Map();
    const previous = chart.$datasetVisibilityAnimations.get(datasetIndex);
    if (previous) previous.cancelled = true;

    const finish = token => {
      if (token?.cancelled) return;
      applyOpacity(1);
      delete dataset.$visibilityOpacity;
      chart.setDatasetVisibility(datasetIndex, visible);
      chart.update('none');
      chart.$datasetVisibilityAnimations.delete(datasetIndex);
      options.onComplete?.();
    };

    if (visible) {
      chart.setDatasetVisibility(datasetIndex, true);
      applyOpacity(from);
      chart.update('none');
    }

    if (duration <= 0 || from === target) {
      finish();
      return;
    }

    const token = { cancelled: false };
    chart.$datasetVisibilityAnimations.set(datasetIndex, token);
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    const requestFrame = globalThis.requestAnimationFrame
      || (callback => setTimeout(() => callback(now()), 16));
    const startedAt = now();

    const step = timestamp => {
      if (token.cancelled) return;
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      applyOpacity(from + (target - from) * eased);
      chart.draw();

      if (progress < 1) requestFrame(step);
      else finish(token);
    };
    requestFrame(step);
  },

  calculateTooltipPosition({
    caretX,
    caretY,
    tooltipWidth,
    tooltipHeight,
    containerWidth,
    containerHeight,
    inset = 12,
    gap = 14
  }) {
    const halfHeight = Math.ceil(tooltipHeight / 2);
    const maxLeft = Math.max(inset, containerWidth - tooltipWidth - inset);
    const maxTop = Math.max(inset + halfHeight, containerHeight - halfHeight - inset);
    const rightLeft = caretX + gap;
    const placement = rightLeft <= maxLeft ? 'right' : 'left';
    const preferredLeft = placement === 'right'
      ? rightLeft
      : caretX - tooltipWidth - gap;

    return {
      left: Math.min(Math.max(preferredLeft, inset), maxLeft),
      top: Math.min(Math.max(caretY, inset + halfHeight), maxTop),
      placement
    };
  },

  calculateTrendCutoff(activeTimeSlice, now = new Date()) {
    if (!activeTimeSlice || activeTimeSlice === 'ALL') return undefined;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const values = {};
    parts.forEach(part => { values[part.type] = part.value; });
    const easternDate = new Date(Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day)
    ));
    const shiftCalendarDate = (years, months) => {
      const targetMonth = new Date(Date.UTC(
        easternDate.getUTCFullYear() + years,
        easternDate.getUTCMonth() + months,
        1
      ));
      const lastDay = new Date(Date.UTC(
        targetMonth.getUTCFullYear(),
        targetMonth.getUTCMonth() + 1,
        0
      )).getUTCDate();
      return new Date(Date.UTC(
        targetMonth.getUTCFullYear(),
        targetMonth.getUTCMonth(),
        Math.min(easternDate.getUTCDate(), lastDay)
      ));
    };
    const offsets = {
      // YTD selects the calendar year starting from Jan 1st.
      YTD: () => new Date(Date.UTC(easternDate.getUTCFullYear(), 0, 1)),
      '1Y': () => shiftCalendarDate(-1, 0),
      '6M': () => shiftCalendarDate(0, -6),
      '3M': () => shiftCalendarDate(0, -3),
      '1M': () => shiftCalendarDate(0, -1)
    };
    return offsets[activeTimeSlice]?.().toISOString().slice(0, 10);
  },

  updateTheme({ theme, navTrendChart, memberAllocationChart, currentFilteredHistory, membersList, ui }) {
    const { getMemberAvatarColor, createChartGradient, getSeriesColors, hexToRgba } = ui;
    let isDarkTheme = false;
    if (theme === 'dark') {
      isDarkTheme = true;
    } else if (theme === 'light') {
      isDarkTheme = false;
    } else {
      // system
      isDarkTheme = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    // 设置在不同主题下图表的文字与线条颜色
    const labelColor = isDarkTheme ? 'rgba(255, 255, 255, 0.7)' : 'rgba(31, 41, 55, 0.7)';
    const axisColor = isDarkTheme ? 'rgba(255, 255, 255, 0.4)' : 'rgba(31, 41, 55, 0.6)';
    const gridColor = isDarkTheme ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)';
    const chartBgColor = isDarkTheme ? '#0f111a' : '#ffffff';

    if (navTrendChart) {
      if (navTrendChart.$operationTrack) navTrendChart.$operationTrack.dark = isDarkTheme;
      navTrendChart.options.plugins.legend.labels.color = labelColor;
      navTrendChart.options.scales.x.grid.color = gridColor;
      navTrendChart.options.scales.x.ticks.color = axisColor;
      navTrendChart.options.scales['y-nav'].grid.color = gridColor;
    const seriesColors = getSeriesColors();
    navTrendChart.options.scales['y-nav'].ticks.color = hexToRgba(seriesColors.nav, 0.7);
    navTrendChart.options.scales['y-nav'].title.color = hexToRgba(seriesColors.nav, 0.7);
    navTrendChart.options.scales['y-assets'].ticks.color = hexToRgba(seriesColors.assets, 0.7);
    navTrendChart.options.scales['y-assets'].title.color = hexToRgba(seriesColors.assets, 0.7);

      // 动态调整明暗主题下四条曲线的色值，彻底解决浅色模式下的低对比度问题
      const semanticStyles = getComputedStyle(document.body);
      const colors = {
        ...seriesColors,
        deposit: semanticStyles.getPropertyValue('--color-positive').trim(),
        withdraw: semanticStyles.getPropertyValue('--color-negative').trim(),
        transfer: seriesColors.nav
      };

      const getPointColorsList = (historyList, defaultColor) => {
        if (!historyList || historyList.length === 0) {
          return [defaultColor];
        }
        return historyList.map(h => {
          if (h.type === 'deposit') return colors.deposit;
          if (h.type === 'withdraw') return colors.withdraw;
          if (h.type === 'transfer') return colors.transfer;
          return defaultColor;
        });
      };

      if (navTrendChart.data.datasets[0]) {
        navTrendChart.data.datasets[0].borderColor = colors.assets;
        const ptColors = getPointColorsList(currentFilteredHistory, colors.assets);
        navTrendChart.data.datasets[0].pointBackgroundColor = ptColors;
        navTrendChart.data.datasets[0].pointBorderColor = ptColors;
        navTrendChart.data.datasets[0].pointHoverBackgroundColor = ptColors;
        navTrendChart.data.datasets[0].pointHoverBorderColor = ptColors;
      }
      if (navTrendChart.data.datasets[1]) {
        navTrendChart.data.datasets[1].borderColor = colors.nav;
        navTrendChart.data.datasets[1].pointBackgroundColor = colors.nav;
        navTrendChart.data.datasets[1].pointBorderColor = 'transparent';
        navTrendChart.data.datasets[1].pointHoverBackgroundColor = colors.nav;
        navTrendChart.data.datasets[1].pointHoverBorderColor = 'transparent';
        const ctxNav = document.getElementById('navTrendChart').getContext('2d');
        navTrendChart.data.datasets[1].backgroundColor = createChartGradient(ctxNav, hexToRgba(colors.nav, isDarkTheme ? 0.30 : 0.25), hexToRgba(colors.nav, 0));
      }
      if (navTrendChart.data.datasets[2]) {
        navTrendChart.data.datasets[2].borderColor = colors.sp500;
        navTrendChart.data.datasets[2].pointBackgroundColor = colors.sp500;
        navTrendChart.data.datasets[2].pointBorderColor = colors.sp500;
        navTrendChart.data.datasets[2].pointHoverBackgroundColor = colors.sp500;
        navTrendChart.data.datasets[2].pointHoverBorderColor = colors.sp500;
      }
      if (navTrendChart.data.datasets[3]) {
        navTrendChart.data.datasets[3].borderColor = colors.ndx;
        navTrendChart.data.datasets[3].pointBackgroundColor = colors.ndx;
        navTrendChart.data.datasets[3].pointBorderColor = colors.ndx;
        navTrendChart.data.datasets[3].pointHoverBackgroundColor = colors.ndx;
        navTrendChart.data.datasets[3].pointHoverBorderColor = colors.ndx;
      }
      if (navTrendChart.data.datasets[4]) {
        navTrendChart.data.datasets[4].borderColor = colors.custom;
        navTrendChart.data.datasets[4].pointBackgroundColor = colors.custom;
        navTrendChart.data.datasets[4].pointBorderColor = colors.custom;
        navTrendChart.data.datasets[4].pointHoverBackgroundColor = colors.custom;
        navTrendChart.data.datasets[4].pointHoverBorderColor = colors.custom;
      }
      if (navTrendChart.data.datasets[5]) {
        navTrendChart.data.datasets[5].borderColor = colors.custom2;
        navTrendChart.data.datasets[5].pointBackgroundColor = colors.custom2;
        navTrendChart.data.datasets[5].pointBorderColor = colors.custom2;
        navTrendChart.data.datasets[5].pointHoverBackgroundColor = colors.custom2;
        navTrendChart.data.datasets[5].pointHoverBorderColor = colors.custom2;
      }

      navTrendChart.update();
    }

    if (memberAllocationChart) {
      memberAllocationChart.options.plugins.legend.labels.color = labelColor;
      memberAllocationChart.data.datasets[0].borderColor = chartBgColor;

      // 扇区颜色始终与对应成员头像的底色一致。
      if (memberAllocationChart.data.datasets[0].backgroundColor && memberAllocationChart.data.datasets[0].backgroundColor.length > 0) {
        const firstColor = memberAllocationChart.data.datasets[0].backgroundColor[0];
        if (firstColor && !firstColor.startsWith('rgba(')) {
          const newColors = membersList.map((member, idx) => getMemberAvatarColor(member.id || member.name, isDarkTheme, idx).background);
          memberAllocationChart.data.datasets[0].backgroundColor = newColors;
        } else {
          const zeroColor = isDarkTheme ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
          memberAllocationChart.data.datasets[0].backgroundColor = memberAllocationChart.data.labels.map(() => zeroColor);
        }
      }

      memberAllocationChart.update();
    }
  },

  render({ state, members, settings, charts, elements, ui }) {
    const { activeTimeSlice } = settings;
    const { navTrendChart, memberAllocationChart } = charts;
    const {
      chkCompNav, chkCompAssets, chkCompSp500, chkCompNdx,
      chkCompCustom, chkCompCustom2, trendStatsGrid
    } = elements;
    const customCheckbox = chkCompCustom || { checked: false };
    const customCheckbox2 = chkCompCustom2 || { checked: false };
    const { formatMoney, isDarkTheme, createChartGradient, getMemberAvatarColor } = ui;
    const resolveMemberAvatarColor = getMemberAvatarColor || ((memberKey, dark, index) => ({
      background: (dark ? ['#31445B', '#5C4930', '#424A52', '#315541'] : ['#E8EEF7', '#F9EDD8', '#ECEFF1', '#E5F2EA'])[index % 4]
    }));
    const seriesColors = ui.getSeriesColors?.() || {
      assets: '#5a57cc', nav: '#2c61b6', sp500: '#f0bf3b', ndx: '#f38180',
      custom: '#18a999', custom2: '#9b6bdf'
    };
    if (!seriesColors.custom) seriesColors.custom = '#18a999';
    if (!seriesColors.custom2) seriesColors.custom2 = '#9b6bdf';
    const hexToRgba = ui.hexToRgba || ((color, alpha) => {
      const value = Number.parseInt(color.replace('#', ''), 16);
      return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
    });
    const history = state.charts.navHistory;
    const cutoff = this.calculateTrendCutoff(activeTimeSlice);
    let filtered = cutoff ? history.filter(item => item.date >= cutoff) : history;
    if (!filtered.length && history.length) filtered = [history.at(-1)];

    const base = filtered[0] || { navPerShare: 1, sp500NAV: 1, ndxNAV: 1, customNAV: 1, custom2NAV: 1 };
    const labels = filtered.length ? filtered.map(item => item.date) : ['尚未入金'];
    const nav = filtered.length ? filtered.map(item => Number((item.navPerShare / base.navPerShare).toFixed(4))) : [1];
    const assets = filtered.length ? filtered.map(item => item.totalNAV) : [0];
    const benchmarkSeries = (rawField, normalizedField, sourceDateField) => {
      if (!filtered.length) return [1];
      if (activeTimeSlice !== 'YTD') {
        return filtered.map(item => Number.isFinite(item[normalizedField]) && Number.isFinite(base[normalizedField]) && base[normalizedField] > 0
          ? Number((item[normalizedField] / base[normalizedField]).toFixed(4))
          : null);
      }

      const ytdYear = cutoff.slice(0, 4);
      const configuredAnchor = state.charts.benchmarkAnchors?.[ytdYear];
      const fallbackAnchor = filtered
        .filter(item => item[sourceDateField] && item[sourceDateField] <= cutoff && Number.isFinite(item[rawField]))
        .sort((a, b) => a[sourceDateField].localeCompare(b[sourceDateField]))
        .at(-1);
      const anchorValue = configuredAnchor?.[rawField] ?? fallbackAnchor?.[rawField];
      const anchorDate = configuredAnchor?.[`${rawField}PriceDate`] ?? fallbackAnchor?.[sourceDateField];
      if (!Number.isFinite(anchorValue)) {
        return filtered.map(item => Number.isFinite(item[normalizedField]) &&
          Number.isFinite(base[normalizedField]) && base[normalizedField] > 0
          ? Number((item[normalizedField] / base[normalizedField]).toFixed(4)) : null);
      }
      return filtered.map(item => {
        if (!Number.isFinite(item[rawField]) || !item[sourceDateField] || item[sourceDateField] < anchorDate) return null;
        return Number((item[rawField] / anchorValue).toFixed(4));
      });
    };
    const spx = benchmarkSeries('spx', 'sp500NAV', 'spxPriceDate');
    const ndx = benchmarkSeries('ndx', 'ndxNAV', 'ndxPriceDate');
    const custom = benchmarkSeries('customNAV', 'customNAV', 'customPriceDate');
    const custom2 = benchmarkSeries('custom2NAV', 'custom2NAV', 'custom2PriceDate');
    const customName = state.settings?.customBenchmark?.name || '自定义标的';
    const customName2 = state.settings?.customBenchmark2?.name || '自定义标的 2';
    const escapeLabel = value => String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    const safeCustomName = escapeLabel(customName);
    const safeCustomName2 = escapeLabel(customName2);

    const isYtd = activeTimeSlice === 'YTD';
    const calculate = (values, isYtdBenchmark = false) => {
      const clean = values.filter(value => Number.isFinite(value) && value > 0);
      if (!clean.length) return { gain: 0, drawdown: 0 };
      const baseValue = isYtdBenchmark ? 1.0 : clean[0];
      let peak = baseValue; let drawdown = 0;
      clean.forEach(value => { peak = Math.max(peak, value); drawdown = Math.min(drawdown, value / peak - 1); });
      return { gain: clean.at(-1) / baseValue - 1, drawdown };
    };
    const percent = value => `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
    const series = [
      { label: '单位净值', color: seriesColors.nav, values: nav, visible: chkCompNav.checked, isBenchmark: false },
      { label: '标普500指数', color: seriesColors.sp500, values: spx, visible: chkCompSp500.checked, isBenchmark: true },
      { label: '纳斯达克100指数', color: seriesColors.ndx, values: ndx, visible: chkCompNdx.checked, isBenchmark: true },
      { label: customName, safeLabel: safeCustomName, color: seriesColors.custom, values: custom, visible: customCheckbox.checked, isBenchmark: true },
      { label: customName2, safeLabel: safeCustomName2, color: seriesColors.custom2, values: custom2, visible: customCheckbox2.checked, isBenchmark: true }
    ];
    const renderStats = (activeIndex = null) => {
      series[0].visible = chkCompNav.checked;
      series[1].visible = chkCompSp500.checked;
      series[2].visible = chkCompNdx.checked;
      series[3].visible = customCheckbox.checked;
      series[4].visible = customCheckbox2.checked;
      const visible = series.filter(item => item.visible);
      trendStatsGrid.innerHTML = visible.length
        ? visible.map(item => {
          const isHover = Number.isInteger(activeIndex);
          const end = isHover ? Math.min(activeIndex, item.values.length - 1) : item.values.length - 1;
          const isYtdBenchmark = isYtd && item.isBenchmark;
          const stats = calculate(item.values.slice(0, end + 1), isYtdBenchmark);
          const dateText = isHover && labels[end] ? `截至 ${labels[end]}` : '全周期';
          return `<div class="trend-stat-card" style="--series-color:${item.color};">
            <div class="trend-stat-name">${item.safeLabel || item.label}</div>
            <div class="trend-stat-date ${isHover ? 'is-hovering' : 'is-resting'}">${dateText}</div>
            <div class="trend-stat-values">
              <span><em>区间收益</em><strong class="privacy-sensitive ${stats.gain >= 0 ? 'positive' : 'negative'}">${percent(stats.gain)}</strong></span>
              <span><em>最大回撤</em><strong class="privacy-sensitive negative">${percent(stats.drawdown)}</strong></span>
            </div>
          </div>`;
        }).join('')
        : '<div class="trend-stat-empty">勾选上方指标后显示区间涨幅与最大回撤</div>';
    };
    renderStats();

    const dark = isDarkTheme(settings.theme);
    const navCanvas = document.getElementById('navTrendChart');
    const navCtx = navCanvas.getContext('2d');

    // 动态生成高通透度 Apple 风格多阶渐变
    const navGradient = createChartGradient(navCtx, hexToRgba(seriesColors.nav, dark ? 0.36 : 0.30), hexToRgba(seriesColors.nav, 0));

    const datasets = [
      {
        label: '基金总资产',
        data: assets,
        borderColor: seriesColors.assets,
        borderWidth: 1.8,
        borderDash: [8, 6],
        fill: false,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: seriesColors.assets,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-assets',
        hidden: !chkCompAssets.checked
      },
      {
        label: '单位净值',
        data: nav,
        borderColor: seriesColors.nav,
        borderWidth: 2.8,
        backgroundColor: navGradient,
        fill: true,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 7,
        pointHoverBackgroundColor: seriesColors.nav,
        pointHoverBorderColor: '#ffffff',
        pointHoverBorderWidth: 2,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-nav',
        hidden: !chkCompNav.checked
      },
      {
        label: '标普500指数',
        data: spx,
        borderColor: seriesColors.sp500,
        borderWidth: 1.8,
        fill: false,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-nav',
        hidden: !chkCompSp500.checked
      },
      {
        label: '纳斯达克100指数',
        data: ndx,
        borderColor: seriesColors.ndx,
        borderWidth: 1.8,
        fill: false,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-nav',
        hidden: !chkCompNdx.checked
      },
      {
        label: customName,
        data: custom,
        borderColor: seriesColors.custom,
        borderWidth: 1.8,
        fill: false,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-nav',
        hidden: !customCheckbox.checked
      },
      {
        label: customName2,
        data: custom2,
        borderColor: seriesColors.custom2,
        borderWidth: 1.8,
        fill: false,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        yAxisID: 'y-nav',
        hidden: !customCheckbox2.checked
      }
    ];
    const navFillAlpha = dark ? 0.36 : 0.30;
    datasets[1].$setVisibilityOpacity = function setVisibilityOpacity(opacity) {
      this.backgroundColor = createChartGradient(
        navCtx,
        hexToRgba(seriesColors.nav, navFillAlpha * opacity),
        hexToRgba(seriesColors.nav, 0)
      );
    };

    const generateTrendLegendLabels = chart => {
      const labels = Chart.defaults.plugins.legend.labels.generateLabels(chart);
      return labels.map(label => {
        const seriesColor = chart.data.datasets[label.datasetIndex]?.borderColor;
        return seriesColor
          ? { ...label, fillStyle: seriesColor, strokeStyle: seriesColor }
          : label;
      });
    };

    const chartAnimation = {
      duration: 380,
      easing: 'easeOutQuart'
    };

    const tooltipTheme = {
      backgroundColor: dark ? 'rgba(18, 20, 32, 0.92)' : 'rgba(255, 255, 255, 0.94)',
      titleColor: dark ? '#ffffff' : '#0f172a',
      bodyColor: dark ? '#e2e8f0' : '#334155',
      borderColor: dark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
      borderWidth: 1,
      padding: 12,
      cornerRadius: 12,
      boxPadding: 4,
      usePointStyle: false,
      boxWidth: 3,
      boxHeight: 18,
      titleFont: { size: 12, weight: '700', family: 'Outfit, sans-serif' },
      bodyFont: { size: 11, weight: '500', family: 'Inter, sans-serif' }
    };

    const gridColor = dark ? 'rgba(255, 255, 255, 0.055)' : 'rgba(42, 61, 82, 0.075)';
    const tickColor = dark ? 'rgba(255, 255, 255, 0.46)' : 'rgba(42, 61, 82, 0.52)';
    const formatTrendAxisDate = function formatTrendAxisDate(value) {
      const label = this.getLabelForValue?.(value) || '';
      const parts = String(label).split('-').map(Number);
      if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return label;
      return `${parts[1]}月${parts[2]}日`;
    };
    const externalTooltip = ({ chart, tooltip }) => {
      const container = chart.canvas.parentElement;
      if (!container) return;
      let element = container.querySelector('.chart-external-tooltip');
      if (!element) {
        element = document.createElement('div');
        element.className = 'glass-tooltip chart-external-tooltip';
        element.setAttribute('role', 'tooltip');
        container.appendChild(element);
      }
      element.classList.add('glass-tooltip');
      if (tooltip.opacity === 0) {
        element.style.opacity = '0';
        return;
      }

      element.replaceChildren();
      const title = document.createElement('div');
      title.className = 'chart-external-tooltip-title';
      title.textContent = tooltip.title?.[0] || '';
      element.appendChild(title);
      if (chart.config.type === 'doughnut') {
        const point = tooltip.dataPoints[0];
        const value = point.parsed;
        const share = total > 0 ? (value / total * 100).toFixed(2) : '0.00';
        const color = point.dataset.backgroundColor[point.dataIndex];
        [['占比', `${share}%`], ['价值', `$${formatMoney(value)}`]].forEach(([labelText, valueText]) => {
          const row = document.createElement('div');
          row.className = 'chart-external-tooltip-row';
          const marker = document.createElement('i');
          marker.className = 'chart-external-tooltip-marker';
          marker.style.setProperty('--tooltip-series-color', color);
          const label = document.createElement('span');
          label.textContent = labelText;
          const valueElement = document.createElement('strong');
          valueElement.textContent = valueText;
          row.append(marker, label, valueElement);
          element.appendChild(row);
        });
      } else {
      tooltip.dataPoints.forEach(point => {
        const row = document.createElement('div');
        row.className = 'chart-external-tooltip-row';
        const marker = document.createElement('i');
        marker.className = 'chart-external-tooltip-marker';
        marker.style.setProperty('--tooltip-series-color', point.dataset.borderColor);
        const label = document.createElement('span');
        label.textContent = point.dataset.label;
        const value = document.createElement('strong');
        value.textContent = point.datasetIndex === 0 ? `$${formatMoney(point.parsed.y)}` : point.parsed.y.toFixed(3);
        row.append(marker, label, value);
        element.appendChild(row);
      });
      }
      if (tooltip.afterBody?.length) {
        const details = document.createElement('div');
        details.className = 'chart-external-tooltip-details';
        details.textContent = tooltip.afterBody.join('\n');
        element.appendChild(details);
      }
      const inset = 12;
      const { left, top, placement } = window.FundChartRenderer.calculateTooltipPosition({
        caretX: tooltip.caretX,
        caretY: tooltip.caretY,
        tooltipWidth: element.offsetWidth,
        tooltipHeight: element.offsetHeight,
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
        inset
      });
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.dataset.placement = placement;
      element.style.opacity = '1';
    };

    let nextNav = navTrendChart;
    if (nextNav) {
      nextNav.data.labels = labels;
      nextNav.data.datasets.forEach((dataset, index) => { Object.assign(dataset, datasets[index]); });
      nextNav.options.scales['y-assets'].display = chkCompAssets.checked;
      nextNav.options.scales.x.grid.color = gridColor;
      nextNav.options.scales.x.ticks.color = tickColor;
      nextNav.options.scales['y-nav'].grid.color = gridColor;
      nextNav.options.scales['y-nav'].ticks.color = hexToRgba(seriesColors.nav, 0.8);
      nextNav.options.scales['y-nav'].title.color = hexToRgba(seriesColors.nav, 0.9);
      nextNav.options.scales['y-assets'].ticks.color = hexToRgba(seriesColors.assets, 0.8);
      nextNav.options.scales['y-assets'].title.color = hexToRgba(seriesColors.assets, 0.9);
      nextNav.options.plugins.legend.labels.generateLabels = generateTrendLegendLabels;
      nextNav.options.animation = chartAnimation;
      Object.assign(nextNav.options.plugins.tooltip, tooltipTheme);
      nextNav.options.plugins.tooltip.enabled = false;
      nextNav.options.plugins.tooltip.external = externalTooltip;
      nextNav.update();
    } else {
      nextNav = new Chart(navCtx, {
        type: 'line',
        data: { labels, datasets },
        plugins: [window.FundChartRenderer.datasetOpacityPlugin, window.FundChartRenderer.operationTrackPlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: chartAnimation,
          layout: { padding: { right: 14 } },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: false,
              labels: {
                color: dark ? 'rgba(255, 255, 255, 0.8)' : 'rgba(0, 0, 0, 0.7)',
                font: { size: 11, weight: '600', family: 'Inter, sans-serif' },
                usePointStyle: true,
                boxWidth: 8,
                boxHeight: 8,
                padding: 14,
                generateLabels: generateTrendLegendLabels
              }
            },
            tooltip: {
              ...tooltipTheme,
              enabled: false,
              external: externalTooltip,
              mode: 'index',
              intersect: false,
              callbacks: {
                label(context) {
                  return context.datasetIndex === 0
                    ? ` ${context.dataset.label}: $${formatMoney(context.parsed.y)}`
                    : ` ${context.dataset.label}: ${context.parsed.y.toFixed(3)}`;
                },
                labelColor(context) {
                  return { borderColor: context.dataset.borderColor, backgroundColor: context.dataset.borderColor, borderWidth: 0 };
                }
              }
            }
          },
          scales: {
            x: {
              border: { display: false },
              grid: { display: false, drawTicks: false },
              ticks: {
                color: tickColor,
                font: { size: 10, family: 'Inter, sans-serif' },
                autoSkip: true,
                autoSkipPadding: 28,
                maxTicksLimit: 7,
                maxRotation: 0,
                minRotation: 0,
                padding: 26,
                callback: formatTrendAxisDate
              }
            },
            'y-nav': {
              position: 'left',
              border: { display: false },
              grid: { color: gridColor, drawTicks: false },
              ticks: {
                color: hexToRgba(seriesColors.nav, 0.72),
                font: { family: 'Outfit, sans-serif', size: 10 },
                maxTicksLimit: 5,
                padding: 10,
                callback: value => value.toFixed(2)
              },
              title: { display: true, text: '单位净值', color: hexToRgba(seriesColors.nav, 0.9), font: { size: 11, weight: '600' } }
            },
            'y-assets': {
              position: 'right',
              display: chkCompAssets.checked,
              border: { display: false },
              grid: { display: false, drawOnChartArea: false, drawTicks: false },
              ticks: {
                color: hexToRgba(seriesColors.assets, 0.72),
                font: { family: 'Outfit, sans-serif', size: 10 },
                maxTicksLimit: 5,
                padding: 10,
                callback: value => `$${formatMoney(value)}`
              },
              title: { display: true, text: '总资产 (USD)', color: hexToRgba(seriesColors.assets, 0.9), font: { size: 11, weight: '600' } }
            }
          }
        }
      });
    }
    const memberName = id => members.find(member => member.id === id)?.name || '未知成员';
    clearTimeout(nextNav.$operationHideTimer);
    nextNav.$operationTrack = {
      version: this.operationTrackVersion = (this.operationTrackVersion || 0) + 1,
      days: this.groupOperations(filtered, state.events), dark, renderStats,
      describe: event => {
        const type = this.operationTypes[event.type];
        const person = event.type === 'transfer'
          ? `${memberName(event.fromMember)} → ${memberName(event.toMember)}`
          : memberName(event.type === 'performance_settlement' ? event.gpMember : event.member);
        const amount = event.type === 'performance_settlement'
          ? event._totalFee ?? event.snapshot?.totalFee ?? 0
          : event.amount;
        const details = [person, `$${formatMoney(amount)}`];
        if (event.cnhAmount) details.push(`¥${formatMoney(event.cnhAmount)}`);
        const lines = [`${type.symbol} ${type.label}`, details.join(' · ')];
        if (event.remark) lines.push(event.remark);
        return lines.join('\n');
      }
    };
    nextNav.draw();
    const operationToggle = document.getElementById('chk-chart-operations');
    if (operationToggle) operationToggle.onchange = () => { renderStats(); nextNav.draw(); };
    nextNav.options.onHover = (_event, active) => {
      nextNav.$activeOperation = null;
      nextNav.$pinnedOperation = null;
      const tooltip = navCanvas.parentElement?.querySelector('.chart-operation-tooltip');
      if (tooltip) tooltip.hidden = true;
      renderStats(active.length ? active[0].index : null);
    };
    nextNav.options.plugins.tooltip.callbacks.afterBody = context => {
      if (!context?.length) return [];
      const event = filtered[context[0].dataIndex];
      if (!event || event.type === 'valuation') return [];
      const name = id => members.find(member => member.id === id)?.name || '未知';
      const lines = ['---------------------'];
      if (event.type === 'deposit') lines.push('入金详情：', `   出资人: ${name(event.member)}`, `   金额: $${formatMoney(event.amount)}`);
      if (event.type === 'withdraw') lines.push('出金详情：', `   提取人: ${name(event.member)}`, `   金额: $${formatMoney(event.amount)}`);
      if (event.type === 'transfer') lines.push('转让详情：', `   从: ${name(event.fromMember)} 至: ${name(event.toMember)}`, `   金额: $${formatMoney(event.amount)}`);
      if (event.cnhAmount) lines.push(`   折合人民币: ¥${formatMoney(event.cnhAmount)}`);
      if (event.cnhRate) lines.push(`   受让汇率: ${event.cnhRate.toFixed(4)}`);
      if (event.remark) lines.push(`   备注: ${event.remark}`);
      return lines;
    };
    navCanvas._restoreTrendStats = () => renderStats();
    if (!navCanvas.dataset.trendStatsLeaveBound) {
      navCanvas.addEventListener('mouseleave', () => navCanvas._restoreTrendStats());
      navCanvas.dataset.trendStatsLeaveBound = 'true';
    }

    const values = members.map(member => state.members[member.id]?.currentValue || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    const empty = total === 0;
    const colors = empty ? members.map(() => dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)') : members.map((member, index) => resolveMemberAvatarColor(member.id || member.name, dark, index).background);
    const shareCanvas = document.getElementById('memberAllocationChart');
    let nextAllocation = memberAllocationChart;
    if (nextAllocation) {
      Object.assign(nextAllocation.data, { labels: members.map(member => member.name) });
      Object.assign(nextAllocation.data.datasets[0], { data: empty ? members.map(() => 1) : values, backgroundColor: colors });
      Object.assign(nextAllocation.options.plugins.tooltip, tooltipTheme, { enabled: false, external: externalTooltip });
      nextAllocation.options.plugins.allocationLabels = { empty };
      nextAllocation.options.animation = false;
      nextAllocation.update('none');
    } else {
      nextAllocation = new Chart(shareCanvas.getContext('2d'), {
        type: 'doughnut',
        plugins: [window.FundChartRenderer.allocationLabelsPlugin],
        data: {
          labels: members.map(member => member.name),
          datasets: [{ data: empty ? members.map(() => 1) : values, backgroundColor: colors, borderWidth: 3, hoverOffset: 10 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, cutout: '70%',
          layout: { padding: { left: 64, right: 64, top: 18, bottom: 18 } },
          plugins: {
            allocationLabels: { empty },
            legend: { position: 'right', labels: { color: dark ? 'rgba(255,255,255,.7)' : 'rgba(31,41,55,.7)', font: { size: 11, weight: '500' } } },
            tooltip: { ...tooltipTheme, enabled: false, external: externalTooltip }
          }
        }
      });
    }
    return {
      navTrendChart: nextNav,
      memberAllocationChart: nextAllocation,
      filteredHistory: filtered,
      trendSeries: series,
      renderTrendStats: renderStats
    };
  }
};
