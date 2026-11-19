(function () {
  function create({ elements, showToast }) {
    const { privacyButtons } = elements;
    let privacyMode = !window.FundDemoMode?.enabled;
    // Consume the one-time state passed by the ledger switcher. Refreshes use the default.
    const privacyStorageKey = 'family_fund_ledger_privacy_transfer';
    if (!window.FundDemoMode?.enabled) {
      try {
        const saved = window.sessionStorage.getItem(privacyStorageKey);
        window.sessionStorage.removeItem(privacyStorageKey);
        const transfer = saved ? JSON.parse(saved) : null;
        if (transfer?.ledgerId === (window.FundLedger?.id || 'default') && typeof transfer.privacyMode === 'boolean') {
          privacyMode = transfer.privacyMode;
        }
      } catch (_error) {
        // Keep the private default when browser storage is unavailable.
      }
    }

    function init() {
      document.body.classList.toggle('privacy-mode-active', privacyMode);
      if (privacyMode) window.FundCountUp?.finishAll();
      privacyButtons.forEach(button => {
        if (!button) return;
        button.setAttribute('aria-pressed', String(privacyMode));
        button.addEventListener('click', () => {
          privacyMode = !privacyMode;
          document.body.classList.toggle('privacy-mode-active', privacyMode);
          if (privacyMode) window.FundCountUp?.finishAll();
          privacyButtons.forEach(item => item?.setAttribute('aria-pressed', String(privacyMode)));
          showToast(privacyMode ? '隐私模式已开启，敏感财务数据已模糊隐藏' : '隐私模式已关闭', privacyMode ? 'success' : 'warning');
        });
      });
    }

    return { init };
  }

  window.FundSettingsController = { create };
})();
