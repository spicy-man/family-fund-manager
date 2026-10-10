/**
 * 历史流水表格渲染器。
 * 主应用提供状态、DOM 和行为回调；本模块只负责将状态渲染为表格。
 */
window.FundLedgerRenderer = {
  render({ state, members, elements, utils, onEdit, onDelete }) {
    const { filterMember, filterType, ledgerTbody } = elements;
    const { escapeHtml, formatMoney } = utils;
    const memberFilter = filterMember.value;
    const typeFilter = filterType.value;
    ledgerTbody.replaceChildren();

    const memberName = id => members.find(member => member.id === id)?.name || '未知成员';
    const formatRate = value => {
      const rate = Number(value);
      if (!Number.isFinite(rate)) return '业绩';
      return `${(rate * 100).toFixed(2).replace(/\.00$/, '')}%`;
    };
    let rendered = 0;

    [...state.events].reverse().forEach(event => {
      if (memberFilter !== 'all') {
        if (memberFilter === 'system' && !['valuation', 'performance_settlement', 'performance_settlement_reversal'].includes(event.type)) return;
        if (memberFilter !== 'system' && event.type === 'transfer' && event.fromMember !== memberFilter && event.toMember !== memberFilter) return;
        if (memberFilter !== 'system' && event.type !== 'transfer' && event.member !== memberFilter) return;
      }
      if (typeFilter !== 'all' && event.type !== typeFilter) return;

      const row = document.createElement('tr');
      if (event.type === 'performance_settlement') row.className = 'ledger-row--settlement';
      if (event.type === 'performance_settlement_reversal') row.className = 'ledger-row--settlement-reversal';
      if (['withdraw', 'transfer'].includes(event.type) && event._disposedLots?.length) row.className = 'ledger-row--disposal';
      row.classList.add('ledger-card');
      const labels = ['时间', '流水明细', '类型', '出资/估值金额', '成交净值', '结算份额', '结算市值'];
      const append = (html, className = '') => {
        const cell = document.createElement('td');
        cell.dataset.label = labels[row.children.length];
        if (className) cell.className = className;
        cell.innerHTML = html;
        row.appendChild(cell);
      };

      append(escapeHtml(event.date), 'font-outfit');
      row.firstChild.style.fontSize = '0.78rem';

      let actor = '系统';
      let details;
      if (event.type === 'transfer') {
        const from = memberName(event.fromMember);
        const to = memberName(event.toMember);
        actor = `${from} ⇄ ${to}`;
        details = `<div style="font-weight:600;line-height:1.25;"><span style="color:var(--color-primary);">${escapeHtml(from)}</span><span style="color:var(--color-text-muted);font-weight:700;margin:0 2px;">⇄</span><span style="color:var(--color-green);">${escapeHtml(to)}</span></div>`;
      } else if (event.type === 'performance_settlement') {
        const gp = memberName(event.gpMember);
        const affectedLpCount = (event._breakdown || event.snapshot?.breakdown || []).filter(item => item.fee > 0).length;
        actor = `系统 → ${gp}`;
        details = `<div class="settlement-event-title">${escapeHtml(event.remark || '业绩结算')}</div>`;
        details += `<div class="settlement-event-route"><span>系统</span><span>→</span><strong>${escapeHtml(gp)}</strong><i></i><span>${affectedLpCount ? `涉及 ${affectedLpCount} 位 LP` : '本期无应计报酬'}</span></div>`;
      } else {
        actor = event.member ? memberName(event.member) : '系统';
        details = `<div style="font-weight:600;line-height:1.25;">${escapeHtml(actor)}</div>`;
      }
      if (event.type !== 'performance_settlement') {
        details += `<div class="privacy-sensitive" style="color:var(--color-text-muted);font-size:0.72rem;margin-top:2px;line-height:1.2;">(${escapeHtml(event.remark || (event.type === 'transfer' ? '内部转让' : '无备注'))})</div>`;
      }
      append(details);

      const typeMeta = {
        deposit: ['badge-deposit', '入金'], withdraw: ['badge-withdraw', '出金'],
        transfer: ['badge-transfer', '转让'], valuation: ['badge-valuation', '估值'],
        performance_settlement: ['badge-settlement', '业绩结算'],
        performance_settlement_reversal: ['badge-withdraw', '结算冲销']
      }[event.type];
      append(`<span class="tx-badge ${typeMeta[0]}">${typeMeta[1]}</span>`);

      let amountHtml;
      const isSelfGpDisposal = event.performanceFee?.gpMember ===
        (event.type === 'transfer' ? event.fromMember : event.member);
      const feeCaption = isSelfGpDisposal ? '其中内部结晶业绩报酬' : '另结业绩报酬';
      if (event.type === 'deposit') amountHtml = `<div class="amount-double-line"><span class="amount-usd privacy-sensitive" style="color:var(--color-green);">+$${formatMoney(event.amount)}</span><span class="amount-cnh privacy-sensitive">+¥${formatMoney(event.cnhAmount || event._cnhAmountComputed)}</span></div>`;
      else if (event.type === 'withdraw') amountHtml = `<div class="amount-double-line"><span class="amount-usd privacy-sensitive" style="color:var(--color-magenta);">-$${formatMoney(event.amount)}</span>${event._performanceFee ? `<span class="privacy-sensitive" style="font-size:.66rem">${feeCaption} $${formatMoney(event._performanceFee)}</span>` : ''}</div>`;
      else if (event.type === 'transfer') amountHtml = `<div class="amount-double-line"><span class="amount-usd privacy-sensitive" style="color:var(--color-cyan);font-weight:700;">⇄ $${formatMoney(event.amount)}</span><span class="amount-cnh privacy-sensitive" style="font-size:0.68rem;">≈ ¥${formatMoney(event.cnhAmount || event._cnhAmountComputed)} (汇率: ${(event.cnhRate || state.summary.cnhRate || 7.2).toFixed(4)})</span>${event._performanceFee ? `<span class="privacy-sensitive" style="font-size:.66rem;color:var(--color-magenta)">${isSelfGpDisposal ? feeCaption : '出让方另结报酬'} $${formatMoney(event._performanceFee)}</span>` : ''}</div>`;
      else if (event.type === 'performance_settlement') amountHtml = `<div class="amount-double-line"><span style="font-size:.66rem;color:var(--color-text-muted);">业绩报酬</span><span class="amount-usd privacy-sensitive" style="color:var(--color-cyan);">$${formatMoney(event._totalFee ?? event.snapshot?.totalFee ?? 0)}</span></div>`;
      else if (event.type === 'performance_settlement_reversal') amountHtml = `<div class="amount-double-line"><span style="color:var(--color-magenta);">撤销 ${escapeHtml(event.settlementDate || '')}</span></div>`;
      else amountHtml = `<div class="amount-double-line"><span class="amount-usd privacy-sensitive" style="color:var(--color-purple);">$${formatMoney(event.totalNAV)}</span></div>`;
      if (['withdraw', 'transfer'].includes(event.type) && event._disposedLots?.length) {
        const ratio = Math.max(0, Math.min(1, event._disposedRatio || 0));
        const hint = event._disposalVersion >= 2
          ? `各批次按净额同比结晶 ${(ratio * 100).toFixed(2)}%`
          : `历史出金口径 ${(ratio * 100).toFixed(2)}%`;
        amountHtml = amountHtml.replace('</div>', `<span class="disposal-breakdown-hint">${hint} · 悬停查看</span></div>`);
      }
      append(amountHtml);

      const navHtml = event.type === 'performance_settlement'
        ? `<div class="amount-double-line"><span style="font-size:.62rem;color:var(--color-text-muted);">结算 NAV</span><span class="privacy-sensitive text-cyan">${(event._navAtTx || event.snapshot?.navPerShare || 1).toFixed(4)}</span></div>`
        : `<span class="privacy-sensitive text-cyan">${(event._navAtTx || 1).toFixed(4)}</span>`;
      append(navHtml, 'font-outfit text-cyan');
      const sharesHtml = event.type === 'performance_settlement'
        ? `<div class="amount-double-line"><span style="font-size:.62rem;color:var(--color-text-muted);">划转给 GP</span><span class="privacy-sensitive">${(event._feeShares ?? event.snapshot?.feeShares ?? 0).toFixed(4)} 份</span></div>`
        : `<span class="privacy-sensitive">${(event._totalSharesAfter || 0).toFixed(4)} 份</span>`;
      append(sharesHtml, 'font-outfit');
      const totalNav = event._totalNAVAfter || 0;
      const valueHtml = event.type === 'deposit'
        ? `<div class="amount-double-line"><span class="amount-usd privacy-sensitive">$${formatMoney(totalNav)}</span><span class="amount-cnh privacy-sensitive" style="font-size:0.68rem;">≈ ¥${formatMoney(totalNav * (state.summary.cnhRate || 7.2))}</span></div>`
        : event.type === 'performance_settlement'
          ? `<div class="amount-double-line"><span style="font-size:.62rem;color:var(--color-text-muted);">结算后基金资产</span><span class="amount-usd privacy-sensitive">$${formatMoney(totalNav)}</span></div>`
          : `<div class="amount-double-line"><span class="amount-usd privacy-sensitive">$${formatMoney(totalNav)}</span></div>`;
      append(valueHtml);

      const actions = document.createElement('td');
      const actionBox = document.createElement('div');
      actionBox.className = 'action-btns-flex';
      const makeButton = (className, title, icon) => {
        const button = document.createElement('button');
        button.className = className;
        button.title = title;
        button.innerHTML = icon;
        actionBox.appendChild(button);
        return button;
      };
      if (!['performance_settlement', 'performance_settlement_reversal'].includes(event.type)) {
        const edit = makeButton('btn-edit', '修改此条流水', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>');
        edit.addEventListener('click', () => onEdit(event));
        const remove = makeButton('btn-delete', '删除此条流水并重算', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>');
        remove._deleteEventId = event.id;
        remove.addEventListener('click', () => onDelete(event.id, actor, event.type, event.amount || event.totalNAV));
      }
      actions.appendChild(actionBox);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ledger-card-toggle';
      toggle.textContent = '展开详情';
      toggle.setAttribute('aria-expanded', 'false');
      const setLabel = () => toggle.setAttribute('aria-label', event.date + ' ' + actor + ' ' + typeMeta[1] + '，' + toggle.textContent);
      setLabel();
      toggle.addEventListener('click', () => {
        const open = row.classList.toggle('ledger-card--open');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? '收起详情' : '展开详情';
        setLabel();
      });
      actions.appendChild(toggle);
      actions.dataset.label = '操作';
      row.appendChild(actions);
      ledgerTbody.appendChild(row);
      if (event.type === 'performance_settlement') {
        const breakdown = event._breakdown || event.snapshot?.breakdown || [];
        const detailRow = document.createElement('tr');
        detailRow.className = 'ledger-row--settlement-detail';
        const detailCell = document.createElement('td');
        detailCell.colSpan = 8;
        const annualRateLabel = formatRate(event.annualRate);
        const breakdownRows = breakdown.map(item => `
          <div class="settlement-breakdown-item">
            <strong>${escapeHtml(memberName(item.member))}</strong>
            <span><small>结算前价值</small>$${formatMoney(item.valueBefore || 0)}</span>
            <span><small>${annualRateLabel} 门槛</small>$${formatMoney(item.hurdle || 0)}</span>
            <span class="${item.excess > 0 ? 'text-green' : ''}"><small>超额收益</small>$${formatMoney(item.excess || 0)}</span>
            <span class="text-cyan"><small>业绩报酬</small>$${formatMoney(item.fee || 0)}</span>
            <span><small>划转份额</small>${(item.feeShares || 0).toFixed(4)} 份</span>
          </div>`).join('');
        detailCell.innerHTML = `<div class="settlement-breakdown-panel"><div class="settlement-breakdown-heading"><strong>结算快照</strong><span>数据锁定于 ${escapeHtml(event.date)} · 鼠标移开后收起</span></div>${breakdownRows || '<div class="settlement-breakdown-empty">本期没有产生应计业绩报酬。</div>'}</div>`;
        detailRow.appendChild(detailCell);
        ledgerTbody.appendChild(detailRow);
      } else if (['withdraw', 'transfer'].includes(event.type) && event._disposedLots?.length) {
        const detailRow = document.createElement('tr');
        detailRow.className = 'ledger-row--settlement-detail ledger-row--disposal-detail';
        const detailCell = document.createElement('td');
        detailCell.colSpan = 8;
        const annualRateLabel = formatRate(event.performanceFee?.annualRate);
        const ratio = Math.max(0, Math.min(1, event._disposedRatio || 0));
        const actionLabel = event.type === 'withdraw' ? '出金' : '转出';
        const disposalMethod = event._disposalVersion >= 2
          ? `按 LP 实收净额计算，所有存量批次同比处置 ${(ratio * 100).toFixed(2)}% · 未过门槛批次报酬为 0`
          : `历史计算口径：现金份额同比扣减 ${(ratio * 100).toFixed(2)}%，业绩报酬份额另行扣减`;
        const carryExitNote = event._carrySharesDisposed > 0
          ? ` · 另结清已归属 GP 报酬 ${event._carrySharesDisposed.toFixed(6)} 份`
          : '';
        const lotRows = event._disposedLots.map((lot, index) => {
          const excess = lot.aboveHurdle ?? ((lot.value || 0) - (lot.hurdle || 0));
          return `
          <div class="settlement-breakdown-item disposal-breakdown-item">
            <strong>批次 ${index + 1}<small>起算日 ${escapeHtml(lot.startDate || '')} · ${lot.holdingDays ?? 0} 天</small></strong>
            <span><small>本次总扣减份额</small>${(lot.totalShares ?? lot.shares ?? 0).toFixed(6)} 份<small class="disposal-share-split">LP 实收 ${(lot.cashShares || 0).toFixed(6)} · GP 报酬 ${(lot.feeShares || 0).toFixed(6)}</small></span>
            <span><small>本次处置总值</small>$${formatMoney(lot.totalValue ?? lot.value ?? 0)}<small class="disposal-share-split">LP 实收 $${formatMoney(lot.cashValue || 0)}</small></span>
            <span><small>按比例 ${annualRateLabel} 门槛</small>$${formatMoney(lot.hurdle || 0)}</span>
            <span class="${excess > 0 ? 'text-green' : excess < 0 ? 'text-magenta' : ''}"><small>超门槛差额</small>${excess > 0 ? '+' : excess < 0 ? '-' : ''}$${formatMoney(Math.abs(excess))}</span>
            <span class="${lot.fee > 0 ? 'text-cyan' : ''}"><small>本批次业绩报酬</small>$${formatMoney(lot.fee || 0)}</span>
          </div>`;
        }).join('');
        detailCell.innerHTML = `<div class="settlement-breakdown-panel disposal-breakdown-panel"><div class="settlement-breakdown-heading"><strong>${actionLabel}批次结晶明细</strong><span>${disposalMethod}${carryExitNote}</span></div>${lotRows}</div>`;
        detailRow.appendChild(detailCell);
        ledgerTbody.appendChild(detailRow);
      }
      rendered += 1;
    });

    if (!rendered) {
      const empty = document.createElement('tr');
      empty.className = 'empty-row';
      empty.innerHTML = '<td colspan="8" style="text-align:center;color:var(--color-text-muted);padding:40px 0;">未检索到符合过滤条件的交易记录</td>';
      ledgerTbody.appendChild(empty);
    }
    window.FundLedgerHover?.bind(ledgerTbody);
  }
};

// Compact screens keep the full log available on demand.
document.addEventListener('DOMContentLoaded', () => {
  const section = document.getElementById('ledger-section');
  const toggle = document.getElementById('ledger-section-toggle');
  if (!section || !toggle) return;
  const compact = window.matchMedia('(max-width: 720px)');
  let expanded = false;
  const sync = () => {
    const open = !compact.matches || expanded;
    section.classList.toggle('ledger-section--collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '收起流水' : '展开流水';
  };
  toggle.addEventListener('click', () => { expanded = !expanded; sync(); });
  compact.addEventListener('change', sync);
  sync();
});
