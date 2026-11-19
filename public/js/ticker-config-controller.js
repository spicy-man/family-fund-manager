(function () {
  function init({ elements, api, modal, escapeHtml, showToast, loadTickerAthData, SortableClass = window.Sortable }) {
    const {
      btnRefreshTickers, btnConfigTickers, tickerConfigModal,
      tickerConfigList, btnAddTickerRow, btnSaveTickerConfig
    } = elements;
    const Api = api;
    const { open: openModal, close: closeModal } = modal;
    const Sortable = SortableClass;
    let tickerSortable = null;

    // 打开标的配置弹窗
    if (btnRefreshTickers) {
      btnRefreshTickers.addEventListener('click', async () => {
        btnRefreshTickers.disabled = true;
        btnRefreshTickers.classList.add('spinning');
        try {
          const result = await Api.refreshTickerAth();
          await loadTickerAthData();
          if (result.refreshSuccess) {
            showToast('标的数据已从 Yahoo Finance 刷新', 'success');
          } else {
            showToast(`刷新失败，继续显示本地缓存数据：${result.failedTickers.join('、')}`, 'warning');
          }
        } catch (err) {
          showToast('刷新失败，继续显示本地缓存数据：' + err.message, 'error');
        } finally {
          btnRefreshTickers.disabled = false;
          btnRefreshTickers.classList.remove('spinning');
        }
      });
    }

    if (btnConfigTickers) {
      btnConfigTickers.addEventListener('click', () => {
        renderTickerConfigList();
        openModal(tickerConfigModal);
      });
    }

    // 渲染标的配置列表
    async function renderTickerConfigList() {
      try {
        const tickers = await Api.getTickers();
        tickerConfigList.replaceChildren();
        tickers.forEach(ticker => {
          addTickerRow(ticker.ticker);
        });
        initTickerSortable();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function initTickerSortable() {
      tickerSortable?.destroy();
      tickerSortable = new Sortable(tickerConfigList, {
        animation: 180,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        handle: '.ticker-drag-handle',
        draggable: '.ticker-config-row',
        ghostClass: 'ticker-sort-ghost',
        chosenClass: 'ticker-sort-chosen',
        forceFallback: false,
        fallbackOnBody: true,
        fallbackClass: 'ticker-sort-fallback',
        fallbackTolerance: 4,
        swapThreshold: 0.65,
        invertSwap: true,
        scroll: true,
        bubbleScroll: true,
        scrollSensitivity: 60,
        scrollSpeed: 12
      });
    }

    function moveTickerRow(row, direction) {
      const sibling = direction === 'up' ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      if (direction === 'up') tickerConfigList.insertBefore(row, sibling);
      else tickerConfigList.insertBefore(sibling, row);
    }

    // 动态添加一个配置行
    function addTickerRow(ticker = '') {
      const row = document.createElement('div');
      row.className = 'ticker-config-row member-edit-item';
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.width = '100%';
      row.style.alignItems = 'center';
      row.innerHTML = `
        <div class="ticker-sort-controls" aria-label="调整展示顺序">
          <button class="ticker-drag-handle" type="button" title="拖动排序（也可用上下方向键）" aria-label="拖动此标的调整顺序">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14"/></svg>
          </button>
        </div>
        <div style="flex: 1; min-width: 0;">
          <input type="text" class="ticker-symbol-input" value="${escapeHtml(ticker)}" placeholder="代码（如：AAPL）" aria-label="追踪标的代码" style="width: 100%; font-weight: 700; text-transform: uppercase;" required>
        </div>
        <button class="btn-delete btn-remove-ticker-row" type="button" title="移除此标的" aria-label="移除此标的" style="flex-shrink: 0; padding: 6px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      `;

      // 绑定删除按钮点击事件
      row.querySelector('.btn-remove-ticker-row').addEventListener('click', () => {
        row.remove();
      });
      const dragHandle = row.querySelector('.ticker-drag-handle');
      dragHandle.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        moveTickerRow(row, event.key === 'ArrowUp' ? 'up' : 'down');
      });

      tickerConfigList.appendChild(row);
    }

    // 添加配置行事件
    if (btnAddTickerRow) {
      btnAddTickerRow.addEventListener('click', () => {
        addTickerRow();
        tickerConfigList.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }

    // 保存配置事件
    if (btnSaveTickerConfig) {
      btnSaveTickerConfig.addEventListener('click', async () => {
        const rows = tickerConfigList.querySelectorAll('.ticker-config-row');
        const tickers = [];
        let valid = true;

        rows.forEach(row => {
          const tickerInput = row.querySelector('.ticker-symbol-input');
          const ticker = tickerInput.value.trim();

          if (!ticker) {
            tickerInput.focus();
            valid = false;
            return;
          }
          tickers.push({ ticker });
        });

        if (!valid) {
          showToast('请填写标的代码', 'error');
          return;
        }

        if (tickers.length === 0) {
          showToast('最少需要追踪 1 个标的', 'error');
          return;
        }

        btnSaveTickerConfig.setAttribute('disabled', 'true');
        btnSaveTickerConfig.textContent = '正在保存并拉取数据...';

        try {
          await Api.saveTickers(tickers);
          showToast('标的配置保存成功！正在为您自动刷新页面。', 'success');
          closeModal(tickerConfigModal);
          // 重新抓取并更新顶部卡片
          await loadTickerAthData();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          btnSaveTickerConfig.removeAttribute('disabled');
          btnSaveTickerConfig.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 18px; height: 18px;">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            保存标的配置并刷新
          `;
        }
      });
    }
  }

  window.FundTickerConfig = { init };
})();
