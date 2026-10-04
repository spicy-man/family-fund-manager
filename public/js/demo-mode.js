(function () {
  const staticDemo = Boolean(document.querySelector('meta[name="fund-static-demo"]'));
  const enabled = staticDemo || window.location.pathname === '/demo';
  window.FundDemoMode = { enabled, staticDemo };
  if (!enabled) return;

  const blockedSelectors = [
    '.operations-panel .op-form input',
    '.operations-panel .op-form select',
    '.operations-panel .op-form textarea',
    '.operations-panel .op-form button',
    '[data-sidebar-action="members"]',
    '[data-sidebar-action="backup"]',
    '#btn-sync-rate',
    '#input-cnh-rate',
    '#btn-config-tickers',
    '#btn-refresh-tickers',
    '#btn-config-custom-benchmark',
    '#btn-config-custom-benchmark-2',
    '[data-benchmark-policy]',
    '.btn-edit',
    '.btn-delete'
  ].join(',');

  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('demo-mode');

    const banner = document.createElement('aside');
    banner.className = 'demo-banner';
    banner.setAttribute('aria-label', '演示模式提示');
    banner.innerHTML = [
      '<div class="demo-banner-copy">',
      '<strong><span class="demo-banner-dot" aria-hidden="true"></span>只读演示</strong>',
      '<span>当前展示的是虚构样例数据，与您的正式账本完全隔离。</span>',
      '</div>',
      '<a class="demo-banner-exit" href="/">返回正式账本</a>'
    ].join('');
    document.body.prepend(banner);
    if (staticDemo) {
      const link = banner.querySelector('.demo-banner-exit');
      link.href = 'https://github.com/spicy-man/family-fund-manager';
      link.textContent = '查看 GitHub 源码';
    }

    const operationPanel = document.querySelector('.operations-panel');
    if (operationPanel) {
      operationPanel.classList.add('is-demo-preview');
      const badge = operationPanel.querySelector('.panel-badge');
      if (badge) badge.textContent = '只读预览';
      const note = document.createElement('div');
      note.className = 'demo-panel-note';
      note.setAttribute('role', 'note');
      note.textContent = '可切换查看各类录入界面；表单与提交操作在 Demo 中已锁定。';
      operationPanel.querySelector('.panel-header')?.after(note);
    }

    const lockControls = () => {
      document.querySelectorAll(blockedSelectors).forEach(element => {
        if ('disabled' in element && !element.disabled) element.disabled = true;
        if (element.getAttribute('aria-disabled') !== 'true') element.setAttribute('aria-disabled', 'true');
        if (element.getAttribute('title') !== '演示模式为只读') element.setAttribute('title', '演示模式为只读');
      });
    };

    lockControls();
    const observer = new MutationObserver(lockControls);
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('submit', event => {
      if (!event.target.closest('.operations-panel, .modal-overlay')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  });
})();
