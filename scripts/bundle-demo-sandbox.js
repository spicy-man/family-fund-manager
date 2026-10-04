const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
function bundleSandbox(output) {
  const root = path.resolve(__dirname, '..');
  esbuild.buildSync({
    entryPoints: [path.join(root, 'demo/browser/sandbox.js')],
    outfile: path.join(output, 'js/demo-sandbox.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true,
    inject: [path.join(root, 'demo/browser/globals.js')],
    alias: Object.fromEntries(['crypto', 'util', 'express', 'zlib', 'adm-zip'].map(name =>
      [name, path.join(root, 'demo/browser', name === 'adm-zip' ? 'zip.js' : name + '.js')]))
  });
  for (const name of ['esbuild', '@noble/hashes', 'buffer', 'fflate', 'decimal.js']) {
    const directory = path.join(root, 'node_modules', name);
    const license = fs.readdirSync(directory).find(file => /^licen[sc]e(?:\.|$)/i.test(file));
    if (!license) throw new Error(`Missing license: ${name}`);
    const target = path.join(output, 'vendor/licenses', name.replace('/', '-'));
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(directory, license), path.join(target, license));
  }
}
module.exports = { bundleSandbox };
