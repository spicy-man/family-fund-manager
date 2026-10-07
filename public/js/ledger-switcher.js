(() => {
  const params = new URLSearchParams(window.location.search);
  const id = params.has('ledger') ? params.get('ledger') : 'default';
  const positionKey = 'family_fund_ledger_position_transfer';
  let pendingPosition = null;
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(positionKey) || 'null');
    window.sessionStorage.removeItem(positionKey);
    if (saved?.ledgerId === id && Number.isFinite(saved.top) && saved.top >= 0) pendingPosition = saved;
  } catch (_error) {
    // Navigation remains available when browser storage is blocked.
  }
  const capturePosition = () => {
    const top = window.scrollY;
    const sections = [...document.querySelectorAll('.sidebar-nav a[href^="#"]')]
      .map(link => document.getElementById(link.hash.slice(1)))
      .filter(Boolean);
    const activationLine = Math.min(140, Math.max(80, window.innerHeight * 0.16));
    const section = sections.filter(node => node.getBoundingClientRect().top <= activationLine).at(-1);
    return { top, sectionId: section?.id, offset: section ? section.getBoundingClientRect().top : null };
  };
  const restorePosition = () => {
    if (!pendingPosition) return;
    const saved = pendingPosition;
    pendingPosition = null;
    window.requestAnimationFrame(() => {
      const section = saved.sectionId && document.getElementById(saved.sectionId);
      const top = saved.top > 8 && section && Number.isFinite(saved.offset)
        ? window.scrollY + section.getBoundingClientRect().top - saved.offset : saved.top;
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    });
  };
  window.FundLedger = Object.freeze({ id, restorePosition });
  document.addEventListener('DOMContentLoaded', async () => {
    const switcher = document.getElementById('ledger-switcher');
    if (!switcher) return;
    if (window.FundDemoMode?.enabled) { switcher.hidden = true; return; }
    const trigger = document.getElementById('ledger-select');
    const menu = document.getElementById('ledger-menu');
    const list = document.getElementById('ledger-menu-list');
    const status = document.getElementById('ledger-switcher-status');
    const name = document.getElementById('ledger-current-name');
    const manageModal = document.getElementById('manage-ledgers-modal');
    const modal = window.FundModal;
    let ledgers = [];
    const closeMenu = (focus = false) => {
      menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus({ preventScroll: true });
    };
    const positionMenu = () => {
      const rect = trigger.getBoundingClientRect();
      menu.style.width = Math.max(240, Math.min(300, rect.width)) + 'px';
      menu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12)) + 'px';
      const below = rect.bottom + 7;
      menu.style.top = Math.max(12, below + menu.offsetHeight <= window.innerHeight - 12 ? below : rect.top - menu.offsetHeight - 7) + 'px';
    };
    const openMenu = () => {
      menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); positionMenu();
      (menu.querySelector('[aria-current="true"]') || menu.querySelector('button'))?.focus();
    };
    const loadAndOpenMenu = async () => {
      try {
        if (!ledgers.length) await refresh();
        openMenu();
      } catch (error) { status.textContent = error.message; }
    };
    trigger.addEventListener('click', () => menu.hidden ? loadAndOpenMenu() : closeMenu());
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); void loadAndOpenMenu(); }
    });
    menu.addEventListener('keydown', event => {
      const buttons = [...menu.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
      else if (event.key === 'Tab') closeMenu();
      else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!switcher.contains(event.target) && !menu.contains(event.target)) closeMenu();
    });
    document.addEventListener('scroll', event => { if (!menu.contains(event.target)) closeMenu(); }, true);
    const media = window.matchMedia('(max-width: 1180px)');
    const place = () => {
      closeMenu();
      if (media.matches) document.querySelector('.app-header')?.prepend(switcher);
      else document.querySelector('.sidebar-nav')?.before(switcher);
    };
    place(); media.addEventListener('change', place); window.addEventListener('resize', () => closeMenu());
    const navigate = next => {
      const url = new URL(window.location.href);
      if (next === 'default') url.searchParams.delete('ledger'); else url.searchParams.set('ledger', next);
      try {
        window.sessionStorage.setItem(positionKey, JSON.stringify({ ledgerId: next, ...capturePosition() }));
        window.sessionStorage.setItem('family_fund_ledger_privacy_transfer', JSON.stringify({
          ledgerId: next,
          privacyMode: document.body.classList.contains('privacy-mode-active')
        }));
      } catch (_error) {
        // If storage is blocked, the destination keeps its private default.
      }
      window.location.assign(url.href);
    };
    for (const link of document.querySelectorAll('a[href="/api/backup/export"]')) {
      link.href = '/api/backup/export?ledger=' + encodeURIComponent(id);
    }
    function render() {
      const current = ledgers.find(ledger => ledger.id === id);
      name.textContent = current?.name || '选择账本';
      status.textContent = current ? '' : '该账本不存在，请选择有效账本。';
      list.replaceChildren(...ledgers.map(ledger => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'ledger-menu-item'; button.setAttribute('role','menuitem');
        button.dataset.ledgerId = ledger.id;
        button.setAttribute('aria-current', String(ledger.id === id));
        const dot = document.createElement('span'); dot.className = 'ledger-dot'; dot.setAttribute('aria-hidden','true');
        const label = document.createElement('span'); label.className = 'ledger-item-name'; label.textContent = ledger.name;
        button.append(dot,label);
        if (ledger.isDefault) {
          const badge = document.createElement('span'); badge.className = 'ledger-badge'; badge.textContent = '默认'; button.append(badge);
        }
        if (ledger.id === id) {
          const check = document.createElement('span'); check.className = 'ledger-check'; check.textContent = '✓'; check.setAttribute('aria-label','当前账本'); button.append(check);
        }
        button.addEventListener('click', () => { closeMenu(true); if (ledger.id !== id) navigate(ledger.id); });
        return button;
      }));
    }
    async function refresh() {
      ledgers = (await requestApi('/api/ledgers')).data; render(); trigger.disabled = false;
    }
    modal.bindAccessible(manageModal, document.getElementById('btn-close-manage-ledgers'));
    const input = document.getElementById('new-ledger-name');
    const createStatus = document.getElementById('new-ledger-status');
    const manageStatus = document.getElementById('manage-ledgers-status');
    const managementList = document.getElementById('manage-ledgers-list');
    const saveSettings = document.getElementById('btn-save-ledger-settings');
    function renderManagement(preserveDrafts = false) {
      const drafts = new Map(preserveDrafts ? [...managementList.querySelectorAll('input')].map(field => [field.dataset.ledgerId, field.value]) : []);
      managementList.replaceChildren(...ledgers.map(ledger => {
        const row = document.createElement('div'); row.className = 'member-edit-item ledger-management-row' + (ledger.id === id ? ' is-primary-gp' : '');
        const left = document.createElement('div'); left.className = 'member-edit-left';
        const avatar = document.createElement('span'); avatar.className = 'member-edit-avatar ledger-management-avatar'; avatar.textContent = ledger.name.slice(0,1);
        const identity = document.createElement('div'); identity.className = 'member-edit-identity';
        const label = document.createElement('span'); label.className = 'member-edit-name ledger-name-display'; label.textContent = drafts.get(ledger.id) ?? ledger.name;
        const field = document.createElement('input'); field.type = 'text'; field.value = drafts.get(ledger.id) ?? ledger.name;
        field.maxLength = 50; field.required = true; field.hidden = true; field.dataset.ledgerId = ledger.id; field.setAttribute('aria-label', ledger.name + '的名称');
        identity.append(label,field);
        if (ledger.isDefault || ledger.id === id) {
          const badge = document.createElement('span'); badge.className = 'member-role-badge'; badge.textContent = ledger.isDefault ? '默认' : '当前'; identity.append(badge);
        }
        left.append(avatar,identity);
        const actions = document.createElement('div'); actions.className = 'member-edit-actions';
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ledger-edit-button'; edit.setAttribute('aria-label','编辑'+ledger.name);
        edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m16 3 5 5-12 12H4v-5L16 3Z"/><path d="m14 5 5 5"/></svg>';
        edit.addEventListener('click', () => { field.hidden = false; label.hidden = true; field.focus(); field.select(); });
        field.addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); field.value = ledger.name; label.textContent = ledger.name; field.hidden = true; label.hidden = false; edit.focus(); }
          if (event.key === 'Enter') { event.preventDefault(); label.textContent = field.value.trim() || ledger.name; field.hidden = true; label.hidden = false; edit.focus(); }
        });
        actions.append(edit); row.append(left,actions); return row;
      }));
    }
    document.getElementById('new-ledger-form').addEventListener('submit', async event => {
      event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]');
      if (button.disabled) return; button.disabled = true; saveSettings.disabled = true; createStatus.textContent = '';
      try {
        await jsonRequest('/api/ledgers', 'POST', { name: input.value });
        input.value = ''; await refresh(); renderManagement(true); createStatus.textContent = '账本已添加。';
      } catch (error) { createStatus.textContent = error.message; }
      finally { button.disabled = false; saveSettings.disabled = false; }
    });
    saveSettings.addEventListener('click', async () => {
      if (saveSettings.disabled) return;
      const fields = [...managementList.querySelectorAll('input')];
      const invalid = fields.find(field => !field.value.trim());
      if (invalid) { invalid.hidden = false; manageStatus.textContent = '账本名称不能为空。'; invalid.focus(); return; }
      saveSettings.disabled = true;
      const addButton = document.querySelector('#new-ledger-form [type="submit"]'); addButton.disabled = true;
      fields.forEach(field => { field.disabled = true; }); manageStatus.textContent = '';
      try {
        for (const field of fields) {
          const ledger = ledgers.find(item => item.id === field.dataset.ledgerId);
          if (ledger && field.value.trim() !== ledger.name) await jsonRequest('/api/ledgers/' + encodeURIComponent(ledger.id), 'PATCH', { name: field.value });
        }
        await refresh(); modal.close(manageModal);
      } catch (error) { manageStatus.textContent = error.message; }
      finally { saveSettings.disabled = false; addButton.disabled = false; fields.forEach(field => { field.disabled = false; }); }
    });
    document.getElementById('btn-manage-ledgers').addEventListener('click', async () => {
      closeMenu(); manageStatus.textContent = ''; createStatus.textContent = ''; input.value = '';
      try { await refresh(); } catch (error) { status.textContent = error.message; return; }
      renderManagement(); modal.open(manageModal, trigger);
    });
    try { await refresh(); } catch (error) { name.textContent = '选择账本'; status.textContent = error.message; }
    finally { trigger.disabled = false; }
  });
})();
