(function () {
  const instances = new WeakMap();
  const observedForms = new WeakSet();
  let openInstance = null;
  let nextId = 0;

  function close(instance, restoreFocus = false) {
    if (!instance || !instance.isOpen) return;
    instance.isOpen = false;
    instance.wrapper.classList.remove('is-open');
    instance.trigger.setAttribute('aria-expanded', 'false');
    instance.trigger.removeAttribute('aria-activedescendant');
    instance.menu.hidden = true;
    if (openInstance === instance) openInstance = null;
    if (restoreFocus) instance.trigger.focus();
  }

  function closeAll() {
    if (openInstance) close(openInstance);
  }

  function positionMenu(instance) {
    const rect = instance.trigger.getBoundingClientRect();
    const viewportInset = 12;
    const menuGap = 6;
    const spaceBelow = window.innerHeight - rect.bottom - viewportInset;
    const spaceAbove = rect.top - viewportInset;
    const desiredHeight = Math.min(instance.menu.scrollHeight, 280);
    const openAbove = spaceBelow < Math.min(desiredHeight, 160) && spaceAbove > spaceBelow;
    const availableHeight = Math.max(96, (openAbove ? spaceAbove : spaceBelow) - menuGap);
    const width = Math.max(rect.width, 160);
    const left = Math.min(
      Math.max(viewportInset, rect.left),
      Math.max(viewportInset, window.innerWidth - width - viewportInset)
    );

    instance.menu.style.width = `${width}px`;
    instance.menu.style.maxHeight = `${Math.min(280, availableHeight)}px`;
    instance.menu.style.left = `${left}px`;
    instance.menu.style.top = openAbove
      ? `${Math.max(viewportInset, rect.top - Math.min(desiredHeight, availableHeight) - menuGap)}px`
      : `${rect.bottom + menuGap}px`;
  }

  function setActiveOption(instance, index, scroll = true) {
    const options = [...instance.menu.querySelectorAll('.custom-select__option:not([disabled])')];
    if (!options.length) {
      instance.activeIndex = -1;
      instance.trigger.removeAttribute('aria-activedescendant');
      return;
    }

    const normalizedIndex = ((index % options.length) + options.length) % options.length;
    instance.activeIndex = normalizedIndex;
    options.forEach((option, optionIndex) => {
      option.classList.toggle('is-active', optionIndex === normalizedIndex);
    });
    const activeOption = options[normalizedIndex];
    instance.trigger.setAttribute('aria-activedescendant', activeOption.id);
    if (scroll) {
      // Scroll only the portaled menu; scrollIntoView can scroll the page or
      // modal and trigger the outside-scroll handler, immediately closing it.
      const top = activeOption.offsetTop;
      const bottom = top + activeOption.offsetHeight;
      if (top < instance.menu.scrollTop) instance.menu.scrollTop = top;
      else if (bottom > instance.menu.scrollTop + instance.menu.clientHeight) {
        instance.menu.scrollTop = bottom - instance.menu.clientHeight;
      }
    }
  }

  function refreshInstance(instance) {
    const { select, trigger, menu } = instance;
    const selectedOption = select.selectedOptions[0] || select.options[0] || null;
    const options = [...select.options];

    trigger.textContent = selectedOption?.textContent || '请选择';
    trigger.disabled = select.disabled || options.length === 0;
    trigger.setAttribute('aria-required', select.required ? 'true' : 'false');
    menu.replaceChildren();

    options.forEach((option, index) => {
      const menuOption = document.createElement('button');
      menuOption.type = 'button';
      menuOption.className = 'custom-select__option';
      menuOption.id = `${instance.id}-option-${index}`;
      menuOption.role = 'option';
      menuOption.dataset.value = option.value;
      menuOption.textContent = option.textContent;
      menuOption.disabled = option.disabled;
      menuOption.setAttribute('aria-selected', option.selected ? 'true' : 'false');

      if (option.selected) menuOption.classList.add('is-selected');
      menuOption.addEventListener('click', () => {
        if (option.disabled) return;
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        refreshInstance(instance);
        close(instance, true);
      });
      menu.appendChild(menuOption);
    });

    if (instance.isOpen) positionMenu(instance);
  }

  function open(instance) {
    if (instance.trigger.disabled) return;
    if (openInstance && openInstance !== instance) close(openInstance);
    refreshInstance(instance);
    instance.isOpen = true;
    openInstance = instance;
    instance.wrapper.classList.add('is-open');
    instance.trigger.setAttribute('aria-expanded', 'true');
    instance.menu.hidden = false;
    positionMenu(instance);

    const enabledOptions = [...instance.menu.querySelectorAll('.custom-select__option:not([disabled])')];
    const selectedIndex = enabledOptions.findIndex(option => option.classList.contains('is-selected'));
    setActiveOption(instance, selectedIndex >= 0 ? selectedIndex : 0);
  }

  function selectActiveOption(instance) {
    const options = [...instance.menu.querySelectorAll('.custom-select__option:not([disabled])')];
    options[instance.activeIndex]?.click();
  }

  function handleTriggerKeydown(instance, event) {
    if (event.key === 'Escape') {
      if (instance.isOpen) {
        event.preventDefault();
        event.stopPropagation();
        close(instance, true);
      }
      return;
    }

    if (event.key === 'Tab') {
      close(instance);
      return;
    }

    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!instance.isOpen) open(instance);
      const enabledCount = instance.menu.querySelectorAll('.custom-select__option:not([disabled])').length;
      if (!enabledCount) return;
      if (event.key === 'Home') setActiveOption(instance, 0);
      else if (event.key === 'End') setActiveOption(instance, enabledCount - 1);
      else setActiveOption(instance, instance.activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (instance.isOpen) selectActiveOption(instance);
      else open(instance);
    }
  }

  function enhance(select) {
    if (instances.has(select)) return instances.get(select);

    const id = select.id || `custom-select-${++nextId}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    select.classList.add('custom-select__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select__trigger';
    trigger.id = `${id}-custom-trigger`;
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const label = select.labels?.[0];
    if (label) trigger.setAttribute('aria-label', label.textContent.trim());
    wrapper.appendChild(trigger);

    const menu = document.createElement('div');
    menu.className = 'custom-select__menu';
    menu.id = `${id}-custom-listbox`;
    menu.role = 'listbox';
    menu.hidden = true;
    document.body.appendChild(menu);
    trigger.setAttribute('aria-controls', menu.id);

    const instance = {
      id,
      select,
      wrapper,
      trigger,
      menu,
      isOpen: false,
      activeIndex: -1
    };

    instances.set(select, instance);
    trigger.addEventListener('click', () => {
      if (instance.isOpen) close(instance);
      else open(instance);
    });
    trigger.addEventListener('keydown', event => handleTriggerKeydown(instance, event));
    select.addEventListener('change', () => {
      wrapper.classList.remove('is-invalid');
      refreshInstance(instance);
    });
    select.addEventListener('focus', () => trigger.focus());
    select.addEventListener('invalid', event => {
      event.preventDefault();
      wrapper.classList.add('is-invalid');
      trigger.focus();
    });

    const observer = new MutationObserver(() => refreshInstance(instance));
    observer.observe(select, { childList: true, subtree: true, attributes: true });

    if (select.form && !observedForms.has(select.form)) {
      observedForms.add(select.form);
      select.form.addEventListener('reset', () => {
        window.setTimeout(() => refresh(select.form), 0);
      });
    }

    refreshInstance(instance);
    return instance;
  }

  function refresh(target = document) {
    if (target.matches?.('select.select-input')) {
      refreshInstance(enhance(target));
      return;
    }

    target.querySelectorAll?.('select.select-input').forEach(select => {
      refreshInstance(enhance(select));
    });
  }

  document.addEventListener('pointerdown', event => {
    if (!openInstance) return;
    if (openInstance.wrapper.contains(event.target) || openInstance.menu.contains(event.target)) return;
    close(openInstance);
  });

  document.addEventListener('scroll', event => {
    if (!openInstance || openInstance.menu.contains(event.target)) return;
    close(openInstance);
  }, true);

  window.addEventListener('resize', closeAll);

  window.FundCustomSelect = {
    init: refresh,
    refresh,
    closeAll
  };
})();
