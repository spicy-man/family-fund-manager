const fs = require('fs');
const path = require('path');

function releaseNotes(tag, version, changelog) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag || '') || tag !== `v${version}`) {
    throw new Error(`发布标签 ${tag || '(缺失)'} 必须与 package.json 版本 v${version} 一致`);
  }
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(line => /^## /.test(line) && line.split(/\s+/).includes(tag));
  if (start < 0) throw new Error(`CHANGELOG.md 缺少 ${tag} 的更新说明`);
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  const notes = lines.slice(start, end).join('\n').trim().replace(/\n---\s*$/, '').trim();
  if (!lines.slice(start + 1, end).some(line => /^-\s+\S/.test(line))) {
    throw new Error(`${tag} 的更新说明为空`);
  }
  return notes + '\n';
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  process.stdout.write(releaseNotes(process.argv[2], require(path.join(root, 'package.json')).version,
    fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')));
}

module.exports = { releaseNotes };
