(function () {
  window.FundMemberStatementController = {
    create({ getState, getMembers, modal, ui, showToast }) {
      const byId = id => document.getElementById(id);
      const dialog = byId('member-statement-modal');
      const button = byId('btn-member-statement');
      const member = byId('statement-member');
      const periodSelect = byId('statement-period');
      const content = byId('statement-content');
      const print = byId('btn-print-statement');
      const status = byId('statement-status');
      const escape = ui.escapeHtml;
      const money = value => `$${ui.formatMoney(value === 0 ? 0 : value)}`;
      let report = null;
      let oldTitle = null;
      let methodWasOpen = null;
      const todayDate = () => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date()).filter(part => part.type === 'year' || part.type === 'month' || part.type === 'day').map(part => part.value).join('-');

      function render() {
        report = null;
        print.disabled = true;
        content.innerHTML = '';
        try {
          if (!periodSelect.value) throw new Error(window.FundMemberStatement.periods(getState(), todayDate()).length
            ? '该成员暂无参与的结算周期。' : '暂无有效结算记录，完成首次业绩结算后可查看年报。');
          report = window.FundMemberStatement.build(getState(), member.value, periodSelect.value, todayDate());
          const r = report;
          const label = '期';
          const heading = r.ongoing ? '年报 · 结算至今' : '年报 · 已结算';
          const netFlows = r.deposits - r.withdrawals + r.transfersIn - r.transfersOut;
          const netProfit = r.investmentProfit - r.feesPaid + r.feesReceived;
          const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value))}`;
          const percent = value => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
          const tone = value => value > 0 ? 'statement-positive' : value < 0 ? 'statement-negative' : '';
          status.textContent = '';
          const movements = [
            ['入金', r.deposits], ['出金', -r.withdrawals],
            ['转入', r.transfersIn], ['转出', -r.transfersOut],
            ['投资收益', r.investmentProfit], ['支付报酬', -r.feesPaid], ['收到报酬', r.feesReceived]
          ];
          content.innerHTML = `<header class="statement-report-heading"><div><p class="statement-eyebrow">${escape(r.name)} · USD</p><h2>${heading}</h2><p class="statement-eyebrow">${escape(r.periodLabel)}</p></div><span class="statement-asof">账目截至 ${r.through || '暂无记录'}</span></header>
            <div class="statement-kpis">
              <div><span>期末权益</span><strong>${money(r.closing)}</strong><small>${r.closingShares.toFixed(4)} 份</small></div>
              <div><span>本${label}收益 · 含已结算报酬</span><strong class="${tone(netProfit)}">${signed(netProfit)}</strong><small>投资 ${signed(r.investmentProfit)} · 报酬 ${signed(r.feesReceived - r.feesPaid)}</small></div>
              <div><span>本${label}净流入</span><strong>${signed(netFlows)}</strong><small>权益变化 ${signed(r.change)}</small></div>
            </div>
            <section class="statement-nav"><h3>净值变化</h3><div class="statement-balance"><span>期初单位净值<strong>${r.openingNAV.toFixed(4)}</strong></span><span class="statement-balance-arrow" aria-hidden="true">→</span><span>期末单位净值<strong>${r.closingNAV.toFixed(4)}</strong></span><span class="statement-nav-rate">本${label}净值涨跌幅<strong class="${tone(r.navReturn)}">${percent(r.navReturn)}</strong></span></div></section>
            <section class="statement-reconciliation"><h3>权益变动</h3><div class="statement-balance"><span>期初权益<strong>${money(r.opening)}</strong></span><span class="statement-balance-arrow" aria-hidden="true">→</span><span>期末权益<strong>${money(r.closing)}</strong></span></div>
            <dl class="statement-movements">${movements.map(([name, value]) => `<div><dt>${name}</dt><dd class="${tone(value)}">${signed(value)}</dd></div>`).join('')}</dl></section>
            <section><h3>逐月回顾</h3><div class="statement-table-scroll"><table><thead><tr><th>月份</th><th>期末净值</th><th>净值涨跌幅</th><th>净流入</th><th>投资收益</th><th>报酬净额</th><th>期末权益</th></tr></thead><tbody>${r.months.map(item => `<tr><td>${item.month}</td><td>${item.closingNAV.toFixed(4)}</td><td class="${tone(item.navReturn)}">${percent(item.navReturn)}</td><td>${signed(item.deposits - item.withdrawals + item.transfersIn - item.transfersOut)}</td><td>${signed(item.investmentProfit)}</td><td>${signed(item.feesReceived - item.feesPaid)}</td><td>${money(item.closing)}</td></tr>`).join('')}</tbody></table></div></section>
            <section><h3>资金与报酬明细 <span class="statement-count">${r.rows.length} 笔</span></h3>${r.rows.length ? `<div class="statement-table-scroll"><table><thead><tr><th>日期</th><th>项目</th><th>金额</th><th>备注</th></tr></thead><tbody>${r.rows.map(row => `<tr><td>${row.date}</td><td>${escape(row.label)}</td><td class="${tone(row.amount)}">${signed(row.amount)}</td><td>${escape(row.remark) || '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="statement-empty">这个周期没有资金或报酬流水。</p>'}</section>
            <p class="statement-valuation">最近估值 ${r.closingValuation || '尚无（初始净值 1）'}${r.closingValuation !== r.end ? ' · 权益沿用最近已录入净值' : ''}${r.ongoing ? ' · 本期尚未结算' : ''}</p>
            <details class="statement-method"><summary>计算口径</summary>
              <p><strong>统计周期：</strong>以结算流水为边界，期初为上次结算后的权益。已结算报告的期末包含本次结算；结算至今统计到当前日期；首期从账本起始计算。同日流水按账本顺序划分，逐月回顾仅包含本期内流水。</p>
              <p><strong>权益计算：</strong>期末权益 = 期初权益 + 净流入 + 投资收益 − 支付报酬 + 收到报酬。成员入出金和已结算报酬通过份额变动计入权益。</p>
              <p><strong>净值表现：</strong>净值涨跌幅 = 期末单位净值 ÷ 期初单位净值 − 1，反映基金表现。期初估值：${r.openingValuation || '尚无（初始净值 1）'}。</p>
              <p><strong>报酬范围：</strong>仅含已结算份额变动，不含未结算预估报酬。</p>
              <p><strong>金额与更新：</strong>美元口径，金额按美分展示，尾差计入投资收益。历史账目修改或结算撤销后会重新计算。</p>
            </details>`;
          print.disabled = false;
        } catch (error) {
          status.textContent = error.message;
        }
      }
      function sync() {
        const selected = member.value;
        const members = getMembers();
        member.innerHTML = members.map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join('');
        if (members.some(item => item.id === selected)) member.value = selected;
        syncPeriods();
        button.disabled = !members.length;
        if (dialog.classList.contains('active')) render();
      }
      function syncPeriods() {
        const selectedPeriod = periodSelect.value;
        const periods = getState() ? window.FundMemberStatement.periods(getState(), todayDate(), member.value) : [];
        periodSelect.innerHTML = periods.map(item => `<option value="${escape(item.id)}">${escape(item.label)}</option>`).join('');
        if (periods.some(item => item.id === selectedPeriod)) periodSelect.value = selectedPeriod;
        periodSelect.disabled = !periods.length;
        window.FundCustomSelect?.refresh(dialog);
      }
      modal.bindAccessible(dialog, byId('btn-close-member-statement'));
      button.addEventListener('click', () => { sync(); render(); modal.open(dialog, button); });
      member.addEventListener('change', () => { syncPeriods(); render(); });
      periodSelect.addEventListener('change', render);
      print.addEventListener('click', () => {
        if (!report) return;
        if (document.body.classList.contains('privacy-mode-active')) {
          showToast('请先关闭隐私模式，再导出成员报表。', 'warning');
          return;
        }
        oldTitle = document.title;
        document.title = `${report.name}-${report.start}-${report.end}-年报`;
        document.body.classList.add('printing-member-statement');
        fitPrintPage();
        try { window.print(); } catch (error) { cleanup(); showToast('打印失败：' + error.message, 'error'); }
      });
      function fitPrintPage() {
        if (!report) return;
        const method = content.querySelector('.statement-method');
        if (method) {
          if (methodWasOpen === null) methodWasOpen = method.open;
          method.open = true;
        }
        const measurement = content.cloneNode(true);
        measurement.removeAttribute('id');
        measurement.removeAttribute('aria-live');
        measurement.setAttribute('aria-hidden', 'true');
        measurement.classList.add('statement-print-measure');
        document.body.appendChild(measurement);
        try {
          // A4 minus 15 mm margins; leave 2 mm for browser rounding.
          const pageWidth = 180 * 96 / 25.4;
          const pageHeight = 265 * 96 / 25.4;
          const scale = Math.min(1, pageWidth / measurement.scrollWidth,
            pageHeight / measurement.getBoundingClientRect().height);
          content.style.setProperty('--statement-print-scale', String(scale));
        } finally {
          measurement.remove();
        }
      }
      function cleanup() {
        document.body.classList.remove('printing-member-statement');
        content.style.removeProperty('--statement-print-scale');
        const method = content.querySelector('.statement-method');
        if (method && methodWasOpen !== null) method.open = methodWasOpen;
        methodWasOpen = null;
        if (oldTitle !== null) document.title = oldTitle;
        oldTitle = null;
      }
      window.addEventListener('afterprint', cleanup);
      window.addEventListener('beforeprint', () => {
        if (document.body.classList.contains('printing-member-statement')) fitPrintPage();
      });
      return { sync };
    }
  };
})();
