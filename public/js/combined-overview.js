(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const shares = value => Number(value || 0).toFixed(4);
  const percent = value => value == null ? '—' : `${value > 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
  const amount = (usd, cnh) => `<span class="privacy-sensitive">$${money(usd)}</span>${cnh === undefined ? '' : `<small class="privacy-sensitive">¥${money(cnh)} CNH</small>`}`;
  const returns = (usd, cnh) => `<span class="privacy-sensitive">${percent(usd)}</span><small class="privacy-sensitive">${percent(cnh)} CNH · 含汇率</small>`;
  const ledgerLink = (id, name) => {
    const url = new URL(window.location.href);
    if (id === 'default') url.searchParams.delete('ledger'); else url.searchParams.set('ledger', id);
    return `<a href="${escape(url.href)}">${escape(name)}</a>`;
  };
  function render(data) {
    const s = data.summary;
    const metric = (label, usd, cnh) => `<article class="combined-metric"><span>${label}</span><strong class="font-outfit privacy-sensitive">$${money(usd)}</strong><small class="privacy-sensitive">≈ ¥${money(cnh)}</small></article>`;
    const dates = new Set(data.ledgers.map(ledger => ledger.valuationDate));
    const ledgerRows = data.ledgers.map(ledger => {
      const a = ledger.summary;
      const weight = s.totalNAV > 0 ? a.totalNAV / s.totalNAV * 100 : null;
      return `<tr><td>${ledgerLink(ledger.id, ledger.name)}<small>${escape(ledger.valuationDate || '暂无估值')}</small></td>
        <td>${amount(a.totalNAV, a.cnhTotalNAV)}<small class="privacy-sensitive">占比 ${weight === null ? '—' : weight.toFixed(2) + '%'}</small></td>
        <td>${amount(a.remainingPrincipal, a.cnhRemainingPrincipal)}</td><td>${amount(a.activeProfit, a.cnhActiveProfit)}</td>
        <td>${returns(a.activeProfitRate, a.cnhActiveProfitRate)}</td><td>${amount(a.profit, a.cnhProfit)}</td></tr>`;
    }).join('');
    const allocation = s.totalNAV > 0 ? `<div class="combined-allocation privacy-sensitive" aria-label="各账本资产占比">${data.ledgers.filter(ledger => ledger.summary.totalNAV > 0).map((ledger, index) =>
      `<span style="flex:${ledger.summary.totalNAV / s.totalNAV};opacity:${Math.max(.3, 1 - index * .12)}" title="${escape(ledger.name)}"></span>`).join('')}</div>` : '';
    const members = data.members.map(member => {
      const rows = member.breakdown.map(a => `<tr><td>${ledgerLink(a.ledgerId, a.ledgerName)}<small>${escape(a.name)}</small></td>
        <td>${amount(a.currentValue, a.cnhCurrentValue)}</td><td>${returns(a.profitRate, a.cnhProfitRate)}</td>
        <td>${amount(a.totalDeposit, a.cnhDeposit)}</td><td>${amount(a.totalWithdraw, a.cnhWithdraw)}</td>
        <td>${amount(a.lpCurrentValue)}<small class="privacy-sensitive">${shares(a.lpShares)} 份</small></td>
        <td>${amount(a.gpCarryValue)}<small class="privacy-sensitive">${shares(a.gpCarryShares)} 份</small></td></tr>`).join('');
      const stat = (label, value) => `<span>${label}<strong class="privacy-sensitive">$${money(value)}</strong></span>`;
      return `<details class="combined-member"><summary tabindex="0"><span class="combined-member-heading"><span><strong>${escape(member.name)}</strong> <small>编号 ${escape(member.id)} · ${member.breakdown.length} 个账本</small></span><span>${amount(member.currentValue, member.cnhCurrentValue)}</span><span>${returns(member.profitRate, member.cnhProfitRate)}</span></span></summary>
        ${member.names.length > 1 ? `<p class="combined-note combined-warning">同一编号的姓名不一致：${member.names.map(escape).join(' / ')}，请核对成员信息。</p>` : ''}
        <div class="combined-member-stats">${stat('剩余本金', member.remainingPrincipal)}${stat('累计收益', member.profit)}${stat('累计入金', member.totalDeposit)}${stat('累计出金', member.totalWithdraw)}${stat('LP资产', member.lpCurrentValue)}${stat('GP报酬资产', member.gpCarryValue)}</div>
        <p class="combined-note privacy-sensitive">CNH：剩余本金 ¥${money(member.cnhRemainingPrincipal)} · 累计收益 ¥${money(member.cnhProfit)} · 入金 ¥${money(member.cnhDeposit)} · 出金 ¥${money(member.cnhWithdraw)}</p>
        <div class="combined-table-wrap"><table class="combined-table"><thead><tr><th>来源账本</th><th>成员资产</th><th>累计收益率</th><th>入金</th><th>出金</th><th>LP资产 / 份额</th><th>GP报酬 / 份额</th></tr></thead><tbody>${rows}</tbody></table></div>
      </details>`;
    }).join('');
    return `<p class="combined-note">已汇总 ${data.ledgers.length} 个账本、${data.members.length} 位成员。${dates.size > 1 ? '<span class="combined-warning">各账本估值日期不一致，以下采用各自最新记录。</span>' : ''}</p>
      <div class="combined-metrics">${metric('总资产', s.totalNAV, s.cnhTotalNAV)}${metric('剩余本金', s.remainingPrincipal, s.cnhRemainingPrincipal)}${metric('当前在管收益', s.activeProfit, s.cnhActiveProfit)}${metric('历史累计收益', s.profit, s.cnhProfit)}</div>
      <div class="combined-member-stats"><span>在管本金收益率 ${returns(s.activeProfitRate, s.cnhActiveProfitRate)}</span><span>历史累计收益率 ${returns(s.profitRate, s.cnhProfitRate)}</span>${statSummary('累计入金', s.totalDeposit, s.cnhTotalDeposit)}${statSummary('累计出金', s.totalWithdraw, s.cnhTotalWithdraw)}</div>
      <h4>账本资产分布</h4>${allocation}<div class="combined-table-wrap"><table class="combined-table"><thead><tr><th>账本 / 估值日期</th><th>总资产 / 占比</th><th>剩余本金</th><th>在管收益</th><th>在管收益率</th><th>累计收益</th></tr></thead><tbody>${ledgerRows}</tbody></table></div>
      <h4>家庭成员汇总</h4><p class="combined-note">按成员编号合并；点击成员展开来源明细。成员资产和累计收益率与家庭成员卡片一致，包含已归属的 GP 报酬。</p>${members || '<p class="combined-note">暂无家庭成员。</p>'}
      <p class="combined-note">在管收益率 = 在管收益 ÷ 剩余本金；历史累计收益率 = 累计收益 ÷ 累计入金。成员累计收益 = 当前资产 + 累计出金 − 累计入金；零入金时收益率与成员卡片一致显示 0%。CNH 沿用各账本人民币本金及当前汇率口径，包含汇率影响。单位净值与份额仅在各账本内有效。</p>
      <p class="combined-note">入金、出金按原账本口径累计。若跨账本转账分别记为出金与入金，这一版会保留两笔记录，尚未自动抵消。</p>`;
  }
  function statSummary(label, usd, cnh) { return `<span>${label} ${amount(usd, cnh)}</span>`; }
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('btn-combined-overview');
    const modal = document.getElementById('combined-overview-modal');
    if (!button || !modal) return;
    const status = document.getElementById('combined-overview-status');
    const content = document.getElementById('combined-overview-content');
    window.FundModal.bindAccessible(modal, document.getElementById('btn-close-combined-overview'));
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      content.replaceChildren();
      status.textContent = '正在汇总所有账本…';
      window.FundModal.open(modal, button);
      try {
        const { data } = await requestApi('/api/ledgers/combined', { cache: 'no-store' });
        content.innerHTML = render(data);
        status.textContent = '';
      } catch (error) { status.textContent = `无法加载合并总览：${error.message}。关闭后可重试。`; }
      finally { button.disabled = false; }
    });
  });
})();
