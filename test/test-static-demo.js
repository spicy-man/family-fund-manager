const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { buildStaticDemo } = require('../scripts/build-static-demo');
const { buildDemoLedger } = require('../demo/build-ledger');
const { calculateStateFromDb } = require('../lib/calculator');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-static-demo-'));
const read = file => fs.readFileSync(path.join(output, file), 'utf8');

(async () => {
  try {
    buildStaticDemo(output);
    assert.deepStrictEqual(JSON.parse(read('demo-data/state.json')).data, JSON.parse(JSON.stringify(calculateStateFromDb(buildDemoLedger()))));
    const demoLedgers = JSON.parse(read('demo-data/ledgers.json')).data;
    assert.strictEqual(demoLedgers[0].id, 'default');
    assert.strictEqual(JSON.parse(read('demo-data/combined.json')).data.ledgers.length, 2);
    assert.strictEqual(demoLedgers.length, 2);
    const secondarySample = JSON.parse(read('demo-data/ledger-2/state.json')).data;
    const combined = JSON.parse(read('demo-data/combined.json')).data;
    assert(secondarySample.summary.totalNAV > 0);
    assert.strictEqual(combined.members.find(member => member.id === '100001').breakdown.length, 2);
    const ledger = buildDemoLedger();
    const history = calculateStateFromDb(ledger).charts.navHistory;
    for (const event of ledger.events.filter(event => ['deposit', 'withdraw', 'transfer'].includes(event.type))) {
      if (event.date === ledger.events[0].date) continue;
      const operationIndex = ledger.events.findIndex(item => item.id === event.id);
      const valuationIndex = ledger.events.findIndex(item => item.type === 'valuation' && item.date === event.date);
      assert(valuationIndex >= 0 && valuationIndex < operationIndex,
        `${event.id} must follow the same-day valuation`);
      const operationPoint = history.find(item => item.eventId === event.id);
      const valuationPoint = history.find(item => item.eventId === ledger.events[valuationIndex].id);
      assert.strictEqual(operationPoint.navPerShare, valuationPoint.navPerShare,
        `${event.id} must use the updated NAV without changing unit value`);
    }
    const members = JSON.parse(read('demo-data/members.json')).data;
    assert.strictEqual(members.filter(member => member.primaryGp).length, 1);
    assert(read('index.html').includes('name="fund-static-demo"'));
    assert(read('index.html').includes('name="fund-demo-sandbox"'));
    assert(read('index.html').includes('src="js/demo-sandbox.js"'));
    assert(!/href="\/(?:demo|api)/.test(read('index.html')));
    assert(!fs.existsSync(path.join(output, 'data')));
    assert(!fs.existsSync(path.join(output, 'backups')));
    assert(!fs.existsSync(path.join(output, 'server.js')));
    const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), 'Pages artifacts cannot contain symlinks');
      return entry.isDirectory() ? walk(file) : [file];
    });
    for (const file of walk(output)) {
      if (!/\.(html|css)$/.test(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const refs = file.endsWith('.html')
        ? [...source.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
        : [...source.matchAll(/(?:url\(\s*["']?([^"')\s]+)|@import\s+["']([^"']+))/g)].map(match => match[1] || match[2]);
      for (const ref of refs) {
        if (/^(?:#|data:|https?:|\/\/)/.test(ref)) continue;
        assert(!ref.startsWith('/'), `Asset must be relative: ${ref}`);
        assert(fs.existsSync(path.resolve(path.dirname(file), ref.split(/[?#]/)[0])), `Missing asset: ${ref}`);
      }
    }
    for (const page of ['https://example.org/family-fund-manager/', 'https://example.org/family-fund-manager/index.html#ledger-section', 'https://example.org/']) {
      const requests = [];
      const context = vm.createContext({
        window: { FundDemoMode: { enabled: true, staticDemo: true }, location: { href: page } },
        URL, AbortController, setTimeout, clearTimeout,
        fetch: async (url, options) => {
          requests.push({ url, options });
          const relative = new URL(url).pathname.split('/demo-data/')[1];
          return { ok: true, json: async () => JSON.parse(read(`demo-data/${relative}`)) };
        }
      });
      vm.runInContext(fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8') + '\nglobalThis.client = Api;', context);
      const state = await context.client.getState();
      assert(state.events.length > 200);
      assert.strictEqual((await vm.runInContext("requestApi('/api/ledgers')", context)).data.length, 2);
      assert.strictEqual((await vm.runInContext("requestApi('/api/ledgers/combined')", context)).data.ledgers.length, 2);
      await context.client.getMembers();
      context.window.FundLedger = { id: 'ledger-2' };
      const secondState = await context.client.getState();
      assert.strictEqual(secondState.summary.totalNAV, secondarySample.summary.totalNAV);
      assert((await context.client.getMembers()).every(member => /^[1-9][0-9]{5}$/.test(member.id)));
      delete context.window.FundLedger;
      await context.client.getTickerAth();
      await context.client.getTickers();
      const first = await context.client.getCustomBenchmark(0);
      const second = await context.client.getCustomBenchmark(1);
      assert.deepStrictEqual(first, { name: 'VGT', components: [{ ticker: 'VGT', weight: 100 }] });
      assert.deepStrictEqual(second, { name: 'BRK-B', components: [{ ticker: 'BRK-B', weight: 100 }] });
      assert(requests.every(request => request.url.startsWith(new URL('demo-data/', page).href)));
      const before = requests.length;
      await assert.rejects(context.client.addTransaction({}), /只读/);
      await assert.rejects(context.client.updateEvent('a', {}), /只读/);
      await assert.rejects(context.client.deleteEvent('a'), /只读/);
      await assert.rejects(context.client.importBackup({}), /只读/);
      await assert.rejects(context.client.previewSettlement({}), /只读/);
      assert.strictEqual(requests.length, before, 'Writes must be rejected before network access');
    }
    const sandboxRequests = [];
    const sandboxContext = vm.createContext({ window: {
      FundDemoMode: { enabled: true, sandbox: true }, FundLedger: { id: 'ledger-2' },
      FundDemoSandbox: { request: async (url, options) => { sandboxRequests.push({ url, options }); return { success: true, data: {} }; } }
    } });
    vm.runInContext(fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8'), sandboxContext);
    await vm.runInContext("requestApi('/api/state')", sandboxContext);
    assert.strictEqual(sandboxRequests[0].options.headers['X-Ledger-Id'], 'ledger-2');
    for (const demo of [false, true]) {
      const context = vm.createContext({ window: { FundDemoMode: { enabled: demo }, location: { href: 'http://localhost:3000/' } } });
      vm.runInContext(fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8'), context);
      assert.strictEqual(vm.runInContext("resolveApiUrl('/api/state')", context), demo ? '/api/demo/state' : '/api/state');
    }
    console.log('Static Demo data, nested paths, assets, isolation and read-only checks passed.');
  } finally {
    // output is an absolute, freshly allocated test directory.
    fs.rmSync(output, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
