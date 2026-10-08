const path = require('path');
const { buildDemoLedger } = require('../demo/build-ledger');
const weeklyMarket = require('../demo/weekly-market.json');

const demoLedger = buildDemoLedger();
const demoMarket = weeklyMarket.tickers;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function registerDemoRoutes(app, { calculateStateFromDb, publicDirectory }) {
  app.get('/demo', (req, res) => {
    const queryIndex = req.originalUrl.indexOf('?');
    const pathname = queryIndex === -1 ? req.originalUrl : req.originalUrl.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
    if (pathname !== '/demo') return res.redirect(308, `/demo${query}`);
    return res.sendFile(path.join(publicDirectory, 'index.html'));
  });

  app.use('/api/demo', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/demo/ledgers', (_req, res) => {
    res.json({ success: true, data: [{ id: 'default', name: '样例账本', isDefault: true }] });
  });
  app.get('/api/demo/ledgers/combined', (_req, res) => {
    res.json({ success: true, data: require('../lib/combined-overview').combineLedgers([
      { id: 'default', name: '样例账本', state: calculateStateFromDb(clone(demoLedger)) }
    ]) });
  });

  app.get('/api/demo/state', (_req, res) => {
    const state = calculateStateFromDb(clone(demoLedger));
    res.json({ success: true, data: state });
  });

  app.get('/api/demo/members', (_req, res) => {
    const members = demoLedger.members.map(member => ({
      ...clone(member),
      primaryGp: demoLedger.performanceFee.gpMemberId === member.id
    }));
    res.json({ success: true, data: members });
  });

  app.get('/api/demo/ticker-ath', (_req, res) => {
    res.json({ success: true, data: clone(demoMarket), refreshing: false });
  });

  app.get('/api/demo/settings/tickers', (_req, res) => {
    res.json({
      success: true,
      data: Object.values(demoMarket).map(({ ticker, longName }) => ({ ticker, name: longName }))
    });
  });

  app.get('/api/demo/settings/custom-benchmark', (req, res) => {
    const slot = Number(req.query.slot || 0);
    const data = slot === 1 ? demoLedger.customBenchmark2 : demoLedger.customBenchmark;
    res.json({ success: true, data: clone(data) });
  });

  app.all('/api/demo/*', (_req, res) => {
    res.status(405).json({
      success: false,
      message: '演示模式为只读，操作不会写入正式账本。'
    });
  });
}

module.exports = { registerDemoRoutes };
