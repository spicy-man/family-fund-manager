(function () {
  function create({ panel, tabs, forms, segmentedControl }) {
    let resizeAnimation = null;
    let cleanupTimer = null;

    function switchTo(activeButton, activeForm, onActivate) {
      if (!panel || !activeButton || !activeForm) return;
      if (activeButton.classList.contains('active') && activeForm.classList.contains('active')) return;

      const currentHeight = panel.getBoundingClientRect().height;
      const interruptedAnimation = resizeAnimation;
      resizeAnimation = null;
      interruptedAnimation?.cancel();
      window.clearTimeout(cleanupTimer);
      cleanupTimer = null;
      panel.style.removeProperty('height');
      panel.style.removeProperty('overflow');

      segmentedControl.activate(tabs, activeButton);
      forms.forEach(form => form.classList.toggle('active', form === activeForm));
      onActivate?.();
      // Build the newly visible buttons' lenses before their first painted frame.
      window.FundGlassButtons?.refresh(activeForm);

      const targetHeight = panel.getBoundingClientRect().height;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      activeForm.animate([
        // Opacity on a backdrop-filter ancestor changes its backdrop root and
        // makes the glass switch colour when the fade finishes.
        { transform: 'translateY(8px)' },
        { transform: 'translateY(0)' }
      ], { duration: 340, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });

      if (Math.abs(targetHeight - currentHeight) < 1) return;
      panel.style.height = `${targetHeight}px`;
      panel.style.overflow = 'clip';
      resizeAnimation = panel.animate([
        { height: `${currentHeight}px` },
        { height: `${targetHeight}px` }
      ], { duration: 420, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });

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
      cleanupTimer = window.setTimeout(releaseSize, 520);
    }

    return { switchTo };
  }

  window.FundOperationPanel = { create };
})();
