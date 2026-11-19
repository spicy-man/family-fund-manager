(function () {
  let refs = null;
  const lastSignatures = [null, null];
  const lastReady = [false, false];
  const refreshTimers = [null, null];
  let activeSlot = 0;

  function sync(benchmarks, cacheReadiness = [true, true]) {
    if (!refs) return;
    refs.slots.forEach((slotRefs, slot) => {
      const benchmark = benchmarks[slot];
      const cacheReady = cacheReadiness[slot] !== false;
      const configured = Boolean(benchmark);
      const enabled = configured && cacheReady;
      const signature = benchmark?.components?.map(item => `${item.ticker}:${item.weight}`).join('|') || null;
      if (enabled && (signature !== lastSignatures[slot] || !lastReady[slot])) slotRefs.checkbox.checked = true;
      slotRefs.checkbox.disabled = !enabled;
      if (!enabled) slotRefs.checkbox.checked = false;
      slotRefs.label.classList.toggle('is-disabled', !enabled);
      slotRefs.labelText.textContent = benchmark
        ? `${benchmark.name}${cacheReady ? '' : '（同步中）'}`
        : `自定义组合 ${slot + 1}`;
      slotRefs.label.title = benchmark
        ? benchmark.components.map(item => `${item.ticker} ${item.weight}%`).join(' + ')
        : `点击“配置组合 ${slot + 1}”添加单个标的或百分比组合`;
      lastSignatures[slot] = signature;
      lastReady[slot] = enabled;
    });
  }

  function init({ elements, api, modal, loadAllData, showToast }) {
    const slots = [
      {
        button: elements.btnConfigCustomBenchmark,
        checkbox: elements.chkCompCustom,
        label: elements.customBenchmarkLabel,
        labelText: elements.customBenchmarkLabelText
      },
      {
        button: elements.btnConfigCustomBenchmark2,
        checkbox: elements.chkCompCustom2,
        label: elements.customBenchmarkLabel2,
        labelText: elements.customBenchmarkLabelText2
      }
    ];
    refs = { elements, api, modal, loadAllData, showToast, slots };
    const {
      customBenchmarkModal, btnCloseCustomBenchmarkModal, customBenchmarkModalTitle,
      customBenchmarkName, customBenchmarkComponents, customBenchmarkTotal,
      btnAddCustomBenchmarkRow, btnSaveCustomBenchmark, btnRemoveCustomBenchmark
    } = elements;

    modal.bindAccessible(customBenchmarkModal, btnCloseCustomBenchmarkModal);

    const readinessField = slot => slot === 0 ? 'customBenchmarkCacheReady' : 'customBenchmark2CacheReady';

    const pollForHistory = (slot, attempt = 0) => {
      clearTimeout(refreshTimers[slot]);
      refreshTimers[slot] = setTimeout(async () => {
        const state = await loadAllData();
        if (state?.settings?.[readinessField(slot)]) {
          showToast(`自定义组合 ${slot + 1} 历史行情同步完成`, 'success');
          return;
        }
        if (attempt < 14) pollForHistory(slot, attempt + 1);
        else showToast(`自定义组合 ${slot + 1} 已保存，历史行情暂未同步完成，请稍后刷新重试`, 'warning');
      }, 2000);
    };

    const updateTotal = () => {
      const total = [...customBenchmarkComponents.querySelectorAll('.custom-benchmark-weight')]
        .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
      customBenchmarkTotal.textContent = `${total.toFixed(2)}%`;
      customBenchmarkTotal.parentElement.classList.toggle('is-invalid', Math.abs(total - 100) > 0.01);
      return total;
    };

    const syncNameField = () => {
      const rows = [...customBenchmarkComponents.querySelectorAll('.custom-benchmark-component-row')];
      if (rows.length === 1) {
        const ticker = rows[0].querySelector('.custom-benchmark-ticker')?.value.trim().toUpperCase() || '';
        customBenchmarkName.value = ticker;
        customBenchmarkName.disabled = true;
        customBenchmarkName.placeholder = '单标的自动使用标的代码';
      } else {
        customBenchmarkName.disabled = false;
        customBenchmarkName.placeholder = '例如：我的科技组合';
        if (!customBenchmarkName.value.trim()) {
          customBenchmarkName.value = '自定义组合';
        }
      }
    };

    const addRow = (component = { ticker: '', weight: '' }) => {
      if (customBenchmarkComponents.children.length >= 10) {
        showToast('自定义标的最多支持 10 个成分', 'warning');
        return;
      }
      const row = document.createElement('div');
      row.className = 'custom-benchmark-component-row';
      row.innerHTML = `
        <input class="custom-benchmark-ticker" type="text" maxlength="20" placeholder="如：VOO" aria-label="组合成分标的代码" required>
        <div class="custom-benchmark-weight-wrap">
          <input class="custom-benchmark-weight" type="number" min="0.0001" max="100" step="0.01" placeholder="0" aria-label="组合成分权重百分比" required>
          <span>%</span>
        </div>
        <button class="btn-delete custom-benchmark-remove-row" type="button" aria-label="移除此成分" title="移除此成分">×</button>`;
      const tickerInput = row.querySelector('.custom-benchmark-ticker');
      const weightInput = row.querySelector('.custom-benchmark-weight');
      tickerInput.value = component.ticker || '';
      weightInput.value = component.weight ?? '';
      const normalizeTicker = (event = {}) => {
        if (event.isComposing) return;
        tickerInput.value = tickerInput.value.toUpperCase();
        if (customBenchmarkComponents.querySelectorAll('.custom-benchmark-component-row').length === 1) {
          customBenchmarkName.value = tickerInput.value.trim();
        }
      };
      tickerInput.addEventListener('input', normalizeTicker);
      tickerInput.addEventListener('compositionend', () => normalizeTicker());
      weightInput.addEventListener('input', updateTotal);
      row.querySelector('.custom-benchmark-remove-row').addEventListener('click', () => {
        row.remove();
        syncNameField();
        updateTotal();
      });
      customBenchmarkComponents.appendChild(row);
      updateTotal();
    };

    const renderConfig = benchmark => {
      customBenchmarkComponents.replaceChildren();
      const components = benchmark?.components?.length ? benchmark.components : [{ ticker: '', weight: 100 }];
      components.forEach(addRow);
      btnRemoveCustomBenchmark.hidden = !benchmark;
      if (components.length === 1) {
        customBenchmarkName.value = components[0]?.ticker || '';
      } else {
        customBenchmarkName.value = benchmark?.name || '自定义组合';
      }
      syncNameField();
      updateTotal();
    };

    let openSequence = 0;
    let writing = false;
    slots.forEach((slotRefs, slot) => {
      slotRefs.button.addEventListener('click', async event => {
        if (writing) return;
        const sequence = ++openSequence;
        const trigger = event.currentTarget;
        try {
          const benchmark = await api.getCustomBenchmark(slot);
          if (sequence !== openSequence) return;
          activeSlot = slot;
          customBenchmarkModalTitle.textContent = `配置自定义对比组合 ${slot + 1}`;
          renderConfig(benchmark);
          modal.open(customBenchmarkModal, trigger);
        } catch (error) {
          if (sequence !== openSequence) return;
          showToast(`读取自定义组合 ${slot + 1} 失败：${error.message}`, 'error');
        }
      });
    });

    btnAddCustomBenchmarkRow.addEventListener('click', () => {
      addRow();
      syncNameField();
    });

    btnSaveCustomBenchmark.addEventListener('click', async () => {
      if (writing) return;
      const components = [...customBenchmarkComponents.querySelectorAll('.custom-benchmark-component-row')]
        .map(row => ({
          ticker: row.querySelector('.custom-benchmark-ticker').value.trim().toUpperCase(),
          weight: Number(row.querySelector('.custom-benchmark-weight').value)
        }));
      const name = components.length === 1 ? (components[0]?.ticker || '') : customBenchmarkName.value.trim();
      if (!name) return showToast(components.length === 1 ? '请填写标的代码' : '请填写自定义标的名称', 'error');
      if (!components.length || components.some(item => !item.ticker || !Number.isFinite(item.weight) || item.weight <= 0)) {
        return showToast('请完整填写每个标的代码和有效权重', 'error');
      }
      if (Math.abs(updateTotal() - 100) > 0.01) return showToast('成分权重合计必须为 100%', 'error');

      writing = true;
      ++openSequence;
      btnSaveCustomBenchmark.disabled = true;
      btnSaveCustomBenchmark.textContent = '正在同步历史行情…';
      try {
        await api.saveCustomBenchmark({ name, components }, activeSlot);
        modal.close(customBenchmarkModal);
        const state = await loadAllData();
        if (state?.settings?.[readinessField(activeSlot)]) {
          showToast(`自定义组合 ${activeSlot + 1} 已保存`, 'success');
        } else {
          showToast(`自定义组合 ${activeSlot + 1} 已保存，历史行情正在后台同步`, 'success');
          pollForHistory(activeSlot);
        }
      } catch (error) {
        showToast(`保存失败：${error.message}`, 'error');
      } finally {
        writing = false;
        btnSaveCustomBenchmark.disabled = false;
        btnSaveCustomBenchmark.textContent = '保存并同步历史行情';
      }
    });

    btnRemoveCustomBenchmark.addEventListener('click', async () => {
      if (writing) return;
      if (!confirm('确定移除自定义对比标的吗？历史行情缓存不会影响基金账本。')) return;
      writing = true;
      ++openSequence;
      btnRemoveCustomBenchmark.disabled = true;
      try {
        await api.saveCustomBenchmark(null, activeSlot);
        clearTimeout(refreshTimers[activeSlot]);
        modal.close(customBenchmarkModal);
        await loadAllData();
        showToast(`自定义组合 ${activeSlot + 1} 已移除`, 'success');
      } catch (error) {
        showToast(`移除失败：${error.message}`, 'error');
      } finally {
        writing = false;
        btnRemoveCustomBenchmark.disabled = false;
      }
    });
  }

  window.FundCustomBenchmark = { init, sync };
})();
