(function () {
  function init({ elements, modal, segmentedControl, navigation, switchOperationView, formController, management, getAllocationChart }) {
    const {
      backupModal, btnCloseModal, principlesModal, btnClosePrinciplesModal,
      activeReturnCard, returnDetailsModal, btnCloseReturnDetails,
      memberModal, btnCloseMemberModal, btnSaveMemberSettings,
      editEventModal, btnCloseEditModal, tickerConfigModal, btnCloseTickerConfigModal,
      settlementPreviewModal, btnCloseSettlementPreview, btnCancelSettlement,
      memberViewTabs, membersGridContainer, btnTabTx, btnTabVal, btnTabTf,
      btnTabSettle, formTransaction, formValuation, formTransfer, formSettlement,
      inputCnhRate, tfRate
    } = elements;
    let activeMemberView = 'assets';

    modal.bindAccessible(backupModal, btnCloseModal);
    modal.bindAccessible(principlesModal, btnClosePrinciplesModal);
    modal.bindAccessible(returnDetailsModal, btnCloseReturnDetails);
    const openReturnDetails = () => modal.open(returnDetailsModal, activeReturnCard);
    activeReturnCard?.addEventListener('click', openReturnDetails);
    activeReturnCard?.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openReturnDetails();
    });
    modal.bindAccessible(memberModal, btnCloseMemberModal);
    btnSaveMemberSettings?.addEventListener('click', () => modal.close(memberModal));
    modal.bindAccessible(editEventModal, btnCloseEditModal);
    modal.bindAccessible(tickerConfigModal, btnCloseTickerConfigModal);
    modal.bindAccessible(settlementPreviewModal, btnCloseSettlementPreview);
    btnCancelSettlement?.addEventListener('click', () => modal.close(settlementPreviewModal));
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const topmostModal = [...document.querySelectorAll('.modal-overlay.active')].at(-1);
      if (!topmostModal) return;
      if (topmostModal.dataset.modalPersistent === 'true') return;
      event.preventDefault();
      modal.close(topmostModal);
    });

    document.querySelectorAll('[data-sidebar-action]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.sidebarAction;
        if (action === 'principles') modal.open(principlesModal, button);
        if (action === 'members') management.openMembersPanel();
        if (action === 'backup') management.openBackupPanel();
      });
    });

    const memberViewsStage = document.querySelector('.member-views-stage');
    const memberAllocationSummary = document.querySelector('.member-allocation-summary');
    document.querySelectorAll('[data-member-view]').forEach(button => {
      button.addEventListener('click', event => {
        const nextView = event.currentTarget.dataset.memberView;
        if (nextView === activeMemberView) return;
        const currentHeight = memberViewsStage?.offsetHeight || 0;
        if (memberViewsStage) memberViewsStage.style.height = `${currentHeight}px`;
        activeMemberView = nextView;
        segmentedControl.activate(memberViewTabs, event.currentTarget);
        membersGridContainer.classList.toggle('active', activeMemberView === 'assets');
        memberAllocationSummary?.classList.toggle('active', activeMemberView === 'allocation');
        const targetHeight = memberViewsStage?.scrollHeight || currentHeight;
        requestAnimationFrame(() => {
          if (memberViewsStage) memberViewsStage.style.height = `${targetHeight}px`;
          if (activeMemberView === 'allocation') getAllocationChart()?.resize();
        });
        window.setTimeout(() => {
          if (memberViewsStage) memberViewsStage.style.height = '';
        }, 280);
      });
    });

    navigation.init();
    requestAnimationFrame(segmentedControl.syncAll);
    window.addEventListener('resize', segmentedControl.syncAll);
    btnTabTx.addEventListener('click', () => switchOperationView(btnTabTx, formTransaction));
    btnTabVal.addEventListener('click', () => switchOperationView(btnTabVal, formValuation));
    btnTabTf.addEventListener('click', () => {
      switchOperationView(btnTabTf, formTransfer, () => {
        tfRate.value = (parseFloat(inputCnhRate.value) || 7.2).toFixed(4);
        formController.updateTransferDisplay();
      });
    });
    btnTabSettle.addEventListener('click', () => switchOperationView(btnTabSettle, formSettlement));
  }

  window.FundAppShell = { init };
})();
