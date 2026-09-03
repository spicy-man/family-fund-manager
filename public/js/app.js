/**
 * 前端核心应用控制逻辑 (app.js)
 * 升级版：支持美元 (USD - $) 记账及完全动态家庭成员管理 (无上限)
 */

document.addEventListener('DOMContentLoaded', () => {
  const welcomeMessages = window.FundDemoMode?.enabled ? [
    'Explore the Demo'
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
  const availableWelcomeMessages = welcomeMessages.filter(message => message !== previousWelcome);
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
  const returnDetailsActiveRate = document.getElementById('return-details-active-rate');
  const returnDetailsPrincipal = document.getElementById('return-details-principal');
  const returnDetailsActiveProfit = document.getElementById('return-details-active-profit');
  const returnDetailsHistoryRate = document.getElementById('return-details-history-rate');
  const returnDetailsHistoryProfit = document.getElementById('return-details-history-profit');
  const returnDetailsTotalDeposit = document.getElementById('return-details-total-deposit');
  const returnDetailsTotalWithdraw = document.getElementById('return-details-total-withdraw');

  // The overview is deliberately terse: one aligned title, one key figure, one supporting fact.
  document.querySelectorAll('.metric-label').forEach((label, index) => {
    label.textContent = ['总资产', '单位净值', '在管本金收益率'][index] || label.textContent;
  });

  // Dynamic Containers
  const elMembersGridContainer = document.getElementById('members-grid-container');
  const elMemberCountBadge = document.getElementById('member-count-badge');
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

  const { switchTo: switchOperationView } = window.FundOperationPanel.create({
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
      privacyButtons: [btnPrivacyToggle, btnSettlementPrivacyToggle]
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
    const formController = window.FundTransactionController.init({
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
      resetDefaultDates,
      loadAllData,
      showToast,
      showSubmissionSuccess,
      closeModal,
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
      renderMembersEditorList,
      showToast
    });
    const { openMembersPanel, openBackupPanel } = managementController;
    onboardingController = window.FundOnboarding.init({
      elements: { onboardingModal, btnStartLedger },
      modal: window.FundModal,
      management: managementController,
      isDemoMode: window.FundDemoMode?.enabled === true
    });

    window.FundAppShell.init({
      elements: {
        backupModal, btnCloseModal, principlesModal, btnClosePrinciplesModal,
        activeReturnCard, returnDetailsModal, btnCloseReturnDetails,
        memberModal, btnCloseMemberModal, btnSaveMemberSettings,
        editEventModal, btnCloseEditModal, tickerConfigModal, btnCloseTickerConfigModal,
        settlementPreviewModal, btnCloseSettlementPreview, btnCancelSettlement,
        memberViewTabs, membersGridContainer: elMembersGridContainer,
        btnTabTx, btnTabVal, btnTabTf, btnTabSettle,
        formTransaction, formValuation, formTransfer, formSettlement,
        inputCnhRate, tfRate
      },
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
        settlementPreviewSummary, settlementPreviewBody, btnConfirmSettlement,
        formSettlement
      },
      api: Api,
      modal: window.FundModal,
      submission: window.FundSubmission,
      getMembers: () => membersList,
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
    try {
      // 同时获取成员列表与基金状态
      membersList = await Api.getMembers();
      appState = await Api.getState();
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
      renderLedger();
      renderCharts();
      const onboardingShown = onboardingController?.showIfEmpty(appState) === true;
      if (!onboardingShown && !hasPromptedGpSetup && membersList.length && !membersList.some(member => member.primaryGp)) {
        hasPromptedGpSetup = true;
        renderMembersEditorList();
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
    returnDetailsActiveRate.textContent = activeRate === null ? '—' : signedRate(activeRate);
    returnDetailsActiveRate.className = `privacy-sensitive${activeRate === null ? '' : activeRate >= 0 ? ' text-green' : ' text-magenta'}`;
    returnDetailsPrincipal.textContent = `$${formatMoney(s.remainingPrincipal)}`;
    returnDetailsActiveProfit.textContent = signedMoney(s.activeProfit);
    returnDetailsActiveProfit.className = `privacy-sensitive ${s.activeProfit >= 0 ? 'text-green' : 'text-magenta'}`;
    returnDetailsHistoryRate.textContent = signedRate(s.profitRate);
    returnDetailsHistoryRate.className = `privacy-sensitive ${s.profitRate >= 0 ? 'text-green' : 'text-magenta'}`;
    returnDetailsHistoryProfit.textContent = signedMoney(s.profit);
    returnDetailsHistoryProfit.className = `privacy-sensitive ${s.profit >= 0 ? 'text-green' : 'text-magenta'}`;
    returnDetailsTotalDeposit.textContent = `$${formatMoney(s.totalDeposit)}`;
    returnDetailsTotalWithdraw.textContent = `$${formatMoney(s.totalWithdraw)}`;
  }

  // 2. 动态家庭成员资产网格渲染
  function renderMembersGrid() {
    return window.FundMemberRenderer.renderGrid({
      state: appState,
      members: membersList,
      elements: { grid: elMembersGridContainer, countBadge: elMemberCountBadge },
      utils: { escapeHtml, formatMoney, getAvatarText, getMemberAvatarColor },
      isDark: checkIfDark()
    });
  }

  // 3. 家庭成员管理模态框列表渲染 (带 inline 修改与安全删除)
  function renderMembersEditorList() {
    if (gpSetupWarning) gpSetupWarning.hidden = membersList.some(member => member.primaryGp);
    if (membersList.length === 0) {
      elMembersEditList.innerHTML = `
        <div style="text-align: center; color: var(--color-text-muted); padding: 20px; font-size: 0.8rem;">
          当前家庭无成员数据，请输入名字创建
        </div>
      `;
      return;
    }

    elMembersEditList.innerHTML = membersList.map((m, idx) => {
      const shortName = escapeHtml(getAvatarText(m.name));

      const isDark = checkIfDark();
      const { background: cardColor, color: cardTextColor } = getMemberAvatarColor(m.id || m.name, isDark, idx);

      // 检查成员是否拥有交易历史
      const hasTx = appState.events.some(e =>
        e.member === m.id || e.fromMember === m.id || e.toMember === m.id
      );

      return `
        <div class="member-edit-item${m.primaryGp ? ' is-primary-gp' : ''}" id="member-edit-item-${m.id}">
          <div class="member-edit-left">
            <div class="member-edit-avatar" style="background: ${cardColor}; color: ${cardTextColor};">${shortName}</div>
            <div class="member-edit-identity">
              <span class="member-edit-name" id="member-name-span-${m.id}" title="双击或点击右侧笔头重命名">${escapeHtml(m.name)}</span>
              <input type="text" class="input-rename" id="member-name-input-${m.id}" value="${escapeHtml(m.name)}" style="display: none;">
              <span class="member-role-badge">LP</span>
            </div>
            <label class="primary-gp-choice" title="设为全系统唯一的主 GP">
              <input type="radio" name="primary-gp" id="member-primary-gp-${m.id}" ${m.primaryGp ? 'checked' : ''}>
              <span class="primary-gp-radio"></span>
              <span>主 GP</span>
            </label>
          </div>
          <div class="member-edit-actions">
            <button class="btn-rename-save" id="btn-rename-edit-${m.id}" title="重命名成员" style="color: var(--color-cyan);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
            </button>
            <button class="btn-rename-save" id="btn-rename-save-${m.id}" title="保存修改" style="color: var(--color-green); display: none;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </button>
            <button class="btn-delete" id="btn-member-del-${m.id}" title="${hasTx ? '已有出入金或转让记录，禁止删除' : '移除该成员'}" ${hasTx ? 'disabled style="opacity: 0.25; cursor: not-allowed;"' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // 事件绑定
    membersList.forEach(m => {
      const span = document.getElementById(`member-name-span-${m.id}`);
      const input = document.getElementById(`member-name-input-${m.id}`);
      const btnEdit = document.getElementById(`btn-rename-edit-${m.id}`);
      const btnSave = document.getElementById(`btn-rename-save-${m.id}`);
      const btnDel = document.getElementById(`btn-member-del-${m.id}`);
      const primaryGp = document.getElementById(`member-primary-gp-${m.id}`);

      const saveRoles = async () => {
        try {
          await Api.updateMemberRoles(m.id, { gp: true, primaryGp: true });
          await loadAllData();
          renderMembersEditorList();
        } catch (error) {
          showToast(error.message, 'error');
          renderMembersEditorList();
        }
      };
      primaryGp.addEventListener('change', saveRoles);

      const startEdit = () => {
        span.style.display = 'none';
        btnEdit.style.display = 'none';
        input.style.display = 'block';
        btnSave.style.display = 'inline-flex';
        input.focus();
        input.select();
      };

      const saveEdit = async () => {
        const newName = input.value.trim();
        if (!newName) {
          showToast('成员姓名不能为空', 'error');
          return;
        }
        if (newName === m.name) {
          // 无改动取消
          cancelEdit();
          return;
        }
        try {
          await Api.updateMember(m.id, newName);
          showToast(`家庭成员【${m.name}】已成功重命名为【${newName}】`, 'success');
          await loadAllData();
          renderMembersEditorList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };

      const cancelEdit = () => {
        span.style.display = 'block';
        btnEdit.style.display = 'inline-flex';
        input.style.display = 'none';
        btnSave.style.display = 'none';
        input.value = m.name;
      };

      span.addEventListener('dblclick', startEdit);
      btnEdit.addEventListener('click', startEdit);
      btnSave.addEventListener('click', saveEdit);

      input.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') saveEdit();
        if (e.key === 'Escape') cancelEdit();
      });

      if (btnDel && !btnDel.disabled) {
        btnDel.addEventListener('click', async () => {
          if (confirm(`确定要从系统删除家庭成员【${m.name}】吗？删除后将无法撤销。`)) {
            try {
              await Api.deleteMember(m.id);
              showToast(`家庭成员【${m.name}】已移除`, 'success');
              await loadAllData();
              renderMembersEditorList();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        });
      }
    });
  }

  // 4. 历史账目表格流水渲染 (USD 币种重构)
  function renderLedger() {
    return window.FundLedgerRenderer.render({
      state: appState,
      members: membersList,
      elements: { filterMember, filterType, ledgerTbody },
      utils: { escapeHtml, formatMoney },
      onEdit: handleEditEvent,
      onDelete: handleDeleteEvent
    });
  }

  // 删除单条交易记录 — 3 秒内可撤销
  function handleDeleteEvent(id, name, type, value) {
    const UNDO_DELAY = 3000; // 3 秒

    // 找到对应的 <tr> 行，视觉上先隐藏（软删除）
    const allRows = ledgerTbody.querySelectorAll('tr');
    let targetRow = null;
    allRows.forEach(row => {
      // 通过行上绑定的删除按钮 data 匹配（找到包含该 id 对应删除按钮的行）
      row.querySelectorAll('button').forEach(btn => {
        if (btn._deleteEventId === id) targetRow = row;
      });
    });
    if (targetRow) {
      targetRow.style.transition = 'opacity 0.3s, transform 0.3s';
      targetRow.style.opacity = '0.2';
      targetRow.style.pointerEvents = 'none';
    }

    // 构建撤销 Toast
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-undo';
    toast.innerHTML = `
      <div class="toast-undo-row">
        <svg class="toast-undo-icon ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg>
        <span class="toast-undo-text">
          <strong>已删除</strong>
          ${type === 'deposit' ? '入金' : type === 'withdraw' ? '出金' : type === 'transfer' ? '转让' : '估值'}记录（$${formatMoney(value)}）<br>
          <span style="font-size:0.75rem; opacity:0.7;">3 秒内可撤销，操作完成后将重算账目</span>
        </span>
        <button class="toast-undo-btn" id="undo-btn-${id}">↩ 撤销</button>
      </div>
      <div class="toast-undo-progress-wrap">
        <div class="toast-undo-progress-bar" id="undo-progress-${id}" style="animation-duration: ${UNDO_DELAY}ms;"></div>
      </div>
    `;
    container.appendChild(toast);

    // 入场动画
    toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards';

    let undone = false;

    // 撤销按钮点击处理
    const undoBtn = document.getElementById(`undo-btn-${id}`);
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        undone = true;
        clearTimeout(deleteTimer);
        // 恢复行显示
        if (targetRow) {
          targetRow.style.opacity = '1';
          targetRow.style.pointerEvents = '';
          targetRow.style.transform = '';
        }
        // 关闭 Toast
        dismissToast(toast);
        showToast('已撤销删除操作', 'success');
      });
    }

    // 3 秒后执行真正删除
    const deleteTimer = setTimeout(() => {
      if (undone) return;
      Api.deleteEvent(id)
        .then(() => {
          showToast('账目记录已删除，系统已完成全额重算！', 'success');
          loadAllData();
        })
        .catch(err => {
          // 删除失败，恢复行
          if (targetRow) {
            targetRow.style.opacity = '1';
            targetRow.style.pointerEvents = '';
          }
          showToast('删除失败：' + err.message, 'error');
        });
      dismissToast(toast);
    }, UNDO_DELAY);

    // 辅助：关闭 Toast（淡出动画后移除）
    function dismissToast(t) {
      t.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) reverse forwards';
      t.addEventListener('animationend', () => t.remove(), { once: true });
    }
  }

  // 弹出编辑账目模态框并填充回显
  function handleEditEvent(e) {
    const editModalTitle = document.getElementById('edit-modal-title');
    const editGroupMember = document.getElementById('edit-group-member');
    const editGroupCnhAmount = document.getElementById('edit-group-cnh-amount');
    const editLabelAmount = document.getElementById('edit-label-amount');
    const editGroupTransferMembers = document.getElementById('edit-group-transfer-members');
    const editGroupCnhRate = document.getElementById('edit-group-cnh-rate');

    // 填充基本信息
    editEventId.value = e.id;
    editEventType.value = e.type;
    editDate.value = e.date;
    if (e.type === 'valuation') editDate.max = getLatestValuationDate();
    else editDate.removeAttribute('max');
    editDate.setCustomValidity('');
    editRemark.value = e.remark || '';

    // 重置特有选项组显示状态
    editGroupMember.style.display = 'none';
    editGroupCnhAmount.style.display = 'none';
    editGroupTransferMembers.style.display = 'none';
    editGroupCnhRate.style.display = 'none';

    if (e.type === 'deposit' || e.type === 'withdraw') {
      // 交易类型：显示成员选择和人民币金额
      editModalTitle.textContent = e.type === 'deposit' ? '修改出资入金流水分账' : '修改出资金额提现流水分账';
      editGroupMember.style.display = 'block';
      editGroupCnhAmount.style.display = 'block';
      editLabelAmount.textContent = '美元金额 (USD)';

      editMember.value = e.member;
      const editUsdAmount = e.fullExit && e.requestedGrossAmount !== undefined
        ? e.requestedGrossAmount
        : e.amount;
      editAmount.value = editUsdAmount;
      editCnhAmount.value = e.fullExit && e.requestedGrossAmount !== undefined && e.amount > 0
        ? ((e.cnhAmount || 0) * e.requestedGrossAmount / e.amount).toFixed(2)
        : (e.cnhAmount || '');
    } else if (e.type === 'valuation') {
      // 估值类型：隐藏成员选择和人民币金额
      editModalTitle.textContent = '修改定期基金估值重估记录';
      editLabelAmount.textContent = '基金总资产估值 (USD)';

      editAmount.value = e.totalNAV;
    } else if (e.type === 'transfer') {
      // 转让类型：显示出让/受让方，及转让汇率
      editModalTitle.textContent = '修改内部份额转让记录';
      editGroupTransferMembers.style.display = 'flex';
      editGroupCnhRate.style.display = 'block';
      editLabelAmount.textContent = '转让金额 (USD)';

      editFromMember.value = e.fromMember;
      editToMember.value = e.toMember;
      editAmount.value = e.fullExit && e.requestedGrossAmount !== undefined
        ? e.requestedGrossAmount
        : e.amount;
      editCnhRate.value = e.cnhRate || appState.summary.cnhRate || 7.2000;
    }

    window.FundCustomSelect?.refresh(editEventModal);
    openModal(editEventModal);
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

  // 轻量级 Toast 弹出式提示
  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    toast.textContent = message;

    container.appendChild(toast);

    // 3.5秒后自动淡出销毁
    setTimeout(() => {
      toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) reverse forwards';
      toast.addEventListener('animationend', () => {
        toast.remove();
      });
    }, 3500);
  }

  function showSubmissionSuccess(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast toast-success toast-submission-success';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
      <svg class="toast-success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.5"/></svg>
      <div><strong>提交成功</strong><span>${escapeHtml(message)}</span></div>
    `;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) reverse forwards';
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, 4200);
  }
});
