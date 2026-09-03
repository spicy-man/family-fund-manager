const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json'));
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const version = pkg.version;

assert.strictEqual(lock.version, version, 'package-lock top-level version must match package.json');
assert.strictEqual(lock.packages[''].version, version, 'package-lock root package version must match package.json');
assert(html.includes(`sidebar-version">v${version}</b>`), 'sidebar version must match package.json');
assert(html.includes(`version-badge">v${version}</span>`), 'header version badge must match package.json');
assert(changelog.includes(`目前系统版本为 **v${version}**`), 'current changelog version must match package.json');
assert(changelog.includes(`## 🔧 v${version} `) || changelog.includes(`## ✨ v${version} `), 'changelog release section is missing');

console.log(`Version consistency assertions passed for v${version}.`);
