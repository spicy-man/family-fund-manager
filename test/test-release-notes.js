const assert = require('assert');
const { releaseNotes } = require('../scripts/release-notes');

const changelog = '# Changelog\r\n\r\n## ✨ v4.3.0 自动发布 [NEW]\r\n\r\n- 自动打包。\r\n\r\n---\r\n\r\n## 🔧 v4.2.0 旧版本 [FIX]\r\n\r\n- 旧内容。\r\n';
assert.strictEqual(releaseNotes('v4.3.0', '4.3.0', changelog), '## ✨ v4.3.0 自动发布 [NEW]\n\n- 自动打包。\n');
assert.throws(() => releaseNotes('v4.2.0', '4.3.0', changelog), /必须与/);
assert.throws(() => releaseNotes('v4.3.0', '4.3.0', changelog.replace('v4.3.0', 'v4.3.01')), /缺少/);
assert.throws(() => releaseNotes('v4.3.0', '4.3.0', '## ✨ v4.3.0 空说明\n\n---\n'), /为空/);
assert.throws(() => releaseNotes('v4.3.0;echo', '4.3.0;echo', changelog), /必须与/);
assert(releaseNotes('v4.3.0-beta.1', '4.3.0-beta.1', '## ✨ v4.3.0-beta.1 预发布\n\n- 预览。\n').includes('预览'));
console.log('Release tag and changelog assertions passed.');
