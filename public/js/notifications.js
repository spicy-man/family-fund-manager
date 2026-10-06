(function () {
  function create({ escapeHtml }) {
    // The top layer stays above transformed panels and drag previews.
    const notificationLayer = document.getElementById('toast-container');
    if (notificationLayer?.showPopover) {
      notificationLayer.setAttribute('popover', 'manual');
      notificationLayer.showPopover();
    }
    // 辅助：可靠关闭 Toast（退场动画 + 300ms超时双重兜底移除）
    function dismissToast(toast) {
      if (!toast || toast.dataset.dismissing === 'true') return;
      toast.dataset.dismissing = 'true';
      toast.style.animation = 'toastSlideOut 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards';
      const removeToast = () => {
        clearTimeout(safetyTimer);
        toast.remove();
      };
      const safetyTimer = setTimeout(removeToast, 280);
      toast.addEventListener('animationend', removeToast, { once: true });
    }

    // 轻量级 Toast 弹出式提示
    function showToast(message, type = 'success') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
      toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
      toast.textContent = message;

      // 支持点击快速关闭，防止意外遮挡
      toast.addEventListener('click', () => dismissToast(toast));

      container.appendChild(toast);

      // 3.5秒后自动淡出销毁
      setTimeout(() => dismissToast(toast), 3500);
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

      // 支持点击快速关闭，防止意外遮挡
      toast.addEventListener('click', () => dismissToast(toast));

      container.appendChild(toast);

      setTimeout(() => dismissToast(toast), 3500);
    }
    return { dismissToast, showToast, showSubmissionSuccess };
  }
  window.FundNotifications = { create };
})();
