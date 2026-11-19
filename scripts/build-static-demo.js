const fs = require('fs');
const path = require('path');
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
  const seed = buildSandboxSeed();
  fs.writeFileSync(path.join(output, 'demo-data/seed.json'), JSON.stringify(seed));
  const replaceRequired = (source, search, replacement, label, { all = false } = {}) => {
    if (!source.includes(search)) {
      throw new Error(`Static demo build failed: missing anchor "${label}" (${search}) in index.html`);
    }
    return all ? source.replaceAll(search, replacement) : source.replace(search, replacement);
  };
  const htmlPath = path.join(output, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = replaceRequired(html, '<head>', '<head>\n  <meta name="fund-demo-sandbox" content="true">', 'head-tag');
  html = replaceRequired(html, 'href="/demo"', 'href="./"', 'demo-link', { all: true });
  html = replaceRequired(html, 'href="/api/backup/export"', 'href="#demo-backup-export"', 'backup-export-link');
  html = replaceRequired(html, '<script src="js/api.js"></script>', '<script src="js/demo-sandbox.js"></script>\n  <script src="js/api.js"></script>', 'api-script-tag');
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(path.join(output, '.nojekyll'), '');
  return { output, seed };
}
if (require.main === module) {
  const { output } = buildStaticDemo();
  console.log(`Interactive isolated Demo built: ${output}`);
}
module.exports = { buildStaticDemo };
