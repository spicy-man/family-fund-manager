(function () {
  function create({ elements, api, getState, loadAllData, notifications, modal, customSelect,
    prepareEdit, getLatestValuationDate, formatMoney }) {
    const { ledgerTbody, editEventId, editEventType, editDate, editRemark, editMember,
      editAmount, editCnhAmount, editFromMember, editToMember, editCnhRate, editEventModal } = elements;
    const { dismissToast, showToast } = notifications;
    // 删除单条交易记录 — 3 秒内可撤销
    function handleDeleteEvent(id, name, type, value) {
      const UNDO_DELAY = 3000; // 3 秒

      // 找到对应的 <tr> 行，视觉上先隐藏（软删除）
      const allRows = ledgerTbody.querySelectorAll('tr');
      let targetRow = null;
      allRows.forEach(row => {
        // 通过行上绑定的删除按钮 data 匹配（找到包含该 id 对应删除按钮的行）
        row.querySelectorAll('button').forEach(btn => {
          if (btn._deleteEventId === id) targetRow = row;
        });
      });
      if (targetRow) {
        targetRow.style.transition = 'opacity 0.3s, transform 0.3s';
        targetRow.style.opacity = '0.2';
        targetRow.style.pointerEvents = 'none';
      }

      // 构建撤销 Toast
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast toast-undo';
      toast.innerHTML = `
        <div class="toast-undo-row">
          <svg class="toast-undo-icon ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg>
          <span class="toast-undo-text">
            <strong>已删除</strong>
            ${type === 'deposit' ? '入金' : type === 'withdraw' ? '出金' : type === 'transfer' ? '转让' : '估值'}记录（$${formatMoney(value)}）<br>
            <span style="font-size:0.75rem; opacity:0.7;">3 秒内可撤销，操作完成后将重算账目</span>
          </span>
          <button class="toast-undo-btn" id="undo-btn-${id}">↩ 撤销</button>
        </div>
        <div class="toast-undo-progress-wrap">
          <div class="toast-undo-progress-bar" id="undo-progress-${id}" style="animation-duration: ${UNDO_DELAY}ms;"></div>
        </div>
      `;
      container.appendChild(toast);

      // 入场动画
      toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards';

      let undone = false;
      let deletionStarted = false;

      // 撤销按钮点击处理
      const undoBtn = document.getElementById(`undo-btn-${id}`);
      if (undoBtn) {
        undoBtn.addEventListener('click', () => {
          if (undone || deletionStarted) return;
          undone = true;
          undoBtn.disabled = true;
          clearTimeout(deleteTimer);
          // 恢复行显示
          if (targetRow) {
            targetRow.style.opacity = '1';
            targetRow.style.pointerEvents = '';
            targetRow.style.transform = '';
          }
          // 关闭 Toast
          dismissToast(toast);
          showToast('已撤销删除操作', 'success');
        });
      }

      // 3 秒后执行真正删除
      const deleteTimer = setTimeout(() => {
        if (undone) return;
        deletionStarted = true;
        if (undoBtn) undoBtn.disabled = true;
        api.deleteEvent(id)
          .then(() => {
            showToast('账目记录已删除，系统已完成全额重算！', 'success');
            loadAllData();
          })
          .catch(err => {
            // 删除失败，恢复行
            if (targetRow) {
              targetRow.style.opacity = '1';
              targetRow.style.pointerEvents = '';
            }
            showToast('删除失败：' + err.message, 'error');
          });
        dismissToast(toast);
      }, UNDO_DELAY);
    }

    // 弹出编辑账目模态框并填充回显
    function handleEditEvent(e) {
      const editModalTitle = document.getElementById('edit-modal-title');
      const editGroupMember = document.getElementById('edit-group-member');
      const editGroupCnhAmount = document.getElementById('edit-group-cnh-amount');
      const editLabelAmount = document.getElementById('edit-label-amount');
      const editGroupTransferMembers = document.getElementById('edit-group-transfer-members');
      const editGroupCnhRate = document.getElementById('edit-group-cnh-rate');

      // 填充基本信息
      editEventId.value = e.id;
      editEventType.value = e.type;
      editDate.value = e.date;
      if (e.type === 'valuation') editDate.max = getLatestValuationDate();
      else editDate.removeAttribute('max');
      editDate.setCustomValidity('');
      editRemark.value = e.remark || '';

      // 重置特有选项组显示状态
      editGroupMember.style.display = 'none';
      editGroupCnhAmount.style.display = 'none';
      editGroupTransferMembers.style.display = 'none';
      editGroupCnhRate.style.display = 'none';

      if (e.type === 'deposit' || e.type === 'withdraw') {
        // 交易类型：显示成员选择和人民币金额
        editModalTitle.textContent = e.type === 'deposit' ? '修改出资入金流水分账' : '修改出资金额提现流水分账';
        editGroupMember.style.display = 'block';
        editGroupCnhAmount.style.display = 'block';
        editLabelAmount.textContent = '美元金额 (USD)';

        editMember.value = e.member;
        const editUsdAmount = e.fullExit && e.requestedGrossAmount !== undefined
          ? e.requestedGrossAmount
          : e.amount;
        editAmount.value = editUsdAmount;
        editCnhAmount.value = e.fullExit && e.requestedGrossAmount !== undefined && e.amount > 0
          ? ((e.cnhAmount || 0) * e.requestedGrossAmount / e.amount).toFixed(2)
          : (e.cnhAmount || '');
      } else if (e.type === 'valuation') {
        // 估值类型：隐藏成员选择和人民币金额
        editModalTitle.textContent = '修改定期基金估值重估记录';
        editLabelAmount.textContent = '基金总资产估值 (USD)';

        editAmount.value = e.totalNAV;
      } else if (e.type === 'transfer') {
        // 转让类型：显示出让/受让方，及转让汇率
        editModalTitle.textContent = '修改内部份额转让记录';
        editGroupTransferMembers.style.display = 'flex';
        editGroupCnhRate.style.display = 'block';
        editLabelAmount.textContent = '转让金额 (USD)';

        editFromMember.value = e.fromMember;
        editToMember.value = e.toMember;
        editAmount.value = e.fullExit && e.requestedGrossAmount !== undefined
          ? e.requestedGrossAmount
          : e.amount;
        editCnhRate.value = e.cnhRate ||
          (e.amount > 0 && Number.isFinite(e.cnhAmount)
            ? e.cnhAmount / e.amount
            : (getState().summary.cnhRate || 7.2000));
      }

      prepareEdit(e);
      customSelect?.refresh(editEventModal);
      modal.open(editEventModal);
    }

    return { edit: handleEditEvent, remove: handleDeleteEvent };
  }
  window.FundLedgerActions = { create };
})();
