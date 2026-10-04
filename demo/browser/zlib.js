const { inflateSync } = require('fflate');
const { Buffer } = require('buffer');
function inflateRawSync(data, { maxOutputLength }) {
  // A fixed output buffer prevents unbounded allocation for malicious archives.
  const output = inflateSync(data, { out: new Uint8Array(maxOutputLength + 1) });
  if (output.length > maxOutputLength) {
    const error = new Error('ZIP data exceeds its output budget');
    error.code = 'ERR_BUFFER_TOO_LARGE';
    throw error;
  }
  return Buffer.from(output);
}
module.exports = { inflateRawSync };
