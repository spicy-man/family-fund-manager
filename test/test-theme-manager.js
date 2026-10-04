const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/theme-manager.js'), 'utf8');
function setup(saved, dark) {
  const classes = new Set();
  const storage = new Map(saved === undefined ? [] : [['family_fund_theme', saved]]);
  const media = { matches: dark, addEventListener: (_event, handler) => { media.change = handler; } };
  const style = {};
  const meta = { setAttribute: (_name, value) => { meta.content = value; } };
  const buttons = ['system', 'light', 'dark'].map(theme => ({ dataset: { themeBtn: theme }, addEventListener() {} }));
  let selected;
  const context = vm.createContext({
    window: { matchMedia: () => media },
    document: { documentElement: { style }, querySelector: () => meta,
      body: { classList: { remove: (...names) => names.forEach(name => classes.delete(name)), add: name => classes.add(name) } } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    requestAnimationFrame: callback => callback()
  });
  vm.runInContext(source, context);
  const controller = context.window.FundTheme.create({ buttons, group: {},
    segmentedControl: { activate: (_group, button) => { selected = button?.dataset.themeBtn; }, setIndicator() {} } });
  controller.init();
  return { controller, classes, media, style, meta, storage, selected: () => selected };
}
for (const osDark of [true, false]) {
  const fresh = setup(undefined, osDark);
  assert.strictEqual(fresh.controller.get(), 'light');
  assert(fresh.classes.has('theme-light'));
  assert.strictEqual(fresh.style.colorScheme, 'only light');
  assert.strictEqual(fresh.meta.content, 'only light');
  assert.strictEqual(fresh.selected(), 'light');
  fresh.controller.set('dark');
  assert(fresh.classes.has('theme-dark'));
  assert.strictEqual(fresh.style.colorScheme, 'dark');
  assert.strictEqual(fresh.storage.get('family_fund_theme'), 'dark');
  fresh.controller.set('light');
  fresh.media.matches = true;
  fresh.media.change();
  assert(fresh.classes.has('theme-light'), 'Explicit light must ignore system changes');
  fresh.controller.set('system');
  assert(fresh.classes.has('theme-dark'));
  fresh.media.matches = false;
  fresh.media.change();
  assert(fresh.classes.has('theme-light'));
  assert.strictEqual(fresh.controller.get(), 'system');
  assert.strictEqual(fresh.selected(), 'system');
  assert.strictEqual(fresh.style.colorScheme, 'only light');
}
assert(setup('dark', false).classes.has('theme-dark'), 'Remember an explicit dark preference');
assert(setup('system', true).classes.has('theme-dark'), 'Remember the system preference');
assert.strictEqual(setup('invalid', true).controller.get(), 'light');
console.log('Default light, saved preferences, native colour schemes and system-change checks passed.');
