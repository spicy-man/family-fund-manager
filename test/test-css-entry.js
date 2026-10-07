const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadCssEntry } = require('./helpers/load-css');

const cssDirectory = path.join(__dirname, '..', 'public', 'css');
const entryPath = path.join(cssDirectory, 'style.css');
const entry = fs.readFileSync(entryPath, 'utf8');
const imports = [...entry.matchAll(/@import\s+url\('([^']+)'\);/g)]
  .map(match => match[1]);

assert.strictEqual(imports.length, 16, 'style.css must load all 16 ordered CSS modules');
assert.strictEqual(new Set(imports).size, imports.length, 'CSS imports must not contain duplicates');
imports.forEach(file => {
  assert(fs.existsSync(path.join(cssDirectory, file)), `missing CSS module: ${file}`);
});
assert(!entry.replace(/@import\s+url\('[^']+'\);/g, '').trim(), 'style.css must remain an import-only entry');
assert(loadCssEntry(entryPath).includes(':root'), 'expanded CSS must include the theme variables');

console.log('CSS entry and module assertions passed.');
