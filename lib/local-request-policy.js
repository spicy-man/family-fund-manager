const { ForbiddenError } = require('./api-errors');

// Validate the literal authority, not DNS resolution or proxy-supplied headers.
// Alternate loopback spellings and external names must never serve this app.
function localAuthority(host, port) {
  if (typeof host !== 'string') return null;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/i.exec(host);
  if (!match || Number(match[2] || 80) !== port) return null;
  return host.toLowerCase();
}

function singleHeader(req, name) {
  let count = 0;
  for (let index = 0; index < (req.rawHeaders || []).length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) count++;
  }
  return count <= 1 && (req.headers[name] === undefined || typeof req.headers[name] === 'string');
}

function localRequestPolicy(req, _res, next) {
  const reject = () => next(new ForbiddenError('请求来源不受信任，请通过本机地址访问。'));
  const authority = localAuthority(req.headers.host, req.socket.localPort);
  if (!singleHeader(req, 'host') || !authority) return reject();

  // Apply before static resources and body parsing, including read APIs: a
  // rebinding page must not be able to read the ledger or load local scripts.
  if (!singleHeader(req, 'origin') || !singleHeader(req, 'sec-fetch-site')) return reject();
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return reject();
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin);
      const protocol = req.socket.encrypted ? 'https:' : 'http:';
      const expected = new URL(`${protocol}//${authority}`).origin;
      if (parsed.origin !== expected || origin !== parsed.origin) return reject();
    } catch {
      return reject();
    }
  }
  // No Origin/Fetch Metadata is allowed for local CLI clients. Browsers that
  // send metadata must identify the request as same-origin or user initiated.
  next();
}

module.exports = { localRequestPolicy };
