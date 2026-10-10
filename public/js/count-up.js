(function () {
  const running = new Map();
  const duration = 1600;
  // A sine S-curve starts and stops at zero speed, with no mid-curve kink.
  const easeInOutSine = progress => (1 - Math.cos(Math.PI * progress)) / 2;
  // Animate presentation only; finish with the caller's exact formatter.
  function render(element, value, format, animate = true) {
    const previous = running.get(element);
    if (previous) window.cancelAnimationFrame(previous.frame);
    running.delete(element);
    if (document.body.classList.contains('privacy-mode-active') || !animate || !Number.isFinite(value) || value === 0 ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.textContent = format(value);
      return;
    }
    const job = { frame: null, start: null, value, format };
    running.set(element, job);
    element.textContent = format(0);
    function tick(now) {
      if (running.get(element) !== job) return;
      if (job.start === null) job.start = now;
      const progress = Math.min(1, (now - job.start) / duration);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (document.body.classList.contains('privacy-mode-active') || progress === 1 || reduce || document.hidden || !element.isConnected) {
        element.textContent = format(value);
        running.delete(element);
        return;
      }
      element.textContent = format(value * easeInOutSine(progress));
      job.frame = window.requestAnimationFrame(tick);
    }
    job.frame = window.requestAnimationFrame(tick);
  }
  function finishAll() {
    running.forEach((job, element) => {
      window.cancelAnimationFrame(job.frame);
      element.textContent = job.format(job.value);
    });
    running.clear();
  }
  window.FundCountUp = { render, finishAll };
})();
