/**
 * 图表与趋势统计渲染器。Chart.js 实例由调用方持有，避免模块私有状态。
 * 自定义 Chart.js 插件已抽离至 `public/js/chart-plugins.js` (`window.FundChartPlugins`)，
 * 此处保留同名属性引用以兼容现有调用方与测试。
 */
const chartPlugins = window.FundChartPlugins || {};

window.FundChartRenderer = {
  operationTypes: chartPlugins.operationTypes,
  groupOperations: chartPlugins.groupOperations,
  clusterOperations: chartPlugins.clusterOperations,
  operationTrackPlugin: chartPlugins.operationTrackPlugin,
  allocationLabelsPlugin: chartPlugins.allocationLabelsPlugin,
  datasetOpacityPlugin: chartPlugins.datasetOpacityPlugin,

  getChartThemePalette(dark, seriesColors, hexToRgba) {
    return {
      dark,
      labelColor: dark ? 'rgba(255, 255, 255, 0.7)' : 'rgba(31, 41, 55, 0.7)',
      tickColor: dark ? 'rgba(255, 255, 255, 0.46)' : 'rgba(42, 61, 82, 0.52)',
      gridColor: dark ? 'rgba(255, 255, 255, 0.055)' : 'rgba(42, 61, 82, 0.075)',
      chartBgColor: dark ? '#0f111a' : '#ffffff',
      navFillAlpha: dark ? 0.36 : 0.30,
      navTickColor: hexToRgba(seriesColors.nav, 0.72),
      navTitleColor: hexToRgba(seriesColors.nav, 0.9),
      assetsTickColor: hexToRgba(seriesColors.assets, 0.72),
      assetsTitleColor: hexToRgba(seriesColors.assets, 0.9)
    };
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
    const easternDateStr = window.FundDateTime?.getMarketEasternDate
      ? window.FundDateTime.getMarketEasternDate(now)
      : (() => {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(now);
        const values = {};
        parts.forEach(part => { values[part.type] = part.value; });
        return `${values.year}-${values.month}-${values.day}`;
      })();
    const [year, month, day] = easternDateStr.split('-').map(Number);
    const easternDate = new Date(Date.UTC(year, month - 1, day));
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

  applyChartTheme({ dark, navTrendChart, memberAllocationChart, membersList, ui }) {
    const { getMemberAvatarColor, createChartGradient, getSeriesColors, hexToRgba } = ui;
    const seriesColors = getSeriesColors();
    const palette = this.getChartThemePalette(dark, seriesColors, hexToRgba);

    if (navTrendChart) {
      if (navTrendChart.$operationTrack) navTrendChart.$operationTrack.dark = dark;
      navTrendChart.options.plugins.legend.labels.color = palette.labelColor;
      navTrendChart.options.scales.x.grid.color = palette.gridColor;
      navTrendChart.options.scales.x.ticks.color = palette.tickColor;
      navTrendChart.options.scales['y-nav'].grid.color = palette.gridColor;
      navTrendChart.options.scales['y-nav'].ticks.color = palette.navTickColor;
      navTrendChart.options.scales['y-nav'].title.color = palette.navTitleColor;
      navTrendChart.options.scales['y-assets'].ticks.color = palette.assetsTickColor;
      navTrendChart.options.scales['y-assets'].title.color = palette.assetsTitleColor;

      const seriesKeys = ['assets', 'nav', 'sp500', 'ndx', 'custom', 'custom2'];
      seriesKeys.forEach((key, index) => {
        const dataset = navTrendChart.data.datasets[index];
        const color = seriesColors[key];
        if (!dataset || !color) return;
        dataset.borderColor = color;
        dataset.pointHoverBackgroundColor = color;
        if (index === 1) {
          const ctxNav = document.getElementById('navTrendChart').getContext('2d');
          dataset.backgroundColor = createChartGradient(
            ctxNav,
            hexToRgba(color, palette.navFillAlpha),
            hexToRgba(color, 0)
          );
          dataset.$setVisibilityOpacity = function setVisibilityOpacity(opacity) {
            this.backgroundColor = createChartGradient(
              ctxNav,
              hexToRgba(color, palette.navFillAlpha * opacity),
              hexToRgba(color, 0)
            );
          };
        }
      });

      navTrendChart.update();
    }

    if (memberAllocationChart) {
      memberAllocationChart.options.plugins.legend.labels.color = palette.labelColor;
      memberAllocationChart.data.datasets[0].borderColor = palette.chartBgColor;

      // 扇区颜色始终与对应成员头像的底色一致。
      if (memberAllocationChart.data.datasets[0].backgroundColor && memberAllocationChart.data.datasets[0].backgroundColor.length > 0) {
        const firstColor = memberAllocationChart.data.datasets[0].backgroundColor[0];
        if (firstColor && !firstColor.startsWith('rgba(')) {
          const newColors = membersList.map((member, idx) => getMemberAvatarColor(member.id || member.name, dark, idx).background);
          memberAllocationChart.data.datasets[0].backgroundColor = newColors;
        } else {
          const zeroColor = dark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
          memberAllocationChart.data.datasets[0].backgroundColor = memberAllocationChart.data.labels.map(() => zeroColor);
        }
      }

      memberAllocationChart.update();
    }
  },

  updateTheme({ theme, navTrendChart, memberAllocationChart, membersList, ui }) {
    const resolveDark = ui.isDarkTheme || window.FundUiUtils?.isDarkTheme;
    const dark = resolveDark
      ? resolveDark(theme)
      : (theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches));
    this.applyChartTheme({ dark, navTrendChart, memberAllocationChart, membersList, ui });
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
    const escapeLabel = ui.escapeHtml || window.FundUiUtils?.escapeHtml || (value => String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]));
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
    const palette = this.getChartThemePalette(dark, seriesColors, hexToRgba);
    const navCanvas = document.getElementById('navTrendChart');
    const navCtx = navCanvas.getContext('2d');

    // 动态生成高通透度 Apple 风格多阶渐变
    const navGradient = createChartGradient(navCtx, hexToRgba(seriesColors.nav, palette.navFillAlpha), hexToRgba(seriesColors.nav, 0));

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
    datasets[1].$setVisibilityOpacity = function setVisibilityOpacity(opacity) {
      this.backgroundColor = createChartGradient(
        navCtx,
        hexToRgba(seriesColors.nav, palette.navFillAlpha * opacity),
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

    const { gridColor, tickColor } = palette;
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
      nextNav.options.plugins.legend.labels.color = palette.labelColor;
      nextNav.options.scales.x.grid.color = gridColor;
      nextNav.options.scales.x.ticks.color = tickColor;
      nextNav.options.scales['y-nav'].grid.color = gridColor;
      nextNav.options.scales['y-nav'].ticks.color = palette.navTickColor;
      nextNav.options.scales['y-nav'].title.color = palette.navTitleColor;
      nextNav.options.scales['y-assets'].ticks.color = palette.assetsTickColor;
      nextNav.options.scales['y-assets'].title.color = palette.assetsTitleColor;
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
                color: palette.labelColor,
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
      Object.assign(nextAllocation.data.datasets[0], { data: empty ? members.map(() => 1) : values, backgroundColor: colors, borderColor: palette.chartBgColor });
      nextAllocation.options.plugins.legend.labels.color = palette.labelColor;
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
          datasets: [{ data: empty ? members.map(() => 1) : values, backgroundColor: colors, borderColor: palette.chartBgColor, borderWidth: 3, hoverOffset: 10 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, cutout: '70%',
          layout: { padding: { left: 64, right: 64, top: 18, bottom: 18 } },
          plugins: {
            allocationLabels: { empty },
            legend: { position: 'right', labels: { color: palette.labelColor, font: { size: 11, weight: '500' } } },
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
