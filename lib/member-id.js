const { randomInt } = require('crypto');
function generateMemberId(used, draw = () => String(randomInt(100000, 1000000))) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = draw();
    if (!/^[1-9][0-9]{5}$/.test(id)) throw new Error('生成的成员编号须为六位数字。');
    if (!used.has(id)) { used.add(id); return id; }
  }
  throw new Error('无法生成未使用的成员编号，请重试。');
}
module.exports = { generateMemberId };
