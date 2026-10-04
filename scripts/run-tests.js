const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tests = [
  "test/test-model.js",
  "test/test-version.js",
  "test/test-storage.js",
  "test/test-data-directory-lock.js",
  "test/test-yahoo.js",
  "test/test-http-json.js",
  "test/test-custom-benchmark.js",
  "test/test-market-history.js",
  "test/test-ticker-cache.js",
  "test/test-ticker-panel-refresh.js",
  "test/test-calculator.js",
  "test/test-performance-settlement.js",
  "test/test-performance-fee-policy.js",
  "test/test-replay-performance.js",
  "test/test-settlement-ledger.js",
  "test/test-event-order.js",
  "test/test-api-errors.js",
  "test/test-api-validation.js",
  "test/test-backup-import.js",
  "test/test-api-integration.js",
  "test/test-demo-mode.js",
  "test/test-static-demo.js",
  "test/test-theme-manager.js",
  "test/test-onboarding.js",
  "test/test-frontend-syntax.js",
  "test/test-controller-regressions.js",
  "test/test-security-policy.js",
  "test/test-css-entry.js",
  "test/test-submission-guard.js",
  "test/test-chart-renderer.js",
  "test/test-ledger-renderer.js",
  "test/test-governance-principles.js",
  "test/test-segmented-control.js",
  "test/test-custom-select.js",
  "test/test-settlement-confirmation.js",
  "test/test-test-isolation.js"
];

// All tests, including future server-based tests, inherit disposable storage.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-fund-tests-'));
try {
  for (const file of tests) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', file)], {
      cwd: path.join(__dirname, '..'), stdio: 'inherit',
      env: { ...process.env, FUND_DATA_DIR: path.join(root, 'data'),
        FUND_BACKUP_DIR: path.join(root, 'backups'), FUND_EXTERNAL_SYNC: '0' }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status || 1; break; }
  }
} finally {
  // root is the absolute directory created above, never a caller-supplied path.
  fs.rmSync(root, { recursive: true, force: true });
}
