const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-security-'));
process.env.FUND_DATA_DIR = dataDir;
process.env.FUND_BACKUP_DIR = path.join(dataDir, 'backups');
process.env.FUND_EXTERNAL_SYNC = '0';

const pkg = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json'));
const { startServer } = require('../server');

function request(server, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const requestHeaders = { Host: `127.0.0.1:${server.address().port}`,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers };
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method,
      headers: Object.entries(requestHeaders).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).flatMap(item => [name, String(item)]))
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function parsePolicy(policy) {
  return new Map(policy.split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
}

function resolveLocalReference(reference, basePath) {
  assert(!/^(?:https?:)?\/\//i.test(reference), `external resource is forbidden: ${reference}`);
  const resolved = new URL(reference, `http://local.test${basePath}`);
  assert.strictEqual(resolved.origin, 'http://local.test', `resource must stay same-origin: ${reference}`);
  return resolved.pathname;
}

function extractCssReferences(css) {
  const references = [];
  for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const reference = match[2].trim();
    if (reference && !reference.startsWith('data:') && !reference.startsWith('#')) references.push(reference);
  }
  return references;
}

(async () => {
  const dependencyVersions = {
    'chart.js': '4.5.1',
    sortablejs: '1.15.7',
    '@fontsource-variable/inter': '5.3.0',
    '@fontsource-variable/outfit': '5.3.0'
  };
  Object.entries(dependencyVersions).forEach(([name, version]) => {
    assert.strictEqual(pkg.dependencies[name], version, `${name} must use an exact version`);
    assert.strictEqual(lock.packages[`node_modules/${name}`].version, version, `${name} lock version must match`);
  });

  const server = startServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const page = await request(server, '/');
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.headers['x-content-type-options'], 'nosniff');

    const policy = parsePolicy(page.headers['content-security-policy']);
    assert.deepStrictEqual(policy.get('default-src'), ["'self'"]);
    assert.deepStrictEqual(policy.get('script-src'), ["'self'"]);
    assert.deepStrictEqual(policy.get('script-src-attr'), ["'none'"]);
    assert.deepStrictEqual(policy.get('style-src-elem'), ["'self'"]);
    assert.deepStrictEqual(policy.get('font-src'), ["'self'"]);
    assert.deepStrictEqual(policy.get('connect-src'), ["'self'"]);
    assert.deepStrictEqual(policy.get('frame-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('media-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('worker-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('manifest-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('object-src'), ["'none'"]);
    assert.deepStrictEqual(policy.get('frame-ancestors'), ["'none'"]);
    assert(!policy.get('script-src').includes("'unsafe-inline'"));
    assert(!policy.get('script-src').includes("'unsafe-eval'"));

    const html = page.body.toString('utf8');
    assert(!/<(?:script|link)\b[^>]+(?:src|href)=["']https?:\/\//i.test(html), 'page assets must not use HTTP CDNs');
    assert(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline scripts are forbidden by the CSP');

    const htmlReferences = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)]
      .map(match => resolveLocalReference(match[1], '/'));
    const pendingAssets = [...htmlReferences];
    const checkedAssets = new Set();
    while (pendingAssets.length) {
      const assetPath = pendingAssets.shift();
      if (checkedAssets.has(assetPath)) continue;
      checkedAssets.add(assetPath);
      const asset = await request(server, assetPath);
      assert.strictEqual(asset.status, 200, `${assetPath} must be served locally`);
      assert(asset.body.length > 0, `${assetPath} must not be empty`);
      assert.strictEqual(asset.headers['content-security-policy'], page.headers['content-security-policy']);
      if (assetPath.startsWith('/vendor/')) {
        assert(asset.headers['cache-control'].includes('immutable'), `${assetPath} must be immutable`);
      }
      if (assetPath.endsWith('.js')) {
        assert(/^(?:text|application)\/javascript\b/.test(asset.headers['content-type']), `${assetPath} must be JavaScript`);
        const source = asset.body.toString('utf8');
        assert(!/\beval\s*\(|\bnew\s+Function\b/.test(source), `${assetPath} requires forbidden unsafe-eval`);
      }
      if (assetPath.endsWith('.css')) {
        assert(asset.headers['content-type'].startsWith('text/css'), `${assetPath} must be CSS`);
        const css = asset.body.toString('utf8');
        extractCssReferences(css).forEach(reference => {
          pendingAssets.push(resolveLocalReference(reference, assetPath));
        });
      }
      if (assetPath.endsWith('.woff2')) {
        assert.strictEqual(asset.headers['content-type'], 'font/woff2', `${assetPath} must be a WOFF2 font`);
      }
    }
    assert(checkedAssets.has('/vendor/chart.js/4.5.1/chart.umd.min.js'));
    assert(checkedAssets.has('/vendor/sortablejs/1.15.7/Sortable.min.js'));
    assert(checkedAssets.has('/vendor/fonts/inter/5.3.0/files/inter-latin-wght-normal.woff2'));
    assert(checkedAssets.has('/vendor/fonts/outfit/5.3.0/files/outfit-latin-wght-normal.woff2'));
    assert(checkedAssets.size >= 45, `expected the complete resource graph, got ${checkedAssets.size} assets`);

    for (const invalidPath of [
      '/vendor/chart.js/0.0.0/chart.umd.min.js',
      '/vendor/sortablejs/0.0.0/Sortable.min.js',
      '/vendor/fonts/inter/5.3.0/files/%2e%2e%2fLICENSE'
    ]) {
      const invalidAsset = await request(server, invalidPath);
      assert.strictEqual(invalidAsset.status, 404, `${invalidPath} must not expose an asset`);
      const invalidPolicy = parsePolicy(invalidAsset.headers['content-security-policy']);
      assert(
        [["'self'"], ["'none'"]].some(value =>
          JSON.stringify(invalidPolicy.get('default-src')) === JSON.stringify(value)),
        `${invalidPath} must retain a restrictive CSP`
      );
    }

    const api = await request(server, '/api/state');
    assert.strictEqual(api.status, 200);
    assert.strictEqual(api.headers['content-security-policy'], page.headers['content-security-policy']);

    const port = server.address().port;
    const before = await request(server, '/api/backup/export');
    const hostileHeaders = [
      { Host: `attacker.example:${port}` },
      { Host: `localhost.attacker.example:${port}` },
      { Host: `127.1:${port}` },
      { Host: `2130706433:${port}` },
      { Host: `localhost.:${port}` },
      { Host: `localhost:${port + 1}` },
      { Host: 'localhost' },
      { Host: [`localhost:${port}`, `attacker.example:${port}`] },
      { Origin: 'http://attacker.example' },
      { Origin: 'null' },
      { Origin: `http://127.0.0.1:${port}/` },
      { Origin: `http://user@127.0.0.1:${port}` },
      { Origin: `https://127.0.0.1:${port}` },
      { Origin: `http://127.0.0.1:${port + 1}` },
      { Origin: `http://localhost:${port}` },
      { Origin: [`http://127.0.0.1:${port}`, 'http://attacker.example'] },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': ['same-origin', 'cross-site'] },
      { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}`, 'Sec-Fetch-Site': 'same-origin' },
      { 'X-Forwarded-Host': `localhost:${port}`, Host: `attacker.example:${port}` }
    ];
    for (const headers of hostileHeaders) {
      for (const [pathname, method, body] of [
        ['/', 'GET'], ['/js/app.js', 'GET'], ['/api/state', 'GET'],
        ['/api/members', 'POST', { name: 'must not be saved' }],
        ['/api/members/me', 'PUT', { name: 'must not be changed' }],
        ['/api/members/mother', 'DELETE'],
        ['/api/backup/import', 'POST', 'invalid backup']
      ]) {
        const rejected = await request(server, pathname, { method, headers, body });
        assert.strictEqual(rejected.status, 403, `${method} ${pathname} must reject ${JSON.stringify(headers)}`);
        const error = JSON.parse(rejected.body);
        assert.strictEqual(error.code, 'FORBIDDEN');
        assert(!error.message.includes(root), 'errors must not expose filesystem paths');
      }
    }
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const headers = { Host: `${host}:${port}`, Origin: `http://${host}:${port}`, 'Sec-Fetch-Site': 'same-origin' };
      assert.strictEqual((await request(server, '/api/state', { headers })).status, 200);
      // Validation is reached for trusted writes; the source guard does not reject them.
      assert.strictEqual((await request(server, '/api/members', { method: 'POST', headers, body: { name: '' } })).status, 400);
    }
    assert.strictEqual((await request(server, '/', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200);
    const after = await request(server, '/api/backup/export');
    const AdmZip = require('adm-zip');
    for (const name of ['data/db.json', 'data/config.json', 'data/settlements.json']) {
      assert.strictEqual(new AdmZip(after.body).readAsText(name), new AdmZip(before.body).readAsText(name),
        `untrusted requests must leave ${name} unchanged`);
    }
    assert.strictEqual((await request(server, '/api/members', { method: 'POST', body: { name: 'trusted CLI' } })).status, 200);
    assert.strictEqual((await request(server, '/api/members', {
      method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' }, body: { name: 'trusted browser' }
    })).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('Complete local resource graph and Content Security Policy assertions passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
