(function () {
  function init({ elements, api, submission, resetDefaultDates, loadAllData, showToast, showSubmissionSuccess, closeModal, getLatestValuationDate, formatMoney }) {
    const {
      txDate, tfDate, valDate, editDate, editEventType,
      tfAmount, tfRate, tfCnhDisplay, inputCnhRate,
      formTransfer, tfFromMember, tfToMember, tfRemark,
      editAmount, editCnhAmount, formEditEvent, editEventId,
      editRemark, editMember, editFromMember, editToMember,
      editCnhRate, editEventModal, formTransaction, elTxMember,
      txAmount, txCnhAmount, txRemark, formValuation, valTotalNav, valRemark
    } = elements;
    const Api = api;
    const { runOnce: submitOnce } = submission;

    const validateSundayDateInput = input => {
      if (!input.value) {
        input.setCustomValidity('');
        return false;
      }
      const day = new Date(`${input.value}T00:00:00Z`).getUTCDay();
      const isSunday = day === 0;
      input.setCustomValidity(isSunday ? '' : '出入金和内部转让仅在周日办理，请选择周日。');
      return isSunday;
    };

    const validateValuationDateInput = input => {
      const latest = getLatestValuationDate();
      input.max = latest;
      if (!input.value) {
        input.setCustomValidity('');
        return false;
      }
      const day = new Date(`${input.value}T00:00:00Z`).getUTCDay();
      let message = '';
      if (day === 0 || day === 6) message = '估值日期请选择周一至周五的交易日。';
      else if (input.value > latest) message = `美东时间04:05后才开放当日估值，当前最晚可选择 ${latest}。`;
      input.setCustomValidity(message);
      return !message;
    };

    txDate.addEventListener('input', () => validateSundayDateInput(txDate));
    txDate.addEventListener('change', () => {
      if (!validateSundayDateInput(txDate)) txDate.reportValidity();
    });
    tfDate.addEventListener('input', () => validateSundayDateInput(tfDate));
    tfDate.addEventListener('change', () => {
      if (!validateSundayDateInput(tfDate)) tfDate.reportValidity();
    });
    valDate.addEventListener('input', () => validateValuationDateInput(valDate));
    valDate.addEventListener('change', () => {
      if (!validateValuationDateInput(valDate)) valDate.reportValidity();
    });
    editDate.addEventListener('input', () => {
      if (['deposit', 'withdraw', 'transfer'].includes(editEventType.value)) validateSundayDateInput(editDate);
      else if (editEventType.value === 'valuation') validateValuationDateInput(editDate);
      else editDate.setCustomValidity('');
    });

    // 划转表单金额及汇率联动
    const updateTfCnhDisplay = () => {
      const usdVal = parseFloat(tfAmount.value);
      const rateVal = parseFloat(tfRate.value);
      if (!isNaN(usdVal) && !isNaN(rateVal)) {
        tfCnhDisplay.textContent = `折合 CNH: ≈ ¥${formatMoney(usdVal * rateVal)}`;
      } else {
        tfCnhDisplay.textContent = `折合 CNH: ≈ ¥0.00`;
      }
    };
    tfAmount.addEventListener('input', updateTfCnhDisplay);
    tfRate.addEventListener('input', updateTfCnhDisplay);

    // 内部转让划转录入提交
    formTransfer.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateSundayDateInput(tfDate)) {
        tfDate.reportValidity();
        return;
      }
      await submitOnce(formTransfer, async () => {

      const fromMember = tfFromMember.value;
      const toMember = tfToMember.value;
      const amount = parseFloat(tfAmount.value);
      const cnhRate = parseFloat(tfRate.value);
      const date = tfDate.value;
      const remark = tfRemark.value.trim();

      if (!fromMember || !toMember) {
        showToast('请先选择有效的出让方与受让方', 'error');
        return;
      }
      if (fromMember === toMember) {
        showToast('出让方与受让方不能为同一成员', 'error');
        return;
      }

      try {
        await Api.addTransfer({ fromMember, toMember, amount, cnhRate, date, remark });
        showSubmissionSuccess('内部份额转让已提交并保存');
        formTransfer.reset();
        resetDefaultDates();
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
      });
    });

    // 联动逻辑：在录入交易输入 USD 时，基于全局汇率自动估算并预填 CNH
    txAmount.addEventListener('input', () => {
      const usdVal = parseFloat(txAmount.value);
      const rateVal = parseFloat(inputCnhRate.value) || 7.2;
      if (!isNaN(usdVal)) {
        txCnhAmount.value = (usdVal * rateVal).toFixed(2);
      } else {
        txCnhAmount.value = '';
      }
    });

    let editRate = 7.2;
    let editCnhManual = false;
    const prepareEdit = event => {
      editRate = event.amount > 0 && event.cnhAmount > 0
        ? event.cnhAmount / event.amount
        : (parseFloat(inputCnhRate.value) || 7.2);
      editCnhManual = false;
    };
    editCnhAmount.addEventListener('input', () => { editCnhManual = true; });
    editAmount.addEventListener('input', () => {
      const usdVal = parseFloat(editAmount.value);
      if (!editCnhManual && ['deposit', 'withdraw'].includes(editEventType.value)) {
        editCnhAmount.value = Number.isFinite(usdVal) ? (usdVal * editRate).toFixed(2) : '';
      }
    });

    // 监听全局汇率变化
    inputCnhRate.addEventListener('change', async () => {
      const parsedRate = parseFloat(inputCnhRate.value);
      if (isNaN(parsedRate) || parsedRate <= 0) {
        showToast('汇率必须大于 0', 'error');
        return;
      }
      try {
        await Api.updateSettings({ cnhRate: parsedRate });
        showToast('全局 USD/CNH 汇率更新成功，账目已同步！', 'success');
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 自动同步外部汇率按钮
    const btnSyncRate = document.getElementById('btn-sync-rate');
    if (btnSyncRate) {
      btnSyncRate.addEventListener('click', async () => {
        btnSyncRate.classList.add('spinning');
        try {
          const rate = await Api.syncCnhRate();
          showToast(`成功同步全球最新汇率：${rate.toFixed(4)}`, 'success');
          inputCnhRate.value = rate.toFixed(4);
          await loadAllData();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          btnSyncRate.classList.remove('spinning');
        }
      });
    }

    // 监听编辑账目表单提交
    formEditEvent.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (['deposit', 'withdraw', 'transfer'].includes(editEventType.value) && !validateSundayDateInput(editDate)) {
        editDate.reportValidity();
        return;
      }
      if (editEventType.value === 'valuation' && !validateValuationDateInput(editDate)) {
        editDate.reportValidity();
        return;
      }
      await submitOnce(formEditEvent, async () => {
      const id = editEventId.value;
      const type = editEventType.value;
      const date = editDate.value;
      const remark = editRemark.value.trim();

      const payload = { date, remark };
      if (type === 'deposit' || type === 'withdraw') {
        payload.member = editMember.value;
        payload.amount = parseFloat(editAmount.value);
        payload.cnhAmount = editCnhAmount.value.trim() === '' ? null : parseFloat(editCnhAmount.value);
      } else if (type === 'valuation') {
        payload.totalNAV = parseFloat(editAmount.value);
      } else if (type === 'transfer') {
        payload.fromMember = editFromMember.value;
        payload.toMember = editToMember.value;
        payload.amount = parseFloat(editAmount.value);
        payload.cnhRate = parseFloat(editCnhRate.value);
      }

      try {
        await Api.updateEvent(id, payload);
        showToast('账目修改成功，全局数据已级联重算！', 'success');
        closeModal(editEventModal);
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
      });
    });

    // 关闭修改模态框

    // 出入金录入提交
    formTransaction.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateSundayDateInput(txDate)) {
        txDate.reportValidity();
        return;
      }
      await submitOnce(formTransaction, async () => {

      const member = elTxMember.value;
      const type = document.querySelector('input[name="txType"]:checked').value;
      const amount = parseFloat(txAmount.value);
      const cnhAmount = txCnhAmount.value.trim() === '' ? undefined : parseFloat(txCnhAmount.value);
      const date = txDate.value;
      const remark = txRemark.value.trim();

      if (!member) {
        showToast('请先创建家庭成员再进行交易登记', 'error');
        return;
      }

      try {
        await Api.addTransaction({ member, type, amount, cnhAmount, date, remark });
        showSubmissionSuccess('交易记录已提交并保存');
        formTransaction.reset();
        resetDefaultDates();
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
      });
    });

    // 估值更新提交
    formValuation.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateValuationDateInput(valDate)) {
        valDate.reportValidity();
        return;
      }
      await submitOnce(formValuation, async () => {

      const totalNAV = parseFloat(valTotalNav.value);
      const date = valDate.value;
      const remark = valRemark.value.trim();

      try {
        await Api.updateValuation({ totalNAV, date, remark });
        showSubmissionSuccess('基金估值已提交并完成重估');
        formValuation.reset();
        resetDefaultDates();
        await loadAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
      });
    });

    return { updateTransferDisplay: updateTfCnhDisplay, prepareEdit };
  }

  window.FundTransactionController = { init };
})();
