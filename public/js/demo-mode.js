(function () {
  const staticDemo = Boolean(document.querySelector('meta[name="fund-static-demo"]'));
  const sandbox = Boolean(document.querySelector('meta[name="fund-demo-sandbox"]'));
  const enabled = staticDemo || window.location.pathname === '/demo';
  window.FundDemoMode = { enabled, staticDemo, sandbox };
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

    if (sandbox) {
      banner.classList.add('is-sandbox');
      document.body.classList.add('demo-sandbox');
      banner.querySelector('.demo-banner-copy strong').lastChild.textContent = '可操作沙盒';
      banner.querySelector('.demo-banner-copy > span').textContent = '体验数据仅保存在当前标签页。';
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'demo-banner-exit';
      reset.id = 'btn-reset-demo';
      reset.textContent = '重置样例';
      reset.addEventListener('click', async () => {
        if (!confirm('重置当前标签页的体验数据？所有体验修改都会清除，恢复初始样例账本。')) return;
        try { await window.FundDemoSandbox.reset(); window.location.reload(); }
        catch (error) { alert(error.message); }
      });
      banner.insertBefore(reset, banner.querySelector('.demo-banner-exit'));
      if (operationPanel) {
        operationPanel.querySelector('.panel-badge').textContent = '沙盒体验';
        operationPanel.querySelector('.demo-panel-note').textContent = '可以录入、修改、结算和恢复备份。行情及汇率使用离线快照，支持 AAPL、GOOGL、VGT，刷新行情会重新载入快照。';
      }
      document.querySelector('#backup-modal a[download]')?.addEventListener('click', async event => {
        event.preventDefault();
        try {
          const result = await window.FundDemoSandbox.exportBackup();
          const url = URL.createObjectURL(new Blob([result.binary], { type: 'application/zip' }));
          const link = document.createElement('a');
          link.href = url; link.download = 'family_fund_demo_backup.zip'; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) { alert(error.message); }
      });
      return;
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
