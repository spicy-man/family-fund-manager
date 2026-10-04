const https = require('https');
const { runFile: execFile } = require('./runtime-children');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_JSON_RESPONSE_BYTES = 10 * 1024 * 1024;

function responseSizeError() {
  const error = new Error('External JSON response exceeds the 10MB limit');
  error.code = 'EXTERNAL_RESPONSE_TOO_LARGE';
  return error;
}

function parseWindowsProxy(output) {
  const enabled = output.match(/ProxyEnable\s+REG_DWORD\s+(\S+)/i);
  if (!enabled || Number(enabled[1]) !== 1) return null;
  const server = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim();
  if (!server) return null;
  const entries = Object.fromEntries(server.split(';').filter(item => item.includes('=')).map(item => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim().toLowerCase(), item.slice(index + 1).trim()];
  }));
  // Yahoo and all exchange-rate providers use HTTPS. An HTTP-only entry must
  // not silently become the HTTPS proxy.
  const address = server.includes('=') ? entries.https || entries.socks : server;
  if (!address) return null;
  const proxy = /^[a-z][a-z0-9+.-]*:\/\//i.test(address)
    ? address
    : `${!entries.https && entries.socks ? 'socks5h' : 'http'}://${address}`;
  const bypass = output.match(/ProxyOverride\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim() || '';
  return { proxy, bypass };
}

function bypassesProxy(url, rules) {
  const host = new URL(url).hostname.toLowerCase();
  return rules.split(/[;,]/).some(raw => {
    const rule = raw.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '<local>') return !host.includes('.');
    const pattern = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${pattern}$`).test(host);
  });
}

function createJsonFetcher({ platform = process.platform, env = process.env,
  runFile = execFile, get = https.get, now = Date.now } = {}) {
  let registryPromise;
  let registryExpires = 0;

  async function proxyFor(url) {
    const configured = env.FUND_NETWORK_PROXY?.trim();
    if (configured?.toLowerCase() === 'direct') return { direct: true };
    if (configured) return { proxy: configured };
    // Let curl apply its own environment proxy and NO_PROXY semantics.
    if (['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].some(key => env[key])) {
      return { environment: true };
    }
    if (platform !== 'win32') return { direct: true };
    if (!registryPromise || now() >= registryExpires) {
      registryExpires = now() + 30000;
      registryPromise = new Promise(resolve => {
        runFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
          { timeout: 2000, windowsHide: true }, (error, output) => {
            resolve(error ? null : parseWindowsProxy(output));
          });
      });
    }
    const system = await registryPromise;
    return system && !bypassesProxy(url, system.bypass) ? system : { direct: true };
  }

  function curlJson(url, policy) {
    return new Promise((resolve, reject) => {
      const args = ['-sS', '-L', '--max-time', '15', '-A', USER_AGENT];
      // Keep explicit proxy URLs (including credentials) out of process argv.
      // Override competing proxy variables for explicit policy,
      // matching the previous --proxy behavior. Do not mutate the caller's env.
      const childEnv = { ...env };
      delete childEnv.FUND_NETWORK_PROXY;
      if (policy.proxy) {
        for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY',
          'all_proxy', 'ALL_PROXY']) delete childEnv[key];
        childEnv.https_proxy = policy.proxy;
        childEnv.HTTPS_PROXY = policy.proxy;
        childEnv.http_proxy = policy.proxy;
        childEnv.all_proxy = policy.proxy;
        childEnv.ALL_PROXY = policy.proxy;
      }
      if (policy.direct) args.push('--noproxy', '*');
      args.push('-w', '\n%{http_code}', url);
      runFile(platform === 'win32' ? 'curl.exe' : 'curl', args,
        { env: childEnv, timeout: 16000, maxBuffer: MAX_JSON_RESPONSE_BYTES + 16, windowsHide: true }, (error, output = '') => {
          // execFile errors include all arguments, which may contain proxy
          // credentials. Report only the code, never the command line.
          if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(responseSizeError());
          if (error) return reject(new Error(`External request failed (curl ${error.code || 'timeout'})`));
          const split = output.lastIndexOf('\n');
          const status = Number(output.slice(split + 1));
          if (status < 200 || status >= 300 || !status) return reject(new Error(`External request returned HTTP ${status || 'unknown'}`));
          const body = output.slice(0, split);
          if (Buffer.byteLength(body) > MAX_JSON_RESPONSE_BYTES) return reject(responseSizeError());
          try { resolve(JSON.parse(body)); }
          catch (_) { reject(new Error('External request returned non-JSON data')); }
        });
    });
  }

  function directJson(url) {
    return new Promise((resolve, reject) => {
      const request = get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
        let chunks = [];
        let bytes = 0;
        let finished = false;
        const fail = error => {
          if (finished) return;
          finished = true;
          chunks = [];
          reject(error);
        };
        const rejectSize = () => {
          const error = responseSizeError();
          fail(error);
          res.destroy(error);
          request.destroy(error);
        };
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('External response was aborted')));
        res.on('data', chunk => {
          if (finished) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_JSON_RESPONSE_BYTES) return rejectSize();
          chunks.push(buffer);
        });
        res.on('end', () => {
          if (finished) return;
          if (res.statusCode < 200 || res.statusCode >= 300) return fail(new Error(`External request returned HTTP ${res.statusCode}`));
          try {
            const data = Buffer.concat(chunks, bytes).toString('utf8');
            chunks = [];
            const parsed = JSON.parse(data);
            finished = true;
            resolve(parsed);
          } catch (_) { fail(new Error('External request returned non-JSON data')); }
        });
        const declaredLength = res.headers?.['content-length'];
        if (typeof declaredLength === 'string' && /^\d+$/.test(declaredLength) &&
            Number(declaredLength) > MAX_JSON_RESPONSE_BYTES) rejectSize();
      });
      request.setTimeout(10000, () => request.destroy(new Error('External request timed out')));
      request.on('error', reject);
    });
  }

  return async function fetchJson(url) {
    const policy = await proxyFor(url);
    if (!policy.direct) return curlJson(url, policy);
    try { return await directJson(url); }
    catch (error) {
      if (error.code === 'EXTERNAL_RESPONSE_TOO_LARGE') throw error;
      return curlJson(url, policy);
    }
  };
}

module.exports = { createJsonFetcher, parseWindowsProxy, bypassesProxy, MAX_JSON_RESPONSE_BYTES };
