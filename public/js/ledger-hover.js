(function () {
  const bindings = new WeakMap();
  function bind(tbody) {
    bindings.get(tbody)?.();
    if (!Element.prototype.animate) return;
    tbody.classList.add('ledger-hover-animated');
    const rows = [...tbody.children];
    const animations = new Map();
    const removers = [];
    let opened = null;
    let closeTimer;
    const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function change(detail) {
      if (opened === detail) return;
      // Capture all positions before one layout change, including rows that may
      // enter the viewport when the detail collapses, then animate the offset.
      // The table's height is never interpolated frame by frame.
      const before = new Map();
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        before.set(row, rect);
      }
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
      opened?.classList.remove('ledger-detail-open');
      opened = detail;
      opened?.classList.add('ledger-detail-open');
      if (reducedMotion()) return;
      const after = rows.map(row => [row, row.getBoundingClientRect()]);
      for (const [row, rect] of after) {
        if (row === opened || !before.has(row)) continue;
        const previous = before.get(row);
        const visible = bounds => bounds.bottom >= 0 && bounds.top <= window.innerHeight;
        if (!visible(previous) && !visible(rect)) continue;
        const offset = previous.top - rect.top;
        if (Math.abs(offset) < .5) continue;
        const animation = row.animate([
          { transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }
        ], { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' });
        animations.set(row, animation);
        animation.onfinish = () => {
          if (animations.get(row) === animation) animations.delete(row);
        };
      }
    }
    for (const detail of rows.filter(row => row.classList.contains('ledger-row--settlement-detail'))) {
      const trigger = detail.previousElementSibling;
      if (!trigger) continue;
      const enter = () => { clearTimeout(closeTimer); change(detail); };
      const leave = event => {
        if (trigger.contains(event.relatedTarget) || detail.contains(event.relatedTarget)) return;
        clearTimeout(closeTimer);
        // Allow crossing from the trigger into its detail without closing it.
        closeTimer = setTimeout(() => change(null), 100);
      };
      for (const row of [trigger, detail]) {
        row.addEventListener('mouseenter', enter);
        row.addEventListener('mouseleave', leave);
        removers.push(() => {
          row.removeEventListener('mouseenter', enter);
          row.removeEventListener('mouseleave', leave);
        });
      }
    }
    bindings.set(tbody, () => {
      clearTimeout(closeTimer);
      removers.forEach(remove => remove());
      animations.forEach(animation => animation.cancel());
    });
  }
  window.FundLedgerHover = { bind };
})();
