const https = require('https');
const { execFile } = require('child_process');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
      if (policy.proxy) args.push('--proxy', policy.proxy);
      if (policy.direct) args.push('--noproxy', '*');
      args.push('-w', '\n%{http_code}', url);
      runFile(platform === 'win32' ? 'curl.exe' : 'curl', args,
        { env, timeout: 16000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, output = '') => {
          // execFile errors include all arguments, which may contain proxy
          // credentials. Report only the code, never the command line.
          if (error) return reject(new Error(`External request failed (curl ${error.code || 'timeout'})`));
          const split = output.lastIndexOf('\n');
          const status = Number(output.slice(split + 1));
          if (status < 200 || status >= 300 || !status) return reject(new Error(`External request returned HTTP ${status || 'unknown'}`));
          try { resolve(JSON.parse(output.slice(0, split))); }
          catch (_) { reject(new Error('External request returned non-JSON data')); }
        });
    });
  }

  function directJson(url) {
    return new Promise((resolve, reject) => {
      const request = get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`External request returned HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(data)); }
          catch (_) { reject(new Error('External request returned non-JSON data')); }
        });
      });
      request.setTimeout(10000, () => request.destroy(new Error('External request timed out')));
      request.on('error', reject);
    });
  }

  return async function fetchJson(url) {
    const policy = await proxyFor(url);
    if (!policy.direct) return curlJson(url, policy);
    try { return await directJson(url); }
    catch (_) { return curlJson(url, policy); }
  };
}

module.exports = { createJsonFetcher, parseWindowsProxy, bypassesProxy };
