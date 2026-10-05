const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const listeners = {};
function createMockElement() {
  const element = {
    children: [],
    className: '',
    dataset: {},
    offsetWidth: 180,
    offsetHeight: 100,
    style: {
      values: {},
      setProperty(name, value) { this.values[name] = value; }
    },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = [...children]; },
    setAttribute(name, value) { this[name] = value; }
  };
  element.classList = {
    add(...names) {
      const classes = new Set(element.className.split(/\s+/).filter(Boolean));
      names.forEach(name => classes.add(name));
      element.className = [...classes].join(' ');
    }
  };
  return element;
}

const canvases = {
  navTrendChart: {
    dataset: {},
    getContext: () => ({}),
    addEventListener: (event, handler) => { listeners[event] = handler; }
  },
  memberAllocationChart: { dataset: {}, getContext: () => ({}) }
};
const stats = { innerHTML: '' };

global.window = {};
global.document = {
  createElement: createMockElement,
  getElementById(id) {
    return id === 'trend-stats-grid' ? stats : canvases[id];
  }
};
global.Chart = class Chart {
  constructor(_context, config) {
    this.config = config;
    this.data = config.data;
    this.options = config.options;
    this.updated = 0;
    this.drawn = 0;
    this.visibility = this.data.datasets.map(dataset => !dataset.hidden);
    this.metaDatasets = this.data.datasets.map(() => ({ dataset: { options: {} } }));
  }
  update(mode) { this.updated += 1; this.lastUpdateMode = mode; }
  draw() { this.drawn += 1; }
  isDatasetVisible(index) { return this.visibility[index]; }
  setDatasetVisibility(index, visible) { this.visibility[index] = visible; }
  getDatasetMeta(index) { return this.metaDatasets[index]; }
};
global.Chart.defaults = {
  plugins: {
    legend: {
      labels: {
        generateLabels(chart) {
          return chart.data.datasets.map((dataset, datasetIndex) => ({
            datasetIndex,
            fillStyle: dataset.pointBackgroundColor?.[0] || dataset.borderColor,
            strokeStyle: dataset.pointBorderColor?.[0] || dataset.borderColor,
            text: dataset.label
          }));
        }
      }
    }
  }
};

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chart-renderer.js'), 'utf8'));

assert.strictEqual(
  window.FundChartRenderer.calculateTrendCutoff('YTD', new Date('2026-01-01T02:00:00Z')),
  '2025-01-01',
  'trend ranges must still use the prior Eastern date before New York midnight'
);
assert.strictEqual(
  window.FundChartRenderer.calculateTrendCutoff('YTD', new Date('2026-01-01T05:00:00Z')),
  '2026-01-01',
  'trend ranges must roll over at New York midnight'
);
assert.strictEqual(
  window.FundChartRenderer.calculateTrendCutoff('1M', new Date('2026-07-15T12:00:00Z')),
  '2026-06-15'
);
assert.strictEqual(
  window.FundChartRenderer.calculateTrendCutoff('1M', new Date('2026-03-31T16:00:00Z')),
  '2026-02-28',
  'month-end ranges must clamp to the last valid day of the target month'
);
assert.strictEqual(
  window.FundChartRenderer.calculateTrendCutoff('1Y', new Date('2024-02-29T16:00:00Z')),
  '2023-02-28',
  'leap-day yearly ranges must clamp to February 28'
);

const rightTooltipPosition = window.FundChartRenderer.calculateTooltipPosition({
  caretX: 100,
  caretY: 120,
  tooltipWidth: 180,
  tooltipHeight: 100,
  containerWidth: 600,
  containerHeight: 300
});
assert.deepStrictEqual(rightTooltipPosition, { left: 114, top: 120, placement: 'right' });

const leftTooltipPosition = window.FundChartRenderer.calculateTooltipPosition({
  caretX: 560,
  caretY: 120,
  tooltipWidth: 180,
  tooltipHeight: 100,
  containerWidth: 600,
  containerHeight: 300
});
assert.deepStrictEqual(leftTooltipPosition, { left: 366, top: 120, placement: 'left' });
assert(leftTooltipPosition.left + 180 < 560, 'left tooltip must not cover the active chart point');

const state = {
  members: {
    alice: { currentValue: 120 },
    bob: { currentValue: 80 }
  },
  charts: {
    navHistory: [
      { date: '2026-01-01', type: 'deposit', member: 'alice', amount: 100, cnhAmount: 720, remark: '首次入金', navPerShare: 1, totalNAV: 100, sp500NAV: 1, ndxNAV: 1 },
      { date: '2026-01-02', type: 'transfer', fromMember: 'alice', toMember: 'bob', amount: 20, cnhRate: 7.2, remark: '内部划转', navPerShare: 1.1, totalNAV: 200, sp500NAV: 1.01, ndxNAV: 1.02 }
    ]
  }
};
const members = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
const elements = {
  chkCompNav: { checked: true }, chkCompAssets: { checked: true },
  chkCompSp500: { checked: true }, chkCompNdx: { checked: true }, trendStatsGrid: stats
};
const ui = {
  formatMoney: value => Number(value).toFixed(2),
  getThemeColors: () => ({ palette: ['#111', '#222'] }),
  isDarkTheme: () => true,
  createChartGradient: (_context, colorStart, colorEnd) => ({ colorStart, colorEnd })
};

const rendered = window.FundChartRenderer.render({
  state, members, settings: { activeTimeSlice: 'ALL', theme: 'dark' }, charts: {}, elements, ui
});

const trendLegendLabels = rendered.navTrendChart.options.plugins.legend.labels.generateLabels(rendered.navTrendChart);
assert.strictEqual(trendLegendLabels[0].fillStyle, '#5a57cc');
assert.strictEqual(trendLegendLabels[0].strokeStyle, '#5a57cc');
assert.strictEqual(rendered.navTrendChart.options.animation.duration, 380);
assert.strictEqual(rendered.memberAllocationChart.options.animation, false,
  'allocation chart must render at its final size when first revealed');
assert(rendered.memberAllocationChart.config.plugins.includes(window.FundChartRenderer.allocationLabelsPlugin));

// Verify percentages, small-slice separation and the empty-data placeholder.
const allocationLabels = [];
const allocationDrawing = {
  width: 400,
  chartArea: { top: 18, bottom: 220 },
  legend: { position: 'bottom' },
  options: { plugins: { legend: { labels: { color: '#334155' } } } },
  data: { datasets: [{ data: [98, 1, 1, 0] }] },
  getDataVisibility: () => true,
  getDatasetMeta: () => ({ data: [0, 1, 2, 3].map(index => ({
    getProps: () => ({ x: 200, y: 120, startAngle: index * .01,
      endAngle: (index + 1) * .01, outerRadius: 90 })
  })) }),
  ctx: {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    measureText: () => ({ width: 48 }),
    fillText(text, x, y) { allocationLabels.push({ text, x, y }); }
  }
};
window.FundChartRenderer.allocationLabelsPlugin.afterDatasetsDraw(allocationDrawing, {}, { empty: false });
assert.deepStrictEqual(allocationLabels.map(label => label.text), ['98.00%', '1.00%', '1.00%']);
assert(allocationLabels.every(label => label.x + 48 <= allocationDrawing.width));
assert(allocationLabels[1].y - allocationLabels[0].y >= 20);
assert(allocationLabels[2].y - allocationLabels[1].y >= 20);
allocationLabels.length = 0;
allocationDrawing.getDataVisibility = index => index !== 0;
window.FundChartRenderer.allocationLabelsPlugin.afterDatasetsDraw(allocationDrawing, {}, { empty: false });
assert.deepStrictEqual(allocationLabels.map(label => label.text), ['1.00%', '1.00%'],
  'hiding a member must not change the remaining members\' shares of total assets');
allocationLabels.length = 0;
window.FundChartRenderer.allocationLabelsPlugin.afterDatasetsDraw(allocationDrawing, {}, { empty: true });
assert.strictEqual(allocationLabels.length, 0, 'placeholder slices must not show invented percentages');

// Exercise Chart.js's real legend option cache, including the first reveal of a hidden canvas.
const { Chart: RealChart, registerables, BasicPlatform } = require('chart.js');
RealChart.register(...registerables);
const resizedLabels = [];
const allocationCanvas = { width: 0, height: 270 };
const allocationContext = new Proxy({
  canvas: allocationCanvas,
  measureText: text => ({ width: String(text).length * 6 }),
  getLineDash: () => [],
  fillText(text, x, y) {
    if (String(text).endsWith('%')) resizedLabels.push({ text, x, y });
  }
}, { get: (target, key) => key in target ? target[key] : () => {} });
allocationCanvas.getContext = () => allocationContext;
const resizingAllocation = new RealChart(allocationCanvas, {
  platform: BasicPlatform,
  type: 'doughnut',
  plugins: [window.FundChartRenderer.allocationLabelsPlugin],
  data: {
    labels: ['John Titor', 'Alice Liddell', 'Giovanni Giorgio'],
    datasets: [{ data: [58.19, 18.36, 23.45] }]
  },
  options: {
    responsive: false, animation: false, maintainAspectRatio: false, cutout: '70%',
    layout: { padding: { left: 64, right: 64, top: 18, bottom: 18 } },
    plugins: {
      allocationLabels: { empty: false },
      legend: { position: 'right', labels: { color: '#334155' } }
    }
  }
});
try {
  for (const width of [1900, 400, 1440, 400, 1900]) {
    resizedLabels.length = 0;
    resizingAllocation.resize(width, 270);
    const legend = resizingAllocation.legend;
    assert.strictEqual(legend.position, width < 560 ? 'bottom' : 'right');
    assert.strictEqual(legend.options.position, legend.position,
      'legend orientation and layout box must agree on the first resize');
    const majorLabels = resizedLabels.filter(label => label.text === '58.19%');
    assert(majorLabels.length > 0, 'resize must draw the allocation labels');
    const arc = resizingAllocation.getDatasetMeta(0).data[0];
    assert(majorLabels.every(label => label.x > arc.x + arc.outerRadius),
      'the right-hand label must stay outside the ring, never cross it toward the left edge');
  }
} finally {
  resizingAllocation.destroy();
}
assert(rendered.navTrendChart.config.plugins.includes(window.FundChartRenderer.datasetOpacityPlugin));
assert.strictEqual(typeof rendered.renderTrendStats, 'function');
assert.strictEqual(rendered.navTrendChart.options.plugins.legend.display, false);
assert.strictEqual(rendered.navTrendChart.options.scales.x.grid.display, false);
assert.strictEqual(rendered.navTrendChart.options.scales.x.ticks.maxRotation, 0);
assert.strictEqual(rendered.navTrendChart.options.scales.x.ticks.maxTicksLimit, 7);
assert.strictEqual(rendered.navTrendChart.options.scales['y-nav'].ticks.maxTicksLimit, 5);
assert.strictEqual(rendered.navTrendChart.options.scales['y-nav'].border.display, false);

window.FundChartRenderer.animateDatasetVisibility(rendered.navTrendChart, 1, false, { duration: 0 });
assert.strictEqual(rendered.navTrendChart.isDatasetVisible(1), false);
assert.strictEqual(rendered.navTrendChart.lastUpdateMode, 'none');
window.FundChartRenderer.animateDatasetVisibility(rendered.navTrendChart, 1, true, { duration: 0 });
assert.strictEqual(rendered.navTrendChart.isDatasetVisible(1), true);
assert.strictEqual(rendered.navTrendChart.data.datasets[1].backgroundColor.colorStart, 'rgba(44, 97, 182, 0.36)');
assert.strictEqual(
  rendered.navTrendChart.getDatasetMeta(1).dataset.options.backgroundColor,
  rendered.navTrendChart.data.datasets[1].backgroundColor
);

assert.strictEqual(
  rendered.navTrendChart.options.plugins.tooltip.external,
  rendered.memberAllocationChart.options.plugins.tooltip.external,
  'trend and member allocation charts must share the glass tooltip renderer'
);

let mountedTooltip = null;
const tooltipContainer = {
  clientWidth: 600,
  clientHeight: 300,
  querySelector: () => mountedTooltip,
  appendChild(element) { mountedTooltip = element; }
};
rendered.navTrendChart.options.plugins.tooltip.external({
  chart: {
    canvas: {
      parentElement: tooltipContainer,
      toDataURL: () => 'data:image/png;base64,mock'
    },
    config: { type: 'line' }
  },
  tooltip: {
    opacity: 1,
    caretX: 100,
    caretY: 120,
    title: ['2026-01-02'],
    dataPoints: [{
      dataset: { borderColor: '#2c61b6', label: '单位净值' },
      datasetIndex: 1,
      parsed: { y: 1.1 }
    }]
  }
});
assert.match(mountedTooltip.className, /\bglass-tooltip\b/);
assert.match(mountedTooltip.children[0].className, /\bchart-external-tooltip-title\b/);
assert(!mountedTooltip.children.some(child => /glass-tooltip-backdrop/.test(child.className)),
  'glass must refract the live chart without a copied backdrop');

assert.strictEqual(rendered.filteredHistory.length, 2);
assert.match(stats.innerHTML, /单位净值/);
const details = rendered.navTrendChart.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: 0 }]);
assert(details.some(line => line.includes('Alice')));
assert(details.some(line => line.includes('首次入金')));
rendered.navTrendChart.options.onHover(null, [{ index: 1 }]);
assert.match(stats.innerHTML, /截至 2026-01-02/);
listeners.mouseleave();
assert.doesNotMatch(stats.innerHTML, /截至/);

const ytdState = {
  members: state.members,
  charts: {
    benchmarkAnchors: {
      2026: { spx: 6900, ndx: 25249.85, spxPriceDate: '2025-12-31', ndxPriceDate: '2025-12-31', policy: 'previous' }
    },
    navHistory: [
      { date: '2025-12-31', navPerShare: 1, totalNAV: 100, sp500NAV: 1, ndxNAV: 1, spx: 6880, ndx: 25000, spxPriceDate: '2025-12-30', ndxPriceDate: '2025-12-30' },
      { date: '2026-01-02', navPerShare: 1.01, totalNAV: 101, sp500NAV: 1.01, ndxNAV: 1.01, spx: 6900, ndx: 25249.85, spxPriceDate: '2025-12-31', ndxPriceDate: '2025-12-31' },
      { date: '2026-08-07', navPerShare: 1.15, totalNAV: 115, sp500NAV: 1.1, ndxNAV: 1.16, spx: 7500, ndx: 29373.33, spxPriceDate: '2026-08-06', ndxPriceDate: '2026-08-06' }
    ]
  }
};
const ytdRendered = window.FundChartRenderer.render({
  state: ytdState, members, settings: { activeTimeSlice: 'YTD', theme: 'dark' },
  charts: rendered, elements, ui
});
assert.strictEqual(ytdRendered.trendSeries[2].values[0], 1, 'NDX at first YTD valuation must equal 1.0 baseline');
assert.strictEqual(ytdRendered.trendSeries[2].values[1], 1.1633);
assert.match(stats.innerHTML, /\+16\.33%/);

const dualBenchmarkRendered = window.FundChartRenderer.render({
  state: {
    members: state.members,
    settings: {
      customBenchmark: { name: '组合一' },
      customBenchmark2: { name: '组合二' }
    },
    charts: {
      navHistory: [
        { date: '2026-01-02', navPerShare: 1, totalNAV: 100, sp500NAV: 1, ndxNAV: 1, customNAV: 1, custom2NAV: 1 },
        { date: '2026-01-09', navPerShare: 1.02, totalNAV: 102, sp500NAV: 1.01, ndxNAV: 1.03, customNAV: 1.04, custom2NAV: 1.08 }
      ]
    }
  },
  members,
  settings: { activeTimeSlice: 'ALL', theme: 'dark' },
  charts: rendered,
  elements: {
    ...elements,
    chkCompCustom: { checked: true },
    chkCompCustom2: { checked: true }
  },
  ui
});
assert.strictEqual(dualBenchmarkRendered.trendSeries[4].label, '组合二');
assert.deepStrictEqual(dualBenchmarkRendered.trendSeries[4].values, [1, 1.08]);
assert.strictEqual(dualBenchmarkRendered.navTrendChart.data.datasets[5].label, '组合二');

console.log('Chart renderer interaction regression tests passed.');
