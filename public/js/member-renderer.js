/**
 * 成员资产卡片渲染器。
 * 保持展示逻辑与全局状态解耦，主应用只传入已计算的账本状态。
 */
window.FundMemberRenderer = {
  renderGrid({ state, members, elements, utils, isDark }) {
    const { grid } = elements;
    const { escapeHtml, formatMoney, getAvatarText, getMemberAvatarColor } = utils;

    if (members.length === 0) {
      grid.innerHTML = '<div style="grid-column:1 / -1;text-align:center;color:var(--color-text-muted);padding:30px;font-size:0.85rem;">暂无家庭成员。请点击右上角【家庭成员管理】添加出资人。</div>';
      return;
    }

    grid.innerHTML = members.map((member, index) => {
      const account = state.members[member.id] || {
        currentValue: 0, shares: 0, totalDeposit: 0, totalWithdraw: 0, profitRate: 0,
        cnhCurrentValue: 0, cnhDeposit: 0, cnhProfitRate: 0
      };
      const usdClass = account.profitRate >= 0 ? 'text-green' : 'text-magenta';
      const cnhClass = account.cnhProfitRate >= 0 ? 'text-green' : 'text-magenta';
      const displayName = escapeHtml(member.name);
      const avatar = escapeHtml(getAvatarText(member.name));
      const avatarColor = getMemberAvatarColor(member.id || member.name, isDark, index);
      const dimmed = account.totalDeposit === 0 ? 'opacity:0.55;' : '';
      const roleBadges = [member.roles?.lp !== false ? 'LP' : '', member.roles?.gp ? (member.primaryGp ? '主GP' : 'GP') : '']
        .filter(Boolean).map(role => `<span class="tx-badge badge-transfer" style="font-size:.58rem;padding:2px 5px">${role}</span>`).join(' ');
      const lpLedger = account.lpLedger || [];
      const totalHurdle = lpLedger.reduce((sum, lot) => sum + lot.hurdle, 0);
      const ledgerRows = lpLedger.map((lot, lotIndex) => `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;padding:5px 0;border-top:1px dashed var(--color-card-divider)">
          <span>批次${lotIndex + 1} · ${escapeHtml(lot.startDate)}</span><span style="text-align:right">${lot.shares.toFixed(4)}份</span>
          <span>高水位NAV ${formatMoney(lot.highWaterNav)}</span><span style="text-align:right">门槛 $${formatMoney(lot.hurdle)}</span>
          <span>当前 $${formatMoney(lot.currentValue)}</span><span></span>
        </div>`).join('');
      return `
        <div class="member-card" style="${dimmed}" tabindex="0">
          <div class="member-avatar" style="background:${avatarColor.background};color:${avatarColor.color};">${avatar}</div>
          <div class="member-details">
            <div class="member-header">
              <span class="member-name" title="${displayName}">${displayName}</span>
              <div class="member-returns">
                <span class="member-roi ${usdClass} privacy-sensitive" style="font-size:0.85rem;font-weight:700;">${account.profitRate >= 0 ? '+' : ''}${account.profitRate.toFixed(2)}% <small>USD</small></span>
                <span class="member-roi ${cnhClass} privacy-sensitive" title="CNH收益率，含汇率变动影响" style="font-size:0.75rem;font-weight:600;margin-top:1px;">${account.cnhProfitRate >= 0 ? '+' : ''}${account.cnhProfitRate.toFixed(2)}% <small>CNH·含汇率</small></span>
              </div>
            </div>
            <div class="member-asset font-outfit" style="display:flex;flex-direction:column;line-height:1.25;margin-bottom:2px;">
              <span class="privacy-sensitive" style="font-size:1.15rem;font-weight:700;">$${formatMoney(account.currentValue)}</span>
              <span class="privacy-sensitive" style="font-size:0.72rem;font-weight:600;color:var(--color-cyan);">≈ ¥${formatMoney(account.cnhCurrentValue)} <small>CNH</small></span>
            </div>
            <div class="member-shares privacy-sensitive" style="font-size:0.72rem;color:var(--color-text-muted);line-height:1.2;margin-bottom:4px;">${account.shares.toFixed(4)} 份</div>
            <div class="member-sub-info" style="display:flex;justify-content:space-between;font-size:0.68rem;padding-top:4px;border-top:1px dashed var(--color-card-divider);color:var(--color-text-muted);"><span>入金 <span class="privacy-sensitive">$${formatMoney(account.totalDeposit)}</span></span><span>出金 <span class="privacy-sensitive">$${formatMoney(account.totalWithdraw)}</span></span></div>
            <div class="member-sub-info" style="display:flex;justify-content:space-between;font-size:0.65rem;padding-top:2px;color:var(--color-text-muted);opacity:0.85;"><span>CNH入金 <span class="privacy-sensitive">¥${formatMoney(account.cnhDeposit)}</span></span></div>
          </div>
          <div class="member-hover-details privacy-sensitive">
            <div class="member-hover-details__header"><strong>${displayName}</strong><span>${roleBadges}</span></div>
            <div>LP：${(account.lpShares || 0).toFixed(4)}份 / $${formatMoney(account.lpCurrentValue || 0)}</div>
            <div>GP报酬：${(account.gpCarryShares || 0).toFixed(4)}份 / $${formatMoney(account.gpCarryValue || 0)}</div>
            ${member.roles?.lp !== false ? `<div>门槛台账：${lpLedger.length}批 / $${formatMoney(totalHurdle)}</div>` : ''}
            ${lpLedger.length ? `<div class="member-hover-details__ledger" tabindex="0" role="region" aria-label="${displayName}的资金批次详情">${ledgerRows}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  }
};
