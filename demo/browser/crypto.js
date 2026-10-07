const { Buffer } = require('buffer');
const { hmac } = require('@noble/hashes/hmac.js');
const { sha256 } = require('@noble/hashes/sha2.js');
function randomBytes(size) { return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size))); }
function createHmac(algorithm, key) {
  if (algorithm !== 'sha256') throw new Error('Unsupported HMAC algorithm');
  let input = '';
  return { update(value) { input += value; return this; }, digest(encoding) {
    return Buffer.from(hmac(sha256, key, new TextEncoder().encode(input))).toString(encoding);
  } };
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function randomInt(min, max) {
  const range = max - min;
  const limit = Math.floor(0x100000000 / range) * range;
  let value;
  do { value = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= limit);
  return min + value % range;
}
module.exports = { randomBytes, randomInt, createHmac, timingSafeEqual };
