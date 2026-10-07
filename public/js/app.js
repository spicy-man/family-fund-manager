/**
 * 前端核心应用控制逻辑 (app.js)
 * 升级版：支持美元 (USD - $) 记账及完全动态家庭成员管理 (无上限)
 */

document.addEventListener('DOMContentLoaded', () => {
  const welcomeMessages = window.FundDemoMode?.enabled ? [
    window.FundDemoMode.sandbox ? 'Explore the Sandbox' : 'Explore the Demo'
  ] : [
    'Hello, Investor',
    'Welcome Back, Investor',
    'Good to See You',
    'Ready for Today?',
    'Your Portfolio Awaits',
    'Nice to Have You Back',
    'A Fresh View, Investor'
  ];
  const welcomeMessage = document.getElementById('welcome-message');
  let previousWelcome = null;
  try {
    previousWelcome = sessionStorage.getItem('lastWelcomeMessage');
  } catch (_error) {
    // The greeting can still rotate when browser storage is unavailable.
  }
  const availableWelcomeMessages = welcomeMessages.length === 1 ? welcomeMessages
    : welcomeMessages.filter(message => message !== previousWelcome);
  const nextWelcome = availableWelcomeMessages[Math.floor(Math.random() * availableWelcomeMessages.length)];

  if (welcomeMessage && nextWelcome) {
    welcomeMessage.textContent = nextWelcome;
    try {
      sessionStorage.setItem('lastWelcomeMessage', nextWelcome);
    } catch (_error) {
      // Keep the selected greeting without persisting it.
    }
  }

  const {
    getThemeColors,
    isDarkTheme,
    getAvatarText,
    getMemberAvatarColor,
    formatMonthDay,
    escapeHtml,
    formatMoney,
    createChartGradient,
    getSeriesColors,
    hexToRgba
  } = window.FundUiUtils;
  const { open: openModal, close: closeModal } = window.FundModal;
  const { getLatestValuationDate } = window.FundDateTime;

  const notifications = window.FundNotifications.create({ escapeHtml });
  const { showToast, showSubmissionSuccess } = notifications;

  // --- 全局状态 ---
  let appState = null;
  let membersList = [];
  let activeTimeSlice = 'YTD';
  let activeScaleType = 'linear'; // 'linear' or 'logarithmic'
  let navTrendChart = null;
  let memberAllocationChart = null;
  let currentFilteredHistory = [];
  let currentTrendStatSeries = [];
  let renderTrendStats = null;
  let isTrendStatsHovering = false;
  let hasPromptedGpSetup = false;
  let onboardingController = null;
  let formController = null;
  let disposalTrial = null;
  let memberEditor = null;
  let ledgerActions = null;
  const memberStatement = window.FundMemberStatementController.create({
    getState: () => appState, getMembers: () => membersList,
    modal: window.FundModal, ui: window.FundUiUtils, showToast
  });

  // --- DOM 元素定义 ---
  const elSystemTime = document.getElementById('system-time');
  const themeBtns = document.querySelectorAll('[data-theme-btn]');
  const themeSelectorGroup = document.querySelector('.theme-selector-group');
  const memberViewTabs = document.querySelector('.tab-buttons');
  const btnPrivacyToggle = document.getElementById('btn-privacy-toggle');
  const btnSettlementPrivacyToggle = document.getElementById('btn-settlement-privacy-toggle');
  const onboardingModal = document.getElementById('onboarding-modal');
  const btnStartLedger = document.getElementById('btn-start-ledger');

  // Dashboard Metrics
  const elFundTotalNav = document.getElementById('fund-total-nav');
  const elFundTotalShares = document.getElementById('fund-total-shares');
  const elFundNavPerShare = document.getElementById('fund-nav-per-share');
  const elNavIndicator = document.getElementById('nav-indicator');
  const elFundActiveProfitRate = document.getElementById('fund-active-profit-rate');
  const elFundActiveProfitRateSub = document.getElementById('fund-active-profit-rate-sub');
  const activeReturnCard = document.getElementById('active-return-card');
  const returnDetailsModal = document.getElementById('return-details-modal');
  const btnCloseReturnDetails = document.getElementById('btn-close-return-details');
  const assetsDetailsPrincipal = document.getElementById('assets-details-principal');
  const assetsDetailsActiveProfit = document.getElementById('assets-details-active-profit');
  const assetsDetailsHistoryProfit = document.getElementById('assets-details-history-profit');
  const assetsDetailsTotalDeposit = document.getElementById('assets-details-total-deposit');
  const assetsDetailsTotalWithdraw = document.getElementById('assets-details-total-withdraw');
  const assetsDetailsExitedPrincipal = document.getElementById('assets-details-exited-principal');
  const assetsDetailsExitedProfit = document.getElementById('assets-details-exited-profit');
  const assetsDetailsWithdrawCheck = document.getElementById('assets-details-withdraw-check');
  const assetsDetailsProfitCheck = document.getElementById('assets-details-profit-check');

  // The overview is deliberately terse: one aligned title, one key figure, one supporting fact.
  document.querySelectorAll('.metric-label').forEach((label, index) => {
    label.textContent = ['总资产', '单位净值', '在管本金收益率'][index] || label.textContent;
  });

  // Dynamic Containers
  const elMembersGridContainer = document.getElementById('members-grid-container');
  const elTxMember = document.getElementById('tx-member');
  const filterMember = document.getElementById('filter-member');

  // Trend Comparison Checkboxes
  const chkCompNav = document.getElementById('chk-comp-nav');
  const chkCompAssets = document.getElementById('chk-comp-assets');
  const chkCompSp500 = document.getElementById('chk-comp-sp500');
  const chkCompNdx = document.getElementById('chk-comp-ndx');
  const chkCompCustom = document.getElementById('chk-comp-custom');
  const chkCompCustom2 = document.getElementById('chk-comp-custom-2');
  const customBenchmarkLabel = document.getElementById('custom-benchmark-label');
  const customBenchmarkLabelText = document.getElementById('custom-benchmark-label-text');
  const customBenchmarkLabel2 = document.getElementById('custom-benchmark-label-2');
  const customBenchmarkLabelText2 = document.getElementById('custom-benchmark-label-text-2');
  const btnConfigCustomBenchmark = document.getElementById('btn-config-custom-benchmark');
  const btnConfigCustomBenchmark2 = document.getElementById('btn-config-custom-benchmark-2');
  const elTrendStatsGrid = document.getElementById('trend-stats-grid');
  const benchmarkPolicyGroup = document.getElementById('benchmark-policy-group');
  const benchmarkPolicyButtons = [...document.querySelectorAll('[data-benchmark-policy]')];

  // Operation Tabs & Forms
  const btnTabTx = document.getElementById('tab-btn-tx');
  const btnTabVal = document.getElementById('tab-btn-val');
  const btnTabTf = document.getElementById('tab-btn-tf');
  const btnTabSettle = document.getElementById('tab-btn-settle');
  const operationTabs = document.querySelector('.operation-tabs');
  const operationPanel = document.querySelector('.operations-panel');
  const formTransaction = document.getElementById('form-transaction');
  const formValuation = document.getElementById('form-valuation');
  const formTransfer = document.getElementById('form-transfer');
  const formSettlement = document.getElementById('form-settlement');

  // Form elements
  const txAmount = document.getElementById('tx-amount');
  const txDate = document.getElementById('tx-date');
  const txRemark = document.getElementById('tx-remark');
  const valTotalNav = document.getElementById('val-total-nav');
  const valDate = document.getElementById('val-date');
  const valRemark = document.getElementById('val-remark');

  // Transfer form elements
  const tfFromMember = document.getElementById('tf-from-member');
  const tfToMember = document.getElementById('tf-to-member');
  const tfAmount = document.getElementById('tf-amount');
  const tfRate = document.getElementById('tf-rate');
  const tfCnhDisplay = document.getElementById('tf-cnh-display');
  const tfDate = document.getElementById('tf-date');
  const tfRemark = document.getElementById('tf-remark');
  const settleGp = document.getElementById('settle-gp');
  const settleDate = document.getElementById('settle-date');
  const settleRemark = document.getElementById('settle-remark');
  const btnPreviewSettlement = document.getElementById('btn-preview-settlement');
  const btnConfirmSettlement = document.getElementById('btn-confirm-settlement');
  const btnReverseSettlement = document.getElementById('btn-reverse-settlement');
  const settlementPreviewModal = document.getElementById('settlement-preview-modal');
  const btnCloseSettlementPreview = document.getElementById('btn-close-settlement-preview');
  const btnCancelSettlement = document.getElementById('btn-cancel-settlement');
  const settlementPreviewSubtitle = document.getElementById('settlement-preview-subtitle');
  const settlementPreviewSummary = document.getElementById('settlement-preview-summary');
  const settlementPreviewBody = document.getElementById('settlement-preview-body');
  const settlementPreviewFeeHeading = document.getElementById('settlement-preview-fee-heading');

  // Fund Governance Principles Modal
  const principlesModal = document.getElementById('principles-modal');
  const btnClosePrinciplesModal = document.getElementById('btn-close-principles-modal');

  // Ledger Filter & Body
  const filterType = document.getElementById('filter-type');
  const ledgerTbody = document.getElementById('ledger-tbody');

  // Backup Modal
  const backupModal = document.getElementById('backup-modal');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const btnTriggerUpload = document.getElementById('btn-trigger-upload');
  const fileImport = document.getElementById('file-import');
  const fileNameLabel = document.getElementById('file-name-label');
  const btnConfirmImport = document.getElementById('btn-confirm-import');

  // Edit Event Modal
  const editEventModal = document.getElementById('edit-event-modal');
  const btnCloseEditModal = document.getElementById('btn-close-edit-modal');
  const formEditEvent = document.getElementById('form-edit-event');
  const editEventId = document.getElementById('edit-event-id');
  const editEventType = document.getElementById('edit-event-type');
  const editMember = document.getElementById('edit-member');
  const editAmount = document.getElementById('edit-amount');
  const editCnhAmount = document.getElementById('edit-cnh-amount');
  const editDate = document.getElementById('edit-date');
  const editRemark = document.getElementById('edit-remark');
  const txCnhAmount = document.getElementById('tx-cnh-amount');
  const inputCnhRate = document.getElementById('input-cnh-rate');

  // Edit Transfer elements
  const editFromMember = document.getElementById('edit-from-member');
  const editToMember = document.getElementById('edit-to-member');
  const editCnhRate = document.getElementById('edit-cnh-rate');

  // Member Management Modal
  const memberModal = document.getElementById('member-modal');
  const btnCloseMemberModal = document.getElementById('btn-close-member-modal');
  const btnSaveMemberSettings = document.getElementById('btn-save-member-settings');
  const formAddMember = document.getElementById('form-add-member');
  const newMemberName = document.getElementById('new-member-name');
  const elMembersEditList = document.getElementById('members-edit-list');
  const gpSetupWarning = document.getElementById('gp-setup-warning');

  // Ticker Config Modal
  const btnConfigTickers = document.getElementById('btn-config-tickers');
  const btnRefreshTickers = document.getElementById('btn-refresh-tickers');
  const tickerConfigModal = document.getElementById('ticker-config-modal');
  const btnCloseTickerConfigModal = document.getElementById('btn-close-ticker-config-modal');
  const tickerConfigList = document.getElementById('ticker-config-list');
  const btnAddTickerRow = document.getElementById('btn-add-ticker-row');
  const btnSaveTickerConfig = document.getElementById('btn-save-ticker-config');

  const customBenchmarkModal = document.getElementById('custom-benchmark-modal');
  const customBenchmarkModalTitle = document.getElementById('custom-benchmark-modal-title');
  const btnCloseCustomBenchmarkModal = document.getElementById('btn-close-custom-benchmark-modal');
  const customBenchmarkName = document.getElementById('custom-benchmark-name');
  const customBenchmarkComponents = document.getElementById('custom-benchmark-components');
  const customBenchmarkTotal = document.getElementById('custom-benchmark-total');
  const btnAddCustomBenchmarkRow = document.getElementById('btn-add-custom-benchmark-row');
  const btnSaveCustomBenchmark = document.getElementById('btn-save-custom-benchmark');
  const btnRemoveCustomBenchmark = document.getElementById('btn-remove-custom-benchmark');

  const { switchTo: switchOperationView, animateChange: animateOperationChange } = window.FundOperationPanel.create({
    panel: operationPanel,
    tabs: operationTabs,
    forms: [formTransaction, formValuation, formTransfer, formSettlement],
    segmentedControl: window.FundSegmentedControl
  });

  // Keep operations and market tracking in one right-side flex column so their gap is structural.
  const rightColumn = document.querySelector('.layout-right');
  const tickerAthPanel = document.getElementById('ticker-ath-container');
  if (rightColumn && tickerAthPanel) rightColumn.appendChild(tickerAthPanel);

  const themeController = window.FundTheme.create({
    buttons: themeBtns,
    group: themeSelectorGroup,
    segmentedControl: window.FundSegmentedControl,
    onApply: updateChartsColors,
    onSelect: (_theme, button) => showToast(`已切换至 ${button.textContent.trim()} 模式`, 'success')
  });
  const checkIfDark = () => themeController.isDark();
  const settingsController = window.FundSettingsController.create({
    elements: {
      benchmarkPolicyGroup,
      benchmarkPolicyButtons,
      privacyButtons: [document.getElementById('btn-overview-privacy-toggle'), btnPrivacyToggle, btnSettlementPrivacyToggle, document.getElementById('btn-statement-privacy-toggle'), document.getElementById('tx-trial-privacy-toggle'), document.getElementById('tf-trial-privacy-toggle')]
    },
    api: Api,
    segmentedControl: window.FundSegmentedControl,
    getState: () => appState,
    setState: state => { appState = state; },
    renderCharts,
    showToast
  });

  // --- 初始化运行 ---
  window.FundDateTime.startClock(elSystemTime);
  themeController.init();
  settingsController.init();
  const resetDefaultDates = () => window.FundDateTime.setDefaultDates({
    transactionDate: txDate,
    valuationDate: valDate,
    transferDate: tfDate,
    settlementDate: settleDate
  });
  resetDefaultDates();
  window.FundCustomSelect?.init();
  initControllers();
  loadAllData();
  loadTickerAthData();
  setInterval(loadTickerAthData, 5 * 60 * 1000);

  // --- 业务控制器初始化 ---
  function initControllers() {
    disposalTrial = window.FundDisposalTrial.init({ api: Api, formatMoney, animateOperationChange });
    formController = window.FundTransactionController.init({
      elements: {
        txDate, tfDate, valDate, editDate, editEventType,
        tfAmount, tfRate, tfCnhDisplay, inputCnhRate,
        formTransfer, tfFromMember, tfToMember, tfRemark,
        editAmount, editCnhAmount, formEditEvent, editEventId,
        editRemark, editMember, editFromMember, editToMember,
        editCnhRate, editEventModal, formTransaction, elTxMember,
        txAmount, txCnhAmount, txRemark, formValuation, valTotalNav, valRemark
      },
      api: Api,
      submission: window.FundSubmission,
      getPreviewToken: prefix => disposalTrial.token(prefix),
      resetDefaultDates,
      loadAllData,
      showToast,
      showSubmissionSuccess,
      closeModal,
      getLatestValuationDate,
      formatMoney
    });

    memberEditor = window.FundMemberEditor.create({
      elements: { gpSetupWarning, elMembersEditList },
      api: Api,
      getMembers: () => membersList,
      setMembers: value => { membersList = value; },
      getState: () => appState,
      checkIfDark,
      loadAllData,
      showToast,
      ui: { escapeHtml, getAvatarText, getMemberAvatarColor }
    });
    ledgerActions = window.FundLedgerActions.create({
      elements: { ledgerTbody, editEventId, editEventType, editDate, editRemark, editMember,
        editAmount, editCnhAmount, editFromMember, editToMember, editCnhRate, editEventModal },
      api: Api,
      getState: () => appState,
      loadAllData,
      notifications,
      modal: window.FundModal,
      customSelect: window.FundCustomSelect,
      prepareEdit: formController.prepareEdit,
      getLatestValuationDate,
      formatMoney
    });

    const managementController = window.FundManagementController.init({
      elements: {
        memberModal, backupModal, formAddMember, newMemberName,
        btnTriggerUpload, fileImport, fileNameLabel, btnConfirmImport
      },
      api: Api,
      modal: window.FundModal,
      loadAllData,
      renderMembersEditorList: () => memberEditor.render(),
      showToast
    });
    const { openMembersPanel, openBackupPanel } = managementController;
    onboardingController = window.FundOnboarding.init({
      elements: { onboardingModal, btnStartLedger,
        btnSwitchLedger: document.getElementById('btn-onboarding-switch-ledger'),
        ledgerSelect: document.getElementById('ledger-select') },
      modal: window.FundModal,
      management: managementController,
      isDemoMode: window.FundDemoMode?.enabled === true
    });

    window.FundMetricDetails.bind(activeReturnCard, returnDetailsModal, btnCloseReturnDetails);
    window.FundMetricDetails.bind(
      document.getElementById('assets-details-card'),
      document.getElementById('assets-details-popover'),
      document.getElementById('btn-close-assets-details')
    );
    window.FundMetricDetails.bind(
      document.getElementById('nav-details-card'),
      document.getElementById('nav-details-popover'),
      document.getElementById('btn-close-nav-details')
    );

    window.FundAppShell.init({
      elements: {
        backupModal, btnCloseModal, principlesModal, btnClosePrinciplesModal,
        memberModal, btnCloseMemberModal, btnSaveMemberSettings,
        editEventModal, btnCloseEditModal, tickerConfigModal, btnCloseTickerConfigModal,
        settlementPreviewModal, btnCloseSettlementPreview, btnCancelSettlement,
        memberViewTabs, membersGridContainer: elMembersGridContainer,
        btnTabTx, btnTabVal, btnTabTf, btnTabSettle,
        formTransaction, formValuation, formTransfer, formSettlement,
        inputCnhRate, tfRate
      },
      saveMemberSettings: () => memberEditor.savePendingNames(),
      modal: window.FundModal,
      segmentedControl: window.FundSegmentedControl,
      navigation: window.FundNavigation,
      switchOperationView,
      formController,
      management: managementController,
      getAllocationChart: () => memberAllocationChart
    });

    window.FundSettlementController.init({
      elements: {
        btnReverseSettlement, settleGp, settleDate, settleRemark,
        settlementPreviewModal, btnPreviewSettlement, settlementPreviewSubtitle,
        settlementPreviewSummary, settlementPreviewBody, settlementPreviewFeeHeading, btnConfirmSettlement,
        formSettlement
      },
      api: Api,
      modal: window.FundModal,
      submission: window.FundSubmission,
      getMembers: () => membersList,
      setMembers: value => { membersList = value; },
      getState: () => appState,
      loadAllData,
      showToast,
      showSubmissionSuccess,
      escapeHtml,
      formatMoney
    });
    window.FundChartControls.init({
      elements: { filterMember, filterType, chkCompNav, chkCompAssets, chkCompSp500, chkCompNdx, chkCompCustom, chkCompCustom2 },
      chartRenderer: window.FundChartRenderer,
      segmentedControl: window.FundSegmentedControl,
      renderLedger,
      renderCharts,
      getNavTrendChart: () => navTrendChart,
      getRenderTrendStats: () => renderTrendStats,
      setActiveTimeSlice: value => { activeTimeSlice = value; }
    });

    window.FundTickerConfig.init({
      elements: {
        btnRefreshTickers, btnConfigTickers, tickerConfigModal,
        tickerConfigList, btnAddTickerRow, btnSaveTickerConfig
      },
      api: Api,
      modal: window.FundModal,
      escapeHtml,
      showToast,
      loadTickerAthData
    });

    window.FundCustomBenchmark.init({
      elements: {
        chkCompCustom, customBenchmarkLabel, customBenchmarkLabelText,
        chkCompCustom2, customBenchmarkLabel2, customBenchmarkLabelText2,
        btnConfigCustomBenchmark, btnConfigCustomBenchmark2,
        customBenchmarkModal, customBenchmarkModalTitle, btnCloseCustomBenchmarkModal,
        customBenchmarkName, customBenchmarkComponents, customBenchmarkTotal,
        btnAddCustomBenchmarkRow, btnSaveCustomBenchmark, btnRemoveCustomBenchmark
      },
      api: Api,
      modal: window.FundModal,
      loadAllData,
      showToast
    });
  }

  function updateChartsColors(theme) {
    window.FundChartRenderer.updateTheme({
      theme,
      navTrendChart,
      memberAllocationChart,
      currentFilteredHistory,
      membersList,
      ui: { getMemberAvatarColor, createChartGradient, getSeriesColors, hexToRgba }
    });
  }

  // --- 数据拉取与主渲染控制 ---
  async function loadAllData() {
    disposalTrial?.invalidate();
    try {
      // 同时获取成员列表与基金状态
      membersList = await Api.getMembers();
      appState = await Api.getState();
      membersList = window.FundMemberRenderer.sortByFirstRecord(membersList, appState.events);
      settingsController.syncBenchmarkPolicy(appState.settings?.benchmarkClosePolicy || 'previous');
      window.FundCustomBenchmark.sync(
        [appState.settings?.customBenchmark || null, appState.settings?.customBenchmark2 || null],
        [
          appState.settings?.customBenchmarkCacheReady !== false,
          appState.settings?.customBenchmark2CacheReady !== false
        ]
      );

      // 更新动态下拉选项（出入金下拉 + 流水筛选下拉）
      populateDynamicSelectors();

      // 执行页面数据渲染
      renderDashboard();
      renderMembersGrid();
      memberStatement.sync();
      renderLedger();
      renderCharts();
      window.FundLedger?.restorePosition();
      const onboardingShown = onboardingController?.showIfEmpty(appState) === true;
      if (!onboardingShown && !hasPromptedGpSetup && membersList.length && !membersList.some(member => member.primaryGp)) {
        hasPromptedGpSetup = true;
        memberEditor.render();
        openModal(memberModal);
        showToast('请先在成员设置中指定主GP；同一成员可以同时选择LP和GP。', 'warning');
      }
      return appState;
    } catch (err) {
      showToast('获取系统账务状态失败: ' + err.message, 'error');
      return null;
    }
  }

  // 动态构建下拉选择菜单（出入金登记、流水筛选、转让选择）
  function populateDynamicSelectors() {
    // 1. 出入金登记选择框
    const savedTxVal = elTxMember.value;
    const lpMembers = membersList.filter(member => member.roles?.lp !== false);
    elTxMember.innerHTML = lpMembers.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    if (savedTxVal && membersList.some(m => m.id === savedTxVal)) {
      elTxMember.value = savedTxVal;
    }

    // 1.2. 转让出让方与受让方选择框
    const savedTfFromVal = tfFromMember.value;
    const savedTfToVal = tfToMember.value;
    const membersOptionsHtml = membersList.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    tfFromMember.innerHTML = membersOptionsHtml;
    tfToMember.innerHTML = membersOptionsHtml;
    const gpMembers = membersList.filter(member => member.roles?.gp === true);
    const savedGp = settleGp.value;
    const settlementGps = gpMembers.filter(member => member.primaryGp);
    settleGp.innerHTML = settlementGps.map(member => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}（主GP）</option>`).join('');
    const primaryGp = gpMembers.find(member => member.primaryGp);
    if (primaryGp) settleGp.value = primaryGp.id;
    else if (savedGp && gpMembers.some(member => member.id === savedGp)) settleGp.value = savedGp;
    if (savedTfFromVal && membersList.some(m => m.id === savedTfFromVal)) {
      tfFromMember.value = savedTfFromVal;
    } else if (membersList.length > 0) {
      tfFromMember.value = membersList[0].id;
    }
    if (savedTfToVal && membersList.some(m => m.id === savedTfToVal)) {
      tfToMember.value = savedTfToVal;
    } else if (membersList.length > 1) {
      tfToMember.value = membersList[1].id;
    }

    // 1.5. 编辑账目成员选择框
    const savedEditVal = editMember.value;
    editMember.innerHTML = membersOptionsHtml;
    if (savedEditVal && membersList.some(m => m.id === savedEditVal)) {
      editMember.value = savedEditVal;
    }

    // 1.6. 编辑划转成员选择框
    const savedEditFromVal = editFromMember.value;
    const savedEditToVal = editToMember.value;
    editFromMember.innerHTML = membersOptionsHtml;
    editToMember.innerHTML = membersOptionsHtml;
    if (savedEditFromVal && membersList.some(m => m.id === savedEditFromVal)) {
      editFromMember.value = savedEditFromVal;
    }
    if (savedEditToVal && membersList.some(m => m.id === savedEditToVal)) {
      editToMember.value = savedEditToVal;
    }

    // 2. 流水筛选框 (保留“所有流水”及“系统估值”，动态插入成员)
    const savedFilterVal = filterMember.value;
    filterMember.innerHTML = `
      <option value="all">所有流水对象</option>
      ${membersList.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('')}
      <option value="system">系统/估值</option>
    `;
    if (savedFilterVal) {
      filterMember.value = savedFilterVal;
    }

    window.FundCustomSelect?.refresh();
  }

  // 1. 仪表盘指标渲染 (USD 币种重构 & CNH 人民币对比核算)
  function renderDashboard() {
    const s = appState.summary;

    // 自动更新汇率框数值（若当前没有被焦点选中）
    if (document.activeElement !== inputCnhRate) {
      inputCnhRate.value = s.cnhRate.toFixed(4);
    }

    elFundNavPerShare.textContent = s.navPerShare.toFixed(4);
    // 根据单位净值更新颜色指示器
    elFundNavPerShare.className = 'metric-value font-outfit privacy-sensitive';

    const latestValuationDate = appState.events
      .filter(event => event.type === 'valuation')
      .map(event => event.date)
      .sort()
      .at(-1);
    elNavIndicator.textContent = latestValuationDate
      ? `最后更新 ${latestValuationDate}`
      : '暂无估值更新';

    window.FundMetricDetails.render(appState.charts.navHistory);

    // Three-card overview: assets, NAV and the return on capital still managed.
    elFundTotalNav.innerHTML = `<span>$${formatMoney(s.totalNAV)}</span><span class="metric-inline metric-profit-inline ${s.profit >= 0 ? 'text-green' : 'text-magenta'}">${s.profit >= 0 ? '+' : ''}$${formatMoney(s.profit)}</span>`;
    const formatCnhTenThousands = amount => Number(amount / 10000).toLocaleString('zh-CN', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
    const compactCnhTotalNAV = `${formatCnhTenThousands(s.cnhTotalNAV)}万`;
    const compactCnhProfit = `${formatCnhTenThousands(Math.abs(s.cnhProfit))}万`;
    elFundTotalShares.innerHTML = `<span class="metric-sub-primary" title="人民币估值：¥${formatMoney(s.cnhTotalNAV)}">≈ ¥${compactCnhTotalNAV}</span><span class="metric-inline ${s.cnhProfit >= 0 ? 'text-green' : 'text-magenta'}" title="CNH收益（含汇率）：${s.cnhProfit >= 0 ? '+' : '-'}¥${formatMoney(Math.abs(s.cnhProfit))}">CNH收益（含汇率） ${s.cnhProfit >= 0 ? '+' : '-'}¥${compactCnhProfit}</span>`;
    elFundTotalShares.classList.add('privacy-sensitive');

    const activeRate = Number.isFinite(s.activeProfitRate) ? s.activeProfitRate : null;
    const cnhActiveRate = Number.isFinite(s.cnhActiveProfitRate) ? s.cnhActiveProfitRate : null;
    elFundActiveProfitRate.innerHTML = `<span>${activeRate === null ? '—' : `${activeRate > 0 ? '+' : ''}${activeRate.toFixed(2)}%`}</span>`;
    const activeRateTone = activeRate === null ? '' : activeRate > 0 ? ' text-green' : activeRate < 0 ? ' text-magenta' : '';
    elFundActiveProfitRate.className = `metric-value font-outfit privacy-sensitive${activeRateTone}`;
    const cnhActiveRateText = cnhActiveRate === null
      ? '—'
      : `${cnhActiveRate >= 0 ? '+' : ''}${cnhActiveRate.toFixed(2)}%`;
    const cnhActiveRateClass = cnhActiveRate === null
      ? ''
      : cnhActiveRate >= 0 ? 'text-green' : 'text-magenta';
    elFundActiveProfitRateSub.innerHTML = `<span class="metric-inline" title="当前人民币估值相对尚未退出人民币本金的收益率，包含汇率变动影响"><span>CNH在管收益率（含汇率）</span><strong class="${cnhActiveRateClass}">${cnhActiveRateText}</strong></span>`;

    const signedRate = rate => `${rate > 0 ? '+' : ''}${rate.toFixed(2)}%`;
    const signedMoney = amount => `${amount >= 0 ? '+' : '-'}$${formatMoney(Math.abs(amount))}`;
    assetsDetailsPrincipal.textContent = `$${formatMoney(s.remainingPrincipal)}`;
    assetsDetailsActiveProfit.textContent = signedMoney(s.activeProfit);
    assetsDetailsActiveProfit.className = `privacy-sensitive ${s.activeProfit >= 0 ? 'text-green' : 'text-magenta'}`;
    document.getElementById('assets-details-total').textContent = `$${formatMoney(s.totalNAV)}`;
    document.getElementById('assets-details-cnh').textContent = `≈ ¥${formatMoney(s.cnhTotalNAV)}`;
    document.getElementById('assets-details-rate').textContent = `1 USD = ${s.cnhRate.toFixed(4)} CNH`;
    document.getElementById('assets-details-valuation-date').textContent = latestValuationDate || '暂无估值';
    const activeProfitOperator = s.activeProfit >= 0 ? '+' : '−';
    const assetsDetailsCheck = document.getElementById('assets-details-check');
    assetsDetailsCheck.textContent = `$${formatMoney(s.totalNAV)} = $${formatMoney(s.remainingPrincipal)} ${activeProfitOperator} $${formatMoney(Math.abs(s.activeProfit))}`;
    const assetsRoundingCents = Math.round(s.totalNAV * 100) - Math.round(s.remainingPrincipal * 100) - Math.round(s.activeProfit * 100);
    if (assetsRoundingCents !== 0) {
      assetsDetailsCheck.textContent += ` ${assetsRoundingCents > 0 ? '+' : '−'} $${formatMoney(Math.abs(assetsRoundingCents) / 100)}（分位舍入差）`;
    }
    const renderRate = (id, rate) => {
      const element = document.getElementById(id);
      element.textContent = rate === null ? '—' : signedRate(rate);
      element.className = `privacy-sensitive${rate === null ? '' : rate >= 0 ? ' text-green' : ' text-magenta'}`;
    };
    renderRate('return-details-active-rate', activeRate);
    renderRate('return-details-cnh-active-rate', cnhActiveRate);
    renderRate('return-details-history-rate', s.totalDeposit > 0 ? s.profitRate : null);
    renderRate('return-details-cnh-history-rate', s.cnhTotalDeposit > 0 ? s.cnhProfitRate : null);
    document.getElementById('assets-details-cnh-history-profit').textContent = `CNH累计收益（含汇率）：${s.cnhProfit >= 0 ? '+' : '−'}¥${formatMoney(Math.abs(s.cnhProfit))}`;
    assetsDetailsHistoryProfit.textContent = signedMoney(s.profit);
    assetsDetailsHistoryProfit.className = `privacy-sensitive ${s.profit >= 0 ? 'text-green' : 'text-magenta'}`;
    assetsDetailsTotalDeposit.textContent = `$${formatMoney(s.totalDeposit)}`;
    assetsDetailsTotalWithdraw.textContent = `$${formatMoney(s.totalWithdraw)}`;
    // Reconcile the displayed cents, avoiding floating-point subtraction noise.
    const exitedPrincipalCents = Math.round(s.totalDeposit * 100) - Math.round(s.remainingPrincipal * 100);
    const exitedProfitCents = Math.round(s.totalWithdraw * 100) - exitedPrincipalCents;
    const exitedPrincipal = exitedPrincipalCents / 100;
    const exitedProfit = exitedProfitCents / 100;
    assetsDetailsExitedPrincipal.textContent = `$${formatMoney(exitedPrincipal)}`;
    assetsDetailsExitedProfit.textContent = signedMoney(exitedProfit);
    assetsDetailsExitedProfit.className = `privacy-sensitive ${exitedProfit >= 0 ? 'text-green' : 'text-magenta'}`;
    const profitOperator = exitedProfit >= 0 ? '+' : '−';
    assetsDetailsWithdrawCheck.textContent = `$${formatMoney(s.totalWithdraw)} = $${formatMoney(exitedPrincipal)} ${profitOperator} $${formatMoney(Math.abs(exitedProfit))}`;
    assetsDetailsProfitCheck.textContent = `${signedMoney(s.profit)} = ${signedMoney(s.activeProfit)} ${profitOperator} $${formatMoney(Math.abs(exitedProfit))}`;
    const roundingCents = Math.round(s.profit * 100) - Math.round(s.activeProfit * 100) - exitedProfitCents;
    if (roundingCents !== 0) {
      assetsDetailsProfitCheck.textContent += ` ${roundingCents > 0 ? '+' : '−'} $${formatMoney(Math.abs(roundingCents) / 100)}（分位舍入差）`;
    }
  }

  // 2. 动态家庭成员资产网格渲染
  function renderMembersGrid() {
    return window.FundMemberRenderer.renderGrid({
      state: appState,
      members: membersList,
      elements: { grid: elMembersGridContainer },
      utils: { escapeHtml, formatMoney, getAvatarText, getMemberAvatarColor },
      isDark: checkIfDark()
    });
  }

  // 3. 家庭成员管理模态框列表渲染 (带 inline 修改与安全删除)
  // 4. 历史账目表格流水渲染 (USD 币种重构)
  function renderLedger() {
    return window.FundLedgerRenderer.render({
      state: appState,
      members: membersList,
      elements: { filterMember, filterType, ledgerTbody },
      utils: { escapeHtml, formatMoney },
      onEdit: ledgerActions.edit,
      onDelete: ledgerActions.remove
    });
  }

  function renderCharts() {
    if (!appState) return;
    const rendered = window.FundChartRenderer.render({
      state: appState,
      members: membersList,
      settings: { activeTimeSlice, theme: themeController.get() },
      charts: { navTrendChart, memberAllocationChart },
      elements: { chkCompNav, chkCompAssets, chkCompSp500, chkCompNdx, chkCompCustom, chkCompCustom2, trendStatsGrid: elTrendStatsGrid },
      ui: { formatMoney, getThemeColors, isDarkTheme, createChartGradient, getSeriesColors, hexToRgba, getMemberAvatarColor }
    });
    navTrendChart = rendered.navTrendChart;
    memberAllocationChart = rendered.memberAllocationChart;
    currentFilteredHistory = rendered.filteredHistory;
    currentTrendStatSeries = rendered.trendSeries;
    renderTrendStats = rendered.renderTrendStats;
    updateChartsColors(themeController.get());
  }

  // 加载并渲染美股标的 ATH 历史及收盘价格回调数据
  async function loadTickerAthData() {
    const container = document.getElementById('ticker-ath-cards-container');
    return window.FundTickerPanel.load({
      container,
      api: Api,
      ui: { escapeHtml, formatMonthDay }
    });
  }


});
