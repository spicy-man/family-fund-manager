const fs = require('fs');
const path = require('path');
const { isSecondaryLedgerId } = require('./ledger-id');

function storedMemberIds(root) {
  const files = [path.join(root, 'db.json'), ...fs.readdirSync(root)
    .filter(isSecondaryLedgerId)
    .filter(name => fs.lstatSync(path.join(root, name)).isDirectory() && !fs.lstatSync(path.join(root, name)).isSymbolicLink())
    .map(name => path.join(root, name, 'db.json'))];
  return new Set(files.filter(file => fs.existsSync(file)).flatMap(file =>
    (JSON.parse(fs.readFileSync(file, 'utf8')).members || []).map(member => member.id)));
}

module.exports = { storedMemberIds };
