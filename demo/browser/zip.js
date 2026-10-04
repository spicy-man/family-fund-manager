const { Buffer } = require('buffer');
const { zipSync } = require('fflate');
class BrowserZip {
  constructor(input) {
    this.files = {};
    this.entries = new Map();
    if (!input) return;
    const data = Buffer.from(input);
    if (data.length > 10 * 1024 * 1024 || data.length < 22) throw new Error('Invalid ZIP size');
    let end = data.length - 22;
    while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || data.readUInt32LE(end) !== 0x06054b50 ||
        end + 22 + data.readUInt16LE(end + 20) !== data.length ||
        data.readUInt32LE(end + 4) !== 0) throw new Error('Invalid ZIP directory');
    const count = data.readUInt16LE(end + 10);
    if (count !== data.readUInt16LE(end + 8) || count > 20) throw new Error('Invalid ZIP entry count');
    let offset = data.readUInt32LE(end + 16);
    const directoryEnd = offset + data.readUInt32LE(end + 12);
    if (directoryEnd > end) throw new Error('Invalid ZIP directory size');
    for (let index = 0; index < count; index++) {
      if (offset + 46 > directoryEnd || data.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry');
      const flags = data.readUInt16LE(offset + 8);
      const method = data.readUInt16LE(offset + 10);
      const nameLength = data.readUInt16LE(offset + 28);
      const extraLength = data.readUInt16LE(offset + 30);
      const commentLength = data.readUInt16LE(offset + 32);
      const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      const local = data.readUInt32LE(offset + 42);
      const compressedSize = data.readUInt32LE(offset + 20);
      if (offset + 46 + nameLength + extraLength + commentLength > directoryEnd ||
          local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50 ||
          data.readUInt16LE(local + 8) !== method || data.readUInt16LE(local + 6) !== flags ||
          this.entries.has(name)) throw new Error('Invalid or duplicate ZIP entry');
      const localNameLength = data.readUInt16LE(local + 26);
      const start = local + 30 + localNameLength + data.readUInt16LE(local + 28);
      if (start + compressedSize > data.readUInt32LE(end + 16) ||
          data.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) throw new Error('Invalid ZIP payload');
      this.entries.set(name, {
        isDirectory: name.endsWith('/'),
        header: { encrypted: Boolean(flags & 1), method, size: data.readUInt32LE(offset + 24),
          compressedSize, crc: data.readUInt32LE(offset + 16) },
        getCompressedData: () => data.subarray(start, start + compressedSize)
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    if (offset !== directoryEnd) throw new Error('Invalid ZIP directory length');
  }
  addFile(name, content) { this.files[name] = new Uint8Array(content); }
  getEntry(name) { return this.entries.get(name); }
  toBuffer() { return Buffer.from(zipSync(this.files, { level: 6 })); }
}
module.exports = BrowserZip;
