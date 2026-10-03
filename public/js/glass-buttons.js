(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    if (!window.Hyalite) return;

    // Only workflow buttons and the selected navigation item get a lens.
    // Hidden forms and dialogs acquire their maps when they become visible.
    const selector = '.theme-button:not(.sidebar-nav-item), .sidebar-nav-item.theme-button.active';
    window.Hyalite.watch(document.body, selector, {
      bevel: 8,
      thickness: 20,
      slope: 0.8,
      shape: 'squircle',
      blur: 0.6,
      dispersion: 0,
      shade: 0.30,
      rim: 1.76,
      edgeW: 3,
      edge: 0.36,
      light: -45,
      sat: 1,
      smooth: 0.6,
      materialize: 0
    });

    window.FundGlassButtons = {
      refresh(container) {
        container.querySelectorAll(selector).forEach(button => window.Hyalite.refresh(button));
      }
    };
  });
})();
