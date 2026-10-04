const assert = require('assert');
const { EventEmitter } = require('events');
const http = require('http');
const { createJsonFetcher, parseWindowsProxy, bypassesProxy, MAX_JSON_RESPONSE_BYTES } = require('../lib/http-json');
const url = 'https://query2.finance.yahoo.com/v8/finance/chart/MSFT';
const registry = (enabled, server, bypass = '') => `ProxyEnable REG_DWORD ${enabled}\nProxyServer REG_SZ ${server}\nProxyOverride REG_SZ ${bypass}`;

assert.strictEqual(parseWindowsProxy(registry('0x0', '127.0.0.1:7890')), null);
assert.deepStrictEqual(parseWindowsProxy(registry('0x1', '127.0.0.1:7890')), { proxy: 'http://127.0.0.1:7890', bypass: '' });
assert.strictEqual(parseWindowsProxy(registry('0x1', 'http=localhost:8000')), null);
assert.strictEqual(parseWindowsProxy(registry('0x1', 'http=localhost:8000;https=localhost:9000')).proxy, 'http://localhost:9000');
assert.strictEqual(parseWindowsProxy(registry('0x1', 'socks=localhost:1080')).proxy, 'socks5h://localhost:1080');
assert(bypassesProxy(url, '*.finance.yahoo.com'));
assert(!bypassesProxy(url, '<local>;localhost;*.example.com'));

function harness({ platform = 'win32', env = {}, output = registry('0x1', '127.0.0.1:7890'), directFails = false, curlStatus = 200, curlError = null } = {}) {
  const calls = [];
  let clock = 0;
  const fetch = createJsonFetcher({ platform, env, now: () => clock,
    runFile: (bin, args, options, callback) => {
      calls.push({ bin, args, options });
      if (bin === 'reg.exe') return callback(null, output);
      callback(curlError, `{"transport":"curl"}\n${curlStatus}`);
    },
    get: (target, options, callback) => {
      calls.push({ bin: 'https', target });
      const request = new EventEmitter();
      request.setTimeout = () => {};
      queueMicrotask(() => {
        if (directFails) return request.emit('error', new Error('offline'));
        const res = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        res.emit('data', '{"transport":"direct"}');
        res.emit('end');
      });
      return request;
    }
  });
  return { calls, fetch, advance: () => { clock += 31000; } };
}

(async () => {
  const clash = harness();
  assert.deepStrictEqual(await clash.fetch(url), { transport: 'curl' });
  assert(!clash.calls.some(call => call.bin === 'https'), 'configured proxy must skip the direct request');
  assert(!clash.calls[1].args.includes('--proxy'));
  assert.strictEqual(clash.calls[1].options.env.https_proxy, 'http://127.0.0.1:7890');
  await clash.fetch(url);
  assert.strictEqual(clash.calls.filter(call => call.bin === 'reg.exe').length, 1);
  clash.advance();
  await clash.fetch(url);
  assert.strictEqual(clash.calls.filter(call => call.bin === 'reg.exe').length, 2);

  for (const config of [
    { output: registry('0x0', '127.0.0.1:7890') },
    { output: '' },
    { platform: 'darwin' },
    { platform: 'linux' },
    { env: { FUND_NETWORK_PROXY: 'direct', HTTPS_PROXY: 'http://proxy:8000' } },
    { output: registry('0x1', '127.0.0.1:7890', '*.finance.yahoo.com') }
  ]) {
    const direct = harness(config);
    assert.deepStrictEqual(await direct.fetch(url), { transport: 'direct' });
    assert(!direct.calls.some(call => /curl/.test(call.bin)), 'without an applicable proxy, a working direct connection must not invoke curl');
  }
  const custom = harness({ env: { FUND_NETWORK_PROXY: 'http://localhost:9999' } });
  await custom.fetch(url);
  assert.strictEqual(custom.calls[0].bin, 'curl.exe');
  assert(!custom.calls[0].args.includes('http://localhost:9999'));
  assert.strictEqual(custom.calls[0].options.env.https_proxy, 'http://localhost:9999');

  const credentialEnv = { FUND_NETWORK_PROXY: 'socks5h://alice:secret@localhost:1080',
    https_proxy: 'http://wrong:8000', HTTPS_PROXY: 'http://wrong:9000',
    ALL_PROXY: 'http://wrong:7000', NO_PROXY: '.example.com' };
  const credentials = harness({ env: credentialEnv });
  await credentials.fetch(url);
  const proxyCall = credentials.calls[0];
  assert(!JSON.stringify(proxyCall.args).includes('secret'));
  assert(!proxyCall.args.includes('--proxy'));
  assert.strictEqual(proxyCall.options.env.https_proxy, credentialEnv.FUND_NETWORK_PROXY);
  assert.strictEqual(proxyCall.options.env.HTTPS_PROXY, credentialEnv.FUND_NETWORK_PROXY);
  assert.strictEqual(proxyCall.options.env.http_proxy, credentialEnv.FUND_NETWORK_PROXY);
  assert.strictEqual(proxyCall.options.env.ALL_PROXY, credentialEnv.FUND_NETWORK_PROXY);
  assert.strictEqual(proxyCall.options.env.FUND_NETWORK_PROXY, undefined);
  assert.strictEqual(proxyCall.options.env.NO_PROXY, '.example.com');
  assert.strictEqual(credentialEnv.https_proxy, 'http://wrong:8000', 'parent env must remain unchanged');
  const credentialFailure = harness({ env: credentialEnv,
    curlError: { code: 7, message: 'secret', cmd: 'secret' } });
  await assert.rejects(credentialFailure.fetch(url), error => /curl 7/.test(error.message) &&
    !JSON.stringify(error).includes('secret') && !error.message.includes('secret'));

  const environment = harness({ env: { HTTPS_PROXY: 'http://proxy:8000', NO_PROXY: '.example.com' } });
  await environment.fetch(url);
  assert.strictEqual(environment.calls[0].bin, 'curl.exe');
  assert(!environment.calls[0].args.includes('--proxy'));
  assert.strictEqual(environment.calls[0].options.env.NO_PROXY, '.example.com');

  const fallback = harness({ platform: 'linux', directFails: true });
  assert.deepStrictEqual(await fallback.fetch(url), { transport: 'curl' });
  assert(fallback.calls[1].args.includes('--noproxy'));
  const blocked = harness({ curlStatus: 403 });
  await assert.rejects(blocked.fetch(url), /HTTP 403/);
  const failedProxy = harness({ curlError: { code: 7, message: 'secret credentials' } });
  await assert.rejects(failedProxy.fetch(url), /curl 7/);
  assert(!failedProxy.calls.some(call => call.bin === 'https'), 'a failing configured proxy must not silently fall back to direct');

  function streamHarness(chunks, headers = {}) {
    let fallbackCalls = 0;
    let requestDestroyed = false;
    let responseDestroyed = false;
    const fetch = createJsonFetcher({ platform: 'linux', env: {},
      runFile: (_, args, options, callback) => {
        fallbackCalls++;
        callback(null, '{}\n200');
      },
      get: (_, options, callback) => {
        const request = new EventEmitter();
        request.setTimeout = () => {};
        request.destroy = error => { requestDestroyed = true; request.emit('error', error); };
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = 200;
          response.headers = headers;
          response.destroy = error => { responseDestroyed = true; response.emit('error', error); };
          callback(response);
          for (const chunk of chunks) response.emit('data', chunk);
          response.emit('end');
        });
        return request;
      }
    });
    return { fetch, status: () => ({ fallbackCalls, requestDestroyed, responseDestroyed }) };
  }
  const exactBody = Buffer.from(JSON.stringify('a'.repeat(MAX_JSON_RESPONSE_BYTES - 2)));
  const exact = streamHarness([exactBody.subarray(0, 100), exactBody.subarray(100)]);
  assert.strictEqual((await exact.fetch(url)).length, MAX_JSON_RESPONSE_BYTES - 2);
  assert.deepStrictEqual(exact.status(), { fallbackCalls: 0, requestDestroyed: false, responseDestroyed: false });
  for (const headers of [{}, { 'content-length': '1' }]) {
    const oversized = streamHarness([exactBody, Buffer.from(' ')], headers);
    await assert.rejects(oversized.fetch(url), error => error.code === 'EXTERNAL_RESPONSE_TOO_LARGE');
    assert.deepStrictEqual(oversized.status(), { fallbackCalls: 0, requestDestroyed: true, responseDestroyed: true });
  }
  const declaredOversize = streamHarness([], { 'content-length': String(MAX_JSON_RESPONSE_BYTES + 1) });
  await assert.rejects(declaredOversize.fetch(url), /10MB/);
  assert.strictEqual(declaredOversize.status().fallbackCalls, 0);
  const chinese = Buffer.from('{"text":"中文🙂"}');
  const splitUtf8 = streamHarness([...chinese].map(byte => Buffer.from([byte])));
  assert.deepStrictEqual(await splitUtf8.fetch(url), { text: '中文🙂' });
  const multibyteOversize = streamHarness([JSON.stringify('中'.repeat(Math.ceil(MAX_JSON_RESPONSE_BYTES / 3)))]);
  await assert.rejects(multibyteOversize.fetch(url), /10MB/);
  for (const [body, expectedSuccess] of [[exactBody.toString(), true], [exactBody.toString() + ' ', false]]) {
    const proxy = createJsonFetcher({ env: { HTTPS_PROXY: 'http://localhost:9999' },
      runFile: (_, args, options, callback) => callback(null, body + '\n200') });
    if (expectedSuccess) assert.strictEqual((await proxy(url)).length, MAX_JSON_RESPONSE_BYTES - 2);
    else await assert.rejects(proxy(url), /10MB/);
  }
  const overflow = harness({ curlError: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } });
  await assert.rejects(overflow.fetch(url), error => error.code === 'EXTERNAL_RESPONSE_TOO_LARGE');

  // Exercise real IncomingMessage/ClientRequest destruction, not only mocks.
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    if (req.url === '/declared') {
      res.writeHead(200, { 'Content-Length': MAX_JSON_RESPONSE_BYTES + 1 });
      return res.end(' ');
    }
    if (req.url === '/unicode') return res.end(chinese);
    res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
    res.write(exactBody);
    res.end(req.url === '/oversized' ? ' ' : '');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    let fallbackCalls = 0;
    const liveFetch = createJsonFetcher({ env: {}, platform: 'linux', get: http.get,
      runFile: (_, args, options, callback) => { fallbackCalls++; callback(null, '{}\n200'); } });
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.strictEqual((await liveFetch(`${base}/exact`)).length, MAX_JSON_RESPONSE_BYTES - 2);
    assert.deepStrictEqual(await liveFetch(`${base}/unicode`), { text: '中文🙂' });
    for (const path of ['/oversized', '/declared']) {
      await assert.rejects(liveFetch(base + path), error => error.code === 'EXTERNAL_RESPONSE_TOO_LARGE');
    }
    assert.strictEqual(fallbackCalls, 0);
  } finally {
    server.closeIdleConnections?.();
    await new Promise(resolve => server.close(resolve));
  }

  // Real curl must still apply an explicit authenticated proxy after moving
  // its URL to the environment. The mock tests above verify secret-free argv.
  let proxyRequests = 0;
  const localProxy = http.createServer((req, res) => {
    proxyRequests++;
    assert.strictEqual(req.url, 'http://fund-proxy-test.invalid/data');
    assert.strictEqual(req.headers['proxy-authorization'],
      'Basic ' + Buffer.from('regression:fake-password').toString('base64'));
    res.end('{"proxied":true}');
  });
  await new Promise((resolve, reject) => {
    localProxy.once('error', reject);
    localProxy.listen(0, '127.0.0.1', resolve);
  });
  try {
    const liveProxyFetch = createJsonFetcher({ env: { ...process.env,
      FUND_NETWORK_PROXY: `http://regression:fake-password@127.0.0.1:${localProxy.address().port}`,
      no_proxy: '', NO_PROXY: '' } });
    assert.deepStrictEqual(await liveProxyFetch('http://fund-proxy-test.invalid/data'), { proxied: true });
    assert.strictEqual(proxyRequests, 1);
  } finally {
    localProxy.closeIdleConnections?.();
    await new Promise(resolve => localProxy.close(resolve));
  }
  console.log('External JSON proxy selection and transport assertions passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
