(function () {
  const triggers = new WeakMap();

  function getFocusableElements(modal) {
    return [...modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]):not(.custom-select__native), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.offsetParent !== null);
  }

  function open(modal, trigger = document.activeElement) {
    if (!modal) return;
    triggers.set(modal, trigger);
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => (getFocusableElements(modal)[0] || modal.querySelector('.modal-content'))?.focus());
  }

  function close(modal) {
    if (!modal || !modal.classList.contains('active')) return;
    window.FundCustomSelect?.closeAll?.();
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.modal-overlay.active')) {
      document.documentElement.classList.remove('modal-open');
      document.body.classList.remove('modal-open');
    }
    triggers.get(modal)?.focus?.();
  }

  function bindAccessible(modal, closeButton) {
    if (!modal) return;
    const isPersistent = () => modal.dataset.modalPersistent === 'true';
    let pressedBackdrop = true;
    closeButton?.addEventListener('click', () => close(modal));
    modal.addEventListener('pointerdown', event => {
      pressedBackdrop = event.target === modal;
    });
    modal.addEventListener('click', event => {
      if (pressedBackdrop && event.target === modal && !isPersistent()) close(modal);
      pressedBackdrop = true;
    });
    modal.addEventListener('keydown', event => {
      if (!modal.classList.contains('active')) return;
      if (event.key === 'Escape') {
        if (isPersistent()) return;
        event.preventDefault();
        close(modal);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusableElements(modal);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const surface = modal.querySelector('.modal-content');
      const atBoundaryContainer = document.activeElement === modal || document.activeElement === surface || !focusable.includes(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || atBoundaryContainer)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || (atBoundaryContainer && document.activeElement !== surface && document.activeElement !== modal))) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  window.FundModal = { open, close, bindAccessible };
})();
