const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadCssEntry } = require('./helpers/load-css');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = loadCssEntry(path.join(root, 'public', 'css', 'style.css'));
const segmentedControl = fs.readFileSync(path.join(root, 'public', 'js', 'segmented-control.js'), 'utf8');

const controlClasses = ['theme-selector-group', 'tab-buttons', 'time-slicer-group', 'operation-tabs'];
const buttonClasses = ['theme-btn', 'tab-btn', 'time-slice-btn', 'op-tab-btn'];

controlClasses.forEach(className => {
  const tag = html.match(new RegExp(`<[^>]+class="[^"]*\\b${className}\\b[^"]*"[^>]*>`));
  assert(tag, `${className} control is missing`);
  assert(/\bsegmented-control\b/.test(tag[0]), `${className} must use the shared segmented control`);
  assert(/\bsegmented-control--(?:2|3|4|6)\b/.test(tag[0]), `${className} must declare its segment count`);
});

buttonClasses.forEach(className => {
  const tags = [...html.matchAll(new RegExp(`<button[^>]+class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'g'))];
  assert(tags.length > 0, `${className} buttons are missing`);
  tags.forEach(([tag]) => {
    assert(/\bsegmented-control__button\b/.test(tag), `${className} must use the shared button class`);
  });
});

assert.strictEqual((css.match(/^\.segmented-control \{/gm) || []).length, 1, 'shared surface must have one canonical rule');
assert.strictEqual((css.match(/^\.segmented-control__button \{/gm) || []).length, 1, 'shared button must have one canonical rule');
assert(!/(?:theme-selector-group|tab-buttons|operation-tabs|time-slicer-group)::before/.test(css), 'legacy indicators must not be reintroduced');
assert(
  /\.segmented-control__button\.active,[\s\S]*?color:\s*var\(--segment-active-color\)/.test(css),
  'selected option content must use the component theme colour'
);
assert(
  /--segment-active-color:\s*var\(--color-primary\)/.test(css),
  'shared selected colour must inherit the application theme colour'
);
assert(segmentedControl.includes("document.querySelectorAll('.segmented-control')"), 'indicator sync must discover controls generically');
assert(segmentedControl.includes('function activate'), 'active option switching must use the shared helper');
assert(
  html.includes('class="glass-tooltip benchmark-policy-tooltip"') &&
    html.includes('<strong>基准口径说明</strong>') &&
    html.includes('估值日 T 严格匹配 T-1 交易日美股收盘价'),
  'benchmark help must explain snapshot matching and the YTD anchor'
);
assert(!css.includes('.benchmark-policy-help::after'), 'benchmark help must not duplicate the shared tooltip surface');
assert(!html.includes('data-benchmark-policy="same_day"'), 'future same-day closes must not be selectable');

console.log('Segmented control component regression tests passed.');
