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
    const seed = JSON.parse(read('demo-data/seed.json'));
    assert.strictEqual(seed.defaultName, '成长账本');
    assert(seed.ledgers['ledger-2'], 'sandbox seed must include secondary sample ledger');
    assert(seed.db.members.every(member => /^[1-9][0-9]{5}$/.test(member.id)));
    assert.strictEqual(seed.db.members.filter(member => member.id === seed.db.performanceFee.gpMemberId).length, 1);
    assert(!fs.existsSync(path.join(output, 'demo-data/state.json')), 'obsolete read-only static JSON snapshots must not be emitted');

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

    assert(!read('index.html').includes('name="fund-static-demo"'));
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
    console.log('Static Demo bundle, seed, relative assets, isolation and routing checks passed.');
  } finally {
    // output is an absolute, freshly allocated test directory.
    fs.rmSync(output, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
