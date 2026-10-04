(function () {
  function create({ buttons, group, segmentedControl, onApply, onSelect }) {
    let current = 'light';

    function isDark() {
      return current === 'dark' || (
        current === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches
      );
    }

    function apply(theme) {
      current = ['light', 'dark', 'system'].includes(theme) ? theme : 'light';
      theme = current;
      const scheme = isDark() ? 'dark' : 'only light';
      document.documentElement.style.colorScheme = scheme;
      document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme);
      document.body.classList.remove('theme-light', 'theme-dark');
      document.body.classList.add(isDark() ? 'theme-dark' : 'theme-light');
      const activeButton = [...buttons].find(button => button.dataset.themeBtn === theme);
      segmentedControl.activate(group, activeButton);
      requestAnimationFrame(() => segmentedControl.setIndicator(group, activeButton));
      onApply?.(theme);
    }

    function set(theme, { persist = true, notify = true } = {}) {
      if (persist) localStorage.setItem('family_fund_theme', theme);
      apply(theme);
      if (notify) {
        const button = [...buttons].find(item => item.dataset.themeBtn === theme);
        onSelect?.(theme, button);
      }
    }

    function init() {
      current = localStorage.getItem('family_fund_theme') || 'light';
      apply(current);
      buttons.forEach(button => {
        button.addEventListener('click', () => set(button.dataset.themeBtn));
      });
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (current === 'system') apply('system');
      });
    }

    return { init, set, get: () => current, isDark };
  }

  window.FundTheme = { create };
})();
