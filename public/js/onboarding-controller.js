(function () {
  function init({ elements, modal, management, isDemoMode = false }) {
    const { onboardingModal, btnStartLedger, btnSwitchLedger, ledgerSelect } = elements;
    let dismissed = false;

    modal.bindAccessible(onboardingModal);

    btnStartLedger?.addEventListener('click', () => {
      dismissed = true;
      modal.close(onboardingModal);
      window.requestAnimationFrame(() => management.openMembersPanel());
    });

    btnSwitchLedger?.addEventListener('click', () => {
      dismissed = true;
      modal.close(onboardingModal);
      ledgerSelect?.focus();
    });

    function showIfEmpty(state) {
      const isEmptyLedger = Array.isArray(state?.events) && state.events.length === 0;
      if (isDemoMode || dismissed || !isEmptyLedger) return false;
      if (!onboardingModal.classList.contains('active')) modal.open(onboardingModal, btnStartLedger);
      return true;
    }

    return { showIfEmpty };
  }

  window.FundOnboarding = { init };
})();
