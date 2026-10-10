(function () {
  function create({ elements, api, segmentedControl, getState, setState, renderCharts, showToast }) {
    const { benchmarkPolicyGroup, benchmarkPolicyButtons, privacyButtons } = elements;
    let refreshToken = 0;
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

    function syncBenchmarkPolicy(policy = 'previous') {
      const activeButton = benchmarkPolicyButtons.find(button => button.dataset.benchmarkPolicy === policy)
        || benchmarkPolicyButtons[0];
      segmentedControl.activate(benchmarkPolicyGroup, activeButton);
    }

    async function waitForBenchmarkRefresh(policy, token) {
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        if (token !== refreshToken) return false;
        let nextState;
        try {
          nextState = await api.getState();
        } catch (_error) {
          continue;
        }
        if (nextState.settings?.benchmarkClosePolicy !== policy) continue;
        if (!nextState.settings?.benchmarkCacheReady) continue;
        setState(nextState);
        renderCharts();
        return true;
      }
      return false;
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

      benchmarkPolicyButtons.forEach(button => {
        button.addEventListener('click', async event => {
          const selectedButton = event.currentTarget;
          const nextPolicy = selectedButton.dataset.benchmarkPolicy;
          const previousPolicy = getState()?.settings?.benchmarkClosePolicy || 'previous';
          if (nextPolicy === previousPolicy) return;
          const token = ++refreshToken;
          benchmarkPolicyGroup?.setAttribute('aria-busy', 'true');
          benchmarkPolicyButtons.forEach(option => { option.disabled = true; });
          segmentedControl.activate(benchmarkPolicyGroup, selectedButton);
          try {
            await api.updateSettings({ benchmarkClosePolicy: nextPolicy });
            const state = getState();
            if (state?.settings) {
              state.settings.benchmarkClosePolicy = nextPolicy;
              state.settings.benchmarkCacheReady = false;
            }
            const refreshed = await waitForBenchmarkRefresh(nextPolicy, token);
            showToast(refreshed ? '指数收盘口径已更新' : '口径已保存，指数数据仍在后台刷新', refreshed ? 'success' : 'warning');
          } catch (error) {
            syncBenchmarkPolicy(previousPolicy);
            showToast('指数口径更新失败：' + error.message, 'error');
          } finally {
            if (token === refreshToken) {
              benchmarkPolicyGroup?.removeAttribute('aria-busy');
              benchmarkPolicyButtons.forEach(option => { option.disabled = false; });
            }
          }
        });
      });
    }

    return { init, syncBenchmarkPolicy };
  }

  window.FundSettingsController = { create };
})();
