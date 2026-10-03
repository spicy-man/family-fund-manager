const assert = require('assert');
const { EventEmitter } = require('events');
const { createJsonFetcher, parseWindowsProxy, bypassesProxy } = require('../lib/http-json');
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
  assert(clash.calls[1].args.includes('http://127.0.0.1:7890'));
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
  assert(custom.calls[0].args.includes('http://localhost:9999'));

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
  console.log('External JSON proxy selection and transport assertions passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
