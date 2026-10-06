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
            ? '该成员暂无参与的结算周期。' : '暂无有效结算记录，完成首次业绩结算后可查看报表。');
          report = window.FundMemberStatement.build(getState(), member.value, periodSelect.value, todayDate());
          const r = report;
          const label = '期';
          const heading = '成员投资报表';
          const netFlows = r.deposits - r.withdrawals + r.transfersIn - r.transfersOut;
          const netProfit = r.investmentProfit - r.feesPaid + r.feesReceived;
          const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value))}`;
          const percent = value => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
          const highWaterNav = snapshot => snapshot && Number.isFinite(snapshot.nav) ? snapshot.nav.toFixed(4) : '—';
          const highWaterRange = r.closingHighWater && r.closingHighWater.minNav !== r.closingHighWater.maxNav
            ? ' · 期末批次区间 ' + r.closingHighWater.minNav.toFixed(4) + '–' + r.closingHighWater.maxNav.toFixed(4) : '';
          const lotSource = type => ({ deposit: '入金', transfer_in: '转入', transfer: '转入', settlement_reset: '结算重置', legacy: '历史批次' }[type] || '历史批次');
          const highWaterLots = (label, snapshot, lots) => lots?.length
            ? lots.map((lot, index) => '<tr><td>' + label + '</td><td>' + (index + 1) + '</td><td>' + escape(lot.startDate) + ' · ' + lotSource(lot.sourceType) + '</td><td>' + lot.shares.toFixed(4) + '</td><td>' + lot.highWaterNav.toFixed(4) + '</td><td>' + money(lot.basis) + '</td>' + (r.ongoing ? '<td>' + (r.potentialFee?.lots[index] ? money(r.potentialFee.lots[index].currentValue) : '—') + '</td><td>' + (r.potentialFee?.lots[index] ? money(r.potentialFee.lots[index].hurdle) : '—') + '</td><td>' + (r.potentialFee?.lots[index] ? money(r.potentialFee.lots[index].fee) : '—') + '</td>' : '') + '</tr>').join('')
            : '<tr><td>' + label + '</td><td colspan="' + (r.ongoing ? 8 : 5) + '">' + (snapshot ? '批次数据暂不可用，请重启服务并刷新。' : '无 LP 持仓') + '</td></tr>';
          const rateLabel = value => (value * 100).toFixed(2).replace(/\.00$/, '') + '%';
          const tone = value => value > 0 ? 'statement-positive' : value < 0 ? 'statement-negative' : '';
          status.textContent = '';
          const movements = [
            ['入金', r.deposits], ['出金', -r.withdrawals],
            ['转入', r.transfersIn], ['转出', -r.transfersOut],
            ['投资收益', r.investmentProfit], ['支付报酬', -r.feesPaid], ['收到报酬', r.feesReceived]
          ];
          content.innerHTML = `<header class="statement-report-heading"><div><p class="statement-eyebrow">${escape(r.name)} · USD</p><h2>${heading}</h2><p class="statement-eyebrow">统计周期：${escape(r.start)} → ${escape(r.end)} · ${r.ongoing ? '未结算' : '已结算'}</p></div><span class="statement-asof">账目截至 ${r.through || '暂无记录'}</span></header>
            <section class="statement-summary" aria-label="本期投资一览"><h3>本期投资一览</h3>
              <div class="statement-kpis">
                <div><span>${r.ongoing ? '当前权益' : '期末权益'}</span><strong>${money(r.closing)}</strong><small>持有 ${r.closingShares.toFixed(4)} 份</small></div>
                <div><span>本期净收益</span><strong class="${tone(netProfit)}">${signed(netProfit)}</strong><small>含已结算报酬</small></div>
                <div><span>本期净流入</span><strong>${signed(netFlows)}</strong><small>入出金及成员转让的净额</small></div>
                <div><span>${r.ongoing ? '潜在支付报酬' : '本期支付报酬'}</span><strong>${r.ongoing ? (r.potentialFee ? money(r.potentialFee.amount) : '暂不可用') : money(r.feesPaid)}</strong><small>${r.ongoing ? '尚未结算 · 预估金额' : '已结算 · 收到报酬 ' + money(r.feesReceived)}</small></div>
              </div>
              <div class="statement-summary-fund"><span>基金单位净值 <strong>${r.closingNAV.toFixed(4)}</strong></span><span>本期基金净值涨跌 <strong class="${tone(r.navReturn)}">${percent(r.navReturn)}</strong></span><span>期初净值 ${r.openingNAV.toFixed(4)}</span></div>
              <p class="statement-summary-note">${r.ongoing ? '当前权益与本期净收益均未扣除预估报酬；逐批次计提依据见下方明细。' : '期末权益与本期净收益已计入本期已结算报酬；逐笔变动见下方明细。'}</p>
            </section>
            <section class="statement-high-water"><h3>高水位与报酬核对</h3>${r.ongoing ? '<p class="statement-valuation">本期尚未结算；以下为当前 LP 持仓各批次的高水位计提基准。</p>' : '<div class="statement-balance"><span>期初高水位 · LP 加权<strong>' + highWaterNav(r.openingHighWater) + '</strong></span><span class="statement-balance-arrow" aria-hidden="true">→</span><span>期末高水位 · LP 加权<strong>' + highWaterNav(r.closingHighWater) + '</strong></span></div><p class="statement-valuation">按所选周期边界的 LP 批次计算，不含 GP 报酬份额；无 LP 持仓时显示 —' + highWaterRange + '。</p>'}<div class="statement-table-scroll"><table><thead><tr><th>时点</th><th>批次</th><th>计提起算日 · 来源</th><th>剩余 LP 份额</th><th>高水位 NAV</th><th>高水位金额</th>${r.ongoing ? '<th>当前价值</th><th>计提门槛</th><th>潜在报酬</th>' : ''}</tr></thead><tbody>${r.ongoing ? highWaterLots('当前', r.closingHighWater, r.closingHighWaterLots) : highWaterLots('期初', r.openingHighWater, r.openingHighWaterLots) + highWaterLots('期末', r.closingHighWater, r.closingHighWaterLots)}</tbody></table></div><p class="statement-valuation">高水位金额 = 该批次剩余 LP 份额 × 高水位 NAV，并非原始入金额；结算重置后的日期为新的计提起算日。业绩报酬按各批次独立核算。</p>${r.ongoing ? '<p class="statement-valuation">估算截至 ' + r.end + '，采用本报表净值' + (r.potentialFee ? '；年化门槛 ' + rateLabel(r.potentialFee.annualRate) + '，报酬比例 ' + rateLabel(r.potentialFee.feeRate) : '') + '。合计按未舍入的批次报酬汇总后取两位小数。预估金额未从权益或本期收益中扣除，实际报酬以结算时的净值、日期和配置为准。</p>' : ''}</section>
            <section class="statement-reconciliation"><h3>权益变动</h3><div class="statement-balance"><span>期初权益<strong>${money(r.opening)}</strong></span><span class="statement-balance-arrow" aria-hidden="true">→</span><span>期末权益<strong>${money(r.closing)}</strong></span></div>
            <dl class="statement-movements">${movements.map(([name, value]) => `<div><dt>${name}</dt><dd class="${tone(value)}">${signed(value)}</dd></div>`).join('')}</dl></section>
            <section><h3>逐月回顾</h3><div class="statement-table-scroll"><table><thead><tr><th>月份</th><th>期末净值</th><th>净值涨跌幅</th><th>净流入</th><th>投资收益</th><th>报酬净额</th><th>期末权益</th></tr></thead><tbody>${r.months.map(item => `<tr><td>${item.month}</td><td>${item.closingNAV.toFixed(4)}</td><td class="${tone(item.navReturn)}">${percent(item.navReturn)}</td><td>${signed(item.deposits - item.withdrawals + item.transfersIn - item.transfersOut)}</td><td>${signed(item.investmentProfit)}</td><td>${signed(item.feesReceived - item.feesPaid)}</td><td>${money(item.closing)}</td></tr>`).join('')}</tbody></table></div></section>
            <section><h3>资金与报酬明细 <span class="statement-count">${r.rows.length} 笔</span></h3>${r.rows.length ? `<div class="statement-table-scroll"><table><thead><tr><th>日期</th><th>项目</th><th>金额</th><th>备注</th></tr></thead><tbody>${r.rows.map(row => `<tr><td>${row.date}</td><td>${escape(row.label)}</td><td class="${tone(row.amount)}">${signed(row.amount)}</td><td>${escape(row.remark) || '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="statement-empty">这个周期没有资金或报酬流水。</p>'}</section>
            <p class="statement-valuation">最近估值 ${r.closingValuation || '尚无（初始净值 1）'}${r.closingValuation !== r.end ? ' · 权益沿用最近已录入净值' : ''}${r.ongoing ? ' · 本期尚未结算' : ''}</p>
            <details class="statement-method"><summary>计算口径</summary>
              <p><strong>统计周期：</strong>以结算流水为边界，期初为上次结算后的权益。已结算报告的期末包含本次结算；结算至今统计到当前日期；首期从账本起始计算。同日流水按账本顺序划分，逐月回顾仅包含本期内流水。</p>
              <p><strong>权益计算：</strong>期末权益 = 期初权益 + 净流入 + 投资收益 − 支付报酬 + 收到报酬。成员入出金和已结算报酬通过份额变动计入权益。</p>
              <p><strong>净值表现：</strong>净值涨跌幅 = 期末单位净值 ÷ 期初单位净值 − 1，反映基金表现。期初估值：${r.openingValuation || '尚无（初始净值 1）'}。</p>
              <p><strong>高水位口径：</strong>逐批次列示计提起算日、来源、剩余份额、高水位 NAV 及金额。未结算报表展示当前持仓的计提基准；已结算报表展示期初、期末批次及 LP 份额加权高水位。实际业绩报酬按各批次独立核算，并结合持有期门槛。</p>
              <p><strong>报酬范围：</strong>仅含已结算份额变动，不含未结算预估报酬。</p>
              <p><strong>金额与更新：</strong>美元口径，金额按美分展示，尾差计入投资收益。历史账目修改或结算撤销后会重新计算。</p>
            </details><footer class="statement-signature"><div>GP 签字：<span></span></div><div>日期：<span></span></div></footer>`;
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
        document.title = `${report.name}-${report.start}-${report.end}-投资报表`;
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
          // A4 minus 15 mm margins. Zoom rounds individual text/table lines,
          // so reserve 7 mm rather than only the final box rounding.
          const pageWidth = 180 * 96 / 25.4;
          const pageHeight = 260 * 96 / 25.4;
          let scale = Math.min(1, pageWidth / measurement.scrollWidth,
            pageHeight / measurement.getBoundingClientRect().height);
          // Measure the zoomed clone as well: rounded line boxes do not scale
          // exactly in proportion to the original document height.
          for (let attempt = 0; attempt < 6; attempt++) {
            measurement.style.setProperty('zoom', String(scale), 'important');
            const renderedHeight = measurement.getBoundingClientRect().height;
            if (renderedHeight <= pageHeight) break;
            scale *= pageHeight / renderedHeight * 0.99;
          }
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
