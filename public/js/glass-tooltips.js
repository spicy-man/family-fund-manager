(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    if (!window.Hyalite) return;
    const engine = window.Hyalite;
    // Fixed project preset; legacy local tuning must not override it.
    const options = { ...engine.DEFAULTS, thickness: 20, blur: 12, shade: 0, rim: 0, edge: 0.1, sat: 3, materialize: 160 };
    engine.watch(document.body, '.glass-tooltip:not(.return-details-modal-content)', options);
    // Metric details keep the shared glass styling and its CSS blur fallback,
    // without attaching the SVG refraction filter.
    document.documentElement.style.setProperty('--tooltip-glass-blur', options.blur + 'px');
  });
})();
