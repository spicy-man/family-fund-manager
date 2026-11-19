(function () {
  function init() {
    const links = [...document.querySelectorAll('.sidebar-nav a[href^="#"]')];
    const sections = links
      .map(link => ({ link, section: document.querySelector(link.hash) }))
      .filter(({ section }) => section);
    let frame = null;
    let targetId = null;
    let settleTimer = null;
    let activeId = null;

    const setActive = (sectionId, refresh = false) => {
      if (activeId === sectionId && !refresh) return;
      links.forEach(link => {
        const active = link.hash === `#${sectionId}`;
        link.classList.toggle('active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
      activeId = sectionId;
    };

    const sync = () => {
      frame = null;
      if (targetId) {
        setActive(targetId);
        return;
      }
      if (window.scrollY <= 8) {
        setActive('dashboard-home');
        return;
      }
      const activationLine = Math.min(140, Math.max(80, window.innerHeight * 0.16));
      const byPosition = sections
        .map(item => ({ ...item, rect: item.section.getBoundingClientRect() }))
        .sort((a, b) => a.rect.top - b.rect.top);
      let active = byPosition[0];
      byPosition.forEach(item => {
        if (item.rect.top <= activationLine) active = item;
      });
      if (active) setActive(active.section.id);
    };

    links.forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        targetId = link.hash.slice(1);
        setActive(targetId);
        const section = document.getElementById(targetId);
        if (section) {
          const sidebarTop = document.querySelector('.app-sidebar')?.getBoundingClientRect().top ?? 20;
          const top = window.scrollY + section.getBoundingClientRect().top - sidebarTop;
          const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          window.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
          history.replaceState(null, '', link.hash);
        }
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          targetId = null;
          sync();
        }, 800);
      });
    });
    window.addEventListener('scroll', () => {
      if (!frame) frame = requestAnimationFrame(sync);
      if (targetId) {
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          targetId = null;
          sync();
        }, 160);
      }
    }, { passive: true });
    window.addEventListener('resize', () => {
      sync();
      if (activeId) setActive(activeId, true);
    });
    sync();
  }

  window.FundNavigation = { init };
})();
