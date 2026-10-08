const fs = require('fs');
const path = require('path');
const { buildDemoLedgers } = require('../demo/build-ledger');
const { calculateStateFromDb } = require('../lib/calculator');
const weeklyMarket = require('../demo/weekly-market.json');
const { dependencies } = require('../package.json');
const { bundleSandbox } = require('./bundle-demo-sandbox');
const { buildSandboxSeed } = require('../demo/build-sandbox-seed');
const root = path.resolve(__dirname, '..');
const defaultOutput = path.join(root, 'dist-demo');

function buildStaticDemo(output = defaultOutput) {
  output = path.resolve(output);
  if (fs.existsSync(output)) {
    if (fs.lstatSync(output).isSymbolicLink()) throw new Error('Demo output cannot be a symlink');
    if (output === defaultOutput) {
      // Only the fixed build directory inside this project may be replaced.
      fs.rmSync(output, { recursive: true, force: true });
    } else if (fs.readdirSync(output).length) {
      throw new Error('Custom Demo output must be an empty directory');
    }
  }
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(root, 'public'), output, { recursive: true });
  const copy = (source, relative) => {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  };
  const chartDirectory = path.dirname(require.resolve('chart.js'));
  const sortableDirectory = path.dirname(require.resolve('sortablejs/Sortable.min.js'));
  copy(path.join(chartDirectory, 'chart.umd.min.js'),
    `vendor/chart.js/${dependencies['chart.js']}/chart.umd.min.js`);
  copy(path.join(chartDirectory, '..', 'LICENSE.md'),
    `vendor/chart.js/${dependencies['chart.js']}/LICENSE.md`);
  copy(path.join(sortableDirectory, 'Sortable.min.js'),
    `vendor/sortablejs/${dependencies.sortablejs}/Sortable.min.js`);
  copy(path.join(sortableDirectory, 'LICENSE'),
    `vendor/sortablejs/${dependencies.sortablejs}/LICENSE`);
  for (const family of ['inter', 'outfit']) {
    const packageName = `@fontsource-variable/${family}`;
    const directory = path.dirname(require.resolve(`${packageName}/index.css`));
    const target = `vendor/fonts/${family}/${dependencies[packageName]}`;
    copy(path.join(directory, 'index.css'), `${target}/index.css`);
    copy(path.join(directory, 'files'), `${target}/files`);
    copy(path.join(directory, 'LICENSE'), `${target}/LICENSE`);
  }
  copy(path.join(root, 'LICENSE'), 'LICENSE');
  bundleSandbox(output);
  fs.mkdirSync(path.join(output, 'demo-data'), { recursive: true });
  fs.writeFileSync(path.join(output, 'demo-data/seed.json'), JSON.stringify(buildSandboxSeed()));
  const entries = buildDemoLedgers();
  const db = entries[0].ledger;
  const payloads = {
    'ledgers.json': { success: true, data: entries.map(({ ledger, ...entry }) => entry) },
    'combined.json': { success: true, data: require('../lib/combined-overview').combineLedgers(entries.map(({ ledger, ...entry }) =>
      ({ ...entry, state: calculateStateFromDb(ledger) }))) },
    'state.json': { success: true, data: calculateStateFromDb(db) },
    'members.json': { success: true, data: db.members.map(member => ({
      ...member, primaryGp: member.id === db.performanceFee.gpMemberId
    })) },
    'ticker-ath.json': { success: true, data: weeklyMarket.tickers, refreshing: false },
    'tickers.json': { success: true, data: Object.values(weeklyMarket.tickers)
      .map(({ ticker, longName }) => ({ ticker, name: longName })) },
    'custom-benchmark-0.json': { success: true, data: db.customBenchmark },
    'custom-benchmark-1.json': { success: true, data: db.customBenchmark2 }
  };
  for (const { id, ledger } of entries.slice(1)) {
    payloads[id + '/state.json'] = { success: true, data: calculateStateFromDb(ledger) };
    payloads[id + '/members.json'] = { success: true, data: ledger.members.map(member => ({
      ...member, primaryGp: member.id === ledger.performanceFee.gpMemberId
    })) };
  }
  for (const [file, payload] of Object.entries(payloads)) {
    const target = path.join(output, 'demo-data', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(payload)}\n`);
  }
  const htmlPath = path.join(output, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8')
    .replace('<head>', '<head>\n  <meta name="fund-static-demo" content="true">\n  <meta name="fund-demo-sandbox" content="true">')
    .replaceAll('href="/demo"', 'href="./"')
    .replace('href="/api/backup/export"', 'href="#demo-backup-export"')
    .replace('<script src="js/api.js"></script>', '<script src="js/demo-sandbox.js"></script>\n  <script src="js/api.js"></script>');
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(path.join(output, '.nojekyll'), '');
  return { output, payloads };
}
if (require.main === module) {
  const { output } = buildStaticDemo();
  console.log(`Interactive isolated Demo built: ${output}`);
}
module.exports = { buildStaticDemo };
