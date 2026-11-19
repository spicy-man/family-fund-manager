const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scheduled = [];
const container = {
  innerHTML: '',
  closest: () => null,
  querySelectorAll: () => [],
  replaceChildren() {},
  appendChild() {}
};
const responses = [
  {
    data: {
      VOO: {
        ticker: 'VOO', ath: 100, regularClose: 95, drawdown: -5,
        ytdChange: 3, athDate: '2026-01-01', regularCloseDate: '2026-08-07'
      }
    },
    refreshing: true
  },
  {
    data: {
      VOO: {
        ticker: 'VOO', ath: 110, regularClose: 105, drawdown: -4.55,
        ytdChange: 4, athDate: '2026-08-10', regularCloseDate: '2026-08-10'
      }
    },
    refreshing: false
  }
];
let calls = 0;
const context = {
  window: {},
  document: { createElement: () => ({}) },
  setTimeout: callback => { scheduled.push(callback); return scheduled.length; },
  clearTimeout: () => {}
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ticker-panel.js'), 'utf8'),
  context
);

const args = {
  container,
  api: { getTickerAth: async () => responses[calls++] },
  ui: { escapeHtml: value => value }
};

(async () => {
  await context.window.FundTickerPanel.load(args);
  assert.strictEqual(calls, 1);
  assert.strictEqual(scheduled.length, 1, 'a stale response must schedule a follow-up read');
  assert(container.innerHTML.includes('$100.00'));

  await scheduled.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(calls, 2);
  assert(container.innerHTML.includes('$110.00'), 'the completed background refresh must be rendered');
  assert.strictEqual(scheduled.length, 0, 'polling must stop once the response is fresh');

  console.log('Ticker panel background-refresh polling assertions passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
