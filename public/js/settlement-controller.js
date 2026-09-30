(function () {
  function init({ elements, api, modal, submission, getMembers, loadAllData, showToast, showSubmissionSuccess, escapeHtml, formatMoney }) {
    const {
      btnReverseSettlement, settleGp, settleDate, settleRemark,
      settlementPreviewModal, btnPreviewSettlement, settlementPreviewSubtitle,
      settlementPreviewSummary, settlementPreviewBody, btnConfirmSettlement,
      formSettlement
    } = elements;
    const Api = api;
    const { open: openModal, close: closeModal } = modal;
    const { runOnce: submitOnce } = submission;
    let pendingSettlement = null;
    let previewVersion = 0;

    btnReverseSettlement.addEventListener('click', async () => {
      if (!confirm('确定撤销最近一次有效业绩结算吗？系统会保留原结算并追加冲销记录，相关账期将重新开放。')) return;
      btnReverseSettlement.disabled = true;
      try {
        const result = await Api.reverseLatestSettlement('管理员撤销最近一次业绩结算');
        showToast(result.message, 'success');
        await loadAllData();
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        btnReverseSettlement.disabled = false;
      }
    });

    const settlementPayload = () => ({ gpMember: settleGp.value, date: settleDate.value, remark: settleRemark.value.trim() });
    const invalidateSettlementPreview = () => {
      previewVersion++;
      pendingSettlement = null;
      closeModal(settlementPreviewModal);
    };
    [settleGp, settleDate, settleRemark].forEach(element => element.addEventListener('input', invalidateSettlementPreview));
    btnPreviewSettlement.addEventListener('click', async () => {
      invalidateSettlementPreview();
      const version = previewVersion;
      const payload = Object.freeze(settlementPayload());
      try {
        const preview = await Api.previewSettlement(payload);
        if (version !== previewVersion) return;
        const formatRate = value => `${(Number(value) * 100).toFixed(2).replace(/\.00$/, '')}%`;
        const annualRateLabel = formatRate(preview.event.annualRate);
        const feeRateLabel = formatRate(preview.event.feeRate);
        const rows = preview.breakdown.map(item => {
          const name = getMembers().find(member => member.id === item.member)?.name || item.member;
          const lotRows = (item.lots || []).map((lot, index) => {
            const sourceLabel = lot.sourceType === 'transfer_in'
              ? '转让取得'
              : lot.sourceType === 'settlement_reset'
                ? '上次结算基准'
                : '现金入金';
            return `
            <tr>
              <td><span style="color:var(--color-text-muted)">↳ 批次 ${index + 1} · ${sourceLabel}</span></td>
              <td>${escapeHtml(lot.startDate)}</td>
              <td class="privacy-sensitive">$${formatMoney(lot.basis)}</td>
              <td class="privacy-sensitive">${lot.entryNav.toFixed(4)}</td>
              <td class="privacy-sensitive">${lot.shares.toFixed(6)}</td>
              <td>${lot.holdingDays}天</td>
              <td class="privacy-sensitive">$${formatMoney(lot.currentValue)}</td>
              <td class="privacy-sensitive">$${formatMoney(lot.hurdle)}</td>
              <td class="privacy-sensitive ${lot.aboveHurdle >= 0 ? 'text-green' : 'text-magenta'}">${lot.aboveHurdle >= 0 ? '+' : '-'}$${formatMoney(Math.abs(lot.aboveHurdle))}</td>
            </tr>`;
          }).join('');
          return `
            <tr style="background:rgba(80,130,255,.08)">
              <td colspan="6"><strong>${escapeHtml(name)}</strong><span style="margin-left:10px;color:var(--color-text-muted)">${item.lots?.length || 0}笔资金批次 · 结算后 ${item.sharesAfter.toFixed(6)}份</span></td>
              <td class="privacy-sensitive"><strong>$${formatMoney(item.valueBefore)}</strong></td>
              <td class="privacy-sensitive"><strong>$${formatMoney(item.hurdle)}</strong></td>
              <td class="privacy-sensitive"><strong class="${item.excess > 0 ? 'text-green' : ''}">$${formatMoney(item.excess)}</strong><div class="settlement-fee-detail">${feeRateLabel}报酬 $${formatMoney(item.fee)} · ${item.feeShares.toFixed(6)}份</div></td>
            </tr>${lotRows}`;
        }).join('');
        const gpName = getMembers().find(member => member.id === payload.gpMember)?.name || '主GP';
        settlementPreviewSubtitle.textContent = `${payload.date} · 采用 ${preview.valuationDate} 估值 · ${annualRateLabel} 门槛 / ${feeRateLabel} 报酬 · GP：${gpName}`;
        settlementPreviewSummary.innerHTML = [
          ['结算单位净值', preview.navPerShare.toFixed(4)],
          ['参与LP', `${preview.breakdown.length} 人`],
          ['合计业绩报酬', `$${formatMoney(preview.totalFee)}`]
        ].map(([label, value]) => `<div class="info-alert" style="display:block;margin:0"><div style="font-size:.7rem;color:var(--color-text-muted)">${label}</div><strong class="privacy-sensitive" style="display:block;font-size:1.15rem;margin-top:4px">${value}</strong></div>`).join('');
        settlementPreviewBody.innerHTML = rows || '<tr><td colspan="9" style="text-align:center;padding:28px;color:var(--color-text-muted)">结算日没有持有LP份额的成员</td></tr>';
        pendingSettlement = payload;
        openModal(settlementPreviewModal, btnPreviewSettlement);
      } catch (error) {
        if (version !== previewVersion) return;
        invalidateSettlementPreview();
        showToast(error.message, 'error');
      }
    });
    btnConfirmSettlement.addEventListener('click', async () => {
      if (!pendingSettlement) return;
      const payload = pendingSettlement;
      btnConfirmSettlement.disabled = true;
      await submitOnce(formSettlement, async () => {
        try {
          await Api.confirmSettlement(payload);
          closeModal(settlementPreviewModal);
          showSubmissionSuccess('业绩结算已确认并锁账');
          invalidateSettlementPreview();
          await loadAllData();
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
      btnConfirmSettlement.disabled = false;
    });
  }

  window.FundSettlementController = { init };
})();
