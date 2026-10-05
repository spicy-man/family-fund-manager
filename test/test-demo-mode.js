const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-demo-'));
process.env.FUND_DATA_DIR = dataDir;
process.env.FUND_BACKUP_DIR = path.join(dataDir, 'backups');
process.env.FUND_EXTERNAL_SYNC = '0';

const { startServer } = require('../server');
const weeklyMarket = require('../demo/weekly-market.json');

function request(server, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const server = startServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const page = await request(server, '/demo');
    assert.strictEqual(page.status, 200);
    assert(page.body.includes('js/demo-mode.js'), 'demo page must load the demo-mode controller');

    const redirect = await request(server, '/demo/');
    assert.strictEqual(redirect.status, 308);
    assert.strictEqual(redirect.headers.location, '/demo');

    const caseRedirect = await request(server, '/DEMO?source=review');
    assert.strictEqual(caseRedirect.status, 308);
    assert.strictEqual(caseRedirect.headers.location, '/demo?source=review');

    const membersResponse = await request(server, '/api/demo/members');
    assert.strictEqual(membersResponse.status, 200);
    const members = JSON.parse(membersResponse.body).data;
    assert.deepStrictEqual(members.map(member => member.name), ['John Titor', 'Alice Liddell', 'Giovanni Giorgio']);
    assert.strictEqual(members.filter(member => member.primaryGp).length, 1);

    const stateResponse = await request(server, '/api/demo/state');
    assert.strictEqual(stateResponse.status, 200);
    assert.strictEqual(stateResponse.headers['cache-control'], 'no-store');
    const state = JSON.parse(stateResponse.body).data;
    assert(state.summary.totalNAV > 180000, 'demo should present a populated fund');
    assert(state.events.some(event => event.type === 'performance_settlement'));
    assert.strictEqual(state.settings.benchmarkCacheReady, true);
    const weeklyValuations = state.events.filter(event => event.type === 'valuation');
    assert.strictEqual(weeklyValuations.length, weeklyMarket.weeks.length);
    assert.strictEqual(weeklyValuations[0].date, weeklyMarket.startDate);
    assert.strictEqual(weeklyValuations.at(-1).date, weeklyMarket.endDate);
    assert(weeklyMarket.endDate >= '2026-10-02', 'demo market must include the refreshed cutoff');
    const tracked = JSON.parse((await request(server, '/api/demo/ticker-ath')).body).data;
    for (const ticker of ['VOO', 'QQQM', 'MSFT', 'META', 'AMZN', 'BRK-B', 'KO', 'PG', 'BAC']) {
      assert(tracked[ticker], `Missing requested ticker ${ticker}`);
    }
    assert(Object.keys(tracked).length >= 20);
    for (const quote of Object.values(tracked)) {
      assert.strictEqual(quote.regularCloseDate, weeklyMarket.endDate);
      assert(quote.athDate <= weeklyMarket.endDate);
      assert(Math.abs(quote.drawdown - (quote.regularClose / quote.ath - 1) * 100) < 0.02);
    }
    weeklyValuations.slice(1).forEach((event, index) => {
      assert.strictEqual(
        (Date.parse(event.date) - Date.parse(weeklyValuations[index].date)) / 86400000,
        7,
        'demo valuations must contain one uninterrupted snapshot per week'
      );
    });
    assert.strictEqual(state.settings.customBenchmark.name, 'VGT');
    assert.strictEqual(state.settings.customBenchmark2.name, 'BRK-B');
    assert.deepStrictEqual(state.settings.customBenchmark.components, [{ ticker: 'VGT', weight: 100 }]);
    assert.deepStrictEqual(state.settings.customBenchmark2.components, [{ ticker: 'BRK-B', weight: 100 }]);
    assert.strictEqual(state.settings.customBenchmarkCacheReady, true);
    assert.strictEqual(state.settings.customBenchmark2CacheReady, true);
    assert.strictEqual(state.summary.cnhRate, weeklyMarket.latestCnh.rate);
    const firstDeposit = state.events.find(event => event.id === 'demo_deposit_alex');
    assert.strictEqual(firstDeposit.cnhAmount / firstDeposit.amount, 6.354);

    const demoModeSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'demo-mode.js'), 'utf8');
    const demoCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'demo.css'), 'utf8');
    assert(demoModeSource.includes("operationPanel.classList.add('is-demo-preview')"));
    assert(demoModeSource.includes("'.operations-panel .op-form input'"));
    assert(!demoCss.includes('.demo-mode .operations-panel {\n  display: none'), 'demo must keep the input panel visible');
    assert(
      demoCss.includes('top: calc(var(--fixed-panel-top) + var(--demo-banner-offset))'),
      'fixed demo side panels must align below the demo banner'
    );

    const blockedWrite = await request(server, '/api/demo/transaction', 'POST');
    assert.strictEqual(blockedWrite.status, 405);
    assert.strictEqual(JSON.parse(blockedWrite.body).success, false);
  } finally {
    server.close();
  }

  console.log('Demo mode assertions passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
