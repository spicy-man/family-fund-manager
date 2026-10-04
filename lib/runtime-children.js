const { execFile } = require('child_process');

// Keep transient network/browser helpers from outliving the ledger service.
const children = new Set();
function runFile(...args) {
  const child = execFile(...args);
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', () => children.delete(child));
  return child;
}
process.once('exit', () => {
  for (const child of children) {
    try { child.kill(); } catch (_) { /* already exited */ }
  }
});
module.exports = { runFile };
