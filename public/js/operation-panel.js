(function () {
  function create({ panel, tabs, forms, segmentedControl }) {
    let resizeAnimation = null;
    let cleanupTimer = null;
    let contentAnimation = null;
    const transition = { duration: 280, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };

    function animateChange(activeForm, update, { slideForm = true } = {}) {
      if (!panel || !activeForm) { update?.(); return; }

      const currentHeight = panel.getBoundingClientRect().height;
      const submitButton = !slideForm ? activeForm.querySelector?.(':scope > button[type="submit"]') : null;
      const previousButtonTop = submitButton?.getBoundingClientRect().top;
      contentAnimation?.cancel();
      contentAnimation = null;
      const interruptedAnimation = resizeAnimation;
      resizeAnimation = null;
      interruptedAnimation?.cancel();
      window.clearTimeout(cleanupTimer);
      cleanupTimer = null;
      panel.style.removeProperty('height');
      panel.style.removeProperty('overflow');

      update?.();
      // Build the newly visible buttons' lenses before their first painted frame.
      window.FundGlassButtons?.refresh(activeForm);

      const targetHeight = panel.getBoundingClientRect().height;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      if (slideForm) contentAnimation = activeForm.animate([
        // Opacity on a backdrop-filter ancestor changes its backdrop root and
        // makes the glass switch colour when the fade finishes.
        { transform: 'translateY(8px)' },
        { transform: 'translateY(0)' }
      ], transition);
      else if (submitButton) {
        const offset = previousButtonTop - submitButton.getBoundingClientRect().top;
        if (Math.abs(offset) >= 1) contentAnimation = submitButton.animate([
          { transform: `translateY(${offset}px)` },
          { transform: 'translateY(0)' }
        ], transition);
      }

      if (Math.abs(targetHeight - currentHeight) < 1) return;
      panel.style.height = `${targetHeight}px`;
      panel.style.overflow = 'clip';
      resizeAnimation = panel.animate([
        { height: `${currentHeight}px` },
        { height: `${targetHeight}px` }
      ], transition);

      const runningAnimation = resizeAnimation;
      const releaseSize = () => {
        if (resizeAnimation !== runningAnimation) return;
        resizeAnimation = null;
        window.clearTimeout(cleanupTimer);
        cleanupTimer = null;
        panel.style.removeProperty('height');
        panel.style.removeProperty('overflow');
      };
      runningAnimation.finished.then(releaseSize).catch(() => {});
      cleanupTimer = window.setTimeout(releaseSize, transition.duration + 100);
    }

    function switchTo(activeButton, activeForm, onActivate) {
      if (!panel || !activeButton || !activeForm) return;
      if (activeButton.classList.contains('active') && activeForm.classList.contains('active')) return;
      animateChange(activeForm, () => {
        segmentedControl.activate(tabs, activeButton);
        forms.forEach(form => form.classList.toggle('active', form === activeForm));
        onActivate?.();
      });
    }

    return { switchTo, animateChange };
  }

  window.FundOperationPanel = { create };
})();
