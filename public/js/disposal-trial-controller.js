(function () {
  function init({ api, formatMoney, modal = window.FundModal }) {
    if (window.FundDemoMode?.enabled && !window.FundDemoMode.sandbox) {
      return { invalidate() {}, token() { return undefined; } };
    }
    const trials = [];
    const money = value => '$' + formatMoney(value);
    const shares = value => Number(value).toFixed(6);
    const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    for (const prefix of ['tx', 'tf']) {
      const get = suffix => document.getElementById(prefix + '-' + suffix);
      const form = document.getElementById(prefix === 'tx' ? 'form-transaction' : 'form-transfer');
      const panel = get('trial');
      const dialog = get('trial-modal');
      const result = get('trial-result');
      const view = get('trial-view');
      modal.bindAccessible(dialog, get('trial-close'));
      get('trial-cancel').addEventListener('click', () => modal.close(dialog));
      view.addEventListener('click', () => modal.open(dialog, view));
      const apply = get('trial-apply');
      const partial = get('trial-partial');
      const full = get('trial-full');
      let generation = 0;
      let preview = null;
      let appliedSignature = null;
      function payload() {
        const base = { type: prefix === 'tx' ? 'withdraw' : 'transfer', date: get('date').value, amount: Number(get('amount').value) };
        if (prefix === 'tx') {
          base.member = get('member').value;
          base.cnhAmount = get('cnh-amount').value === '' ? undefined : Number(get('cnh-amount').value);
        } else {
          base.fromMember = get('from-member').value;
          base.toMember = get('to-member').value;
          base.cnhRate = Number(get('rate').value);
        }
        return base;
      }
      function invalidate() {
        generation++;
        preview = null;
        appliedSignature = null;
        result.hidden = true;
        apply.hidden = true;
        view.hidden = true;
        modal.close(dialog);
        partial.disabled = false;
        full.disabled = false;
        if (prefix === 'tx') panel.hidden = !document.getElementById('t-select-withdraw').checked;
      }
      function render(data) {
        result.classList.remove('disposal-trial-error');
        const value = text => `<span class="privacy-sensitive">${escape(text)}</span>`;
        const accountShares = account => shares(account.lpShares + account.gpCarryShares);
        const row = (label, before, after) => `<tr><th scope="row">${label}</th><td>${value(before)}</td><td>${value(after)}</td></tr>`;
        const balance = (name, account) => `<section class="trial-balance"><h4>${escape(name)}</h4><table aria-label="${escape(name)}操作前后对比"><thead><tr><th scope="col">账户变化</th><th scope="col">操作前</th><th scope="col">操作后</th></tr></thead><tbody>${row('权益', money(account.before.currentValue), money(account.after.currentValue))}${row('本金', money(account.before.remainingPrincipal), money(account.after.remainingPrincipal))}${row('份额', accountShares(account.before), accountShares(account.after))}</tbody></table></section>`;
        result.innerHTML = `<div class="trial-context">${escape(data.sender.before.name || '出让方')}${data.recipient ? ' → ' + escape(data.recipient.after.name || '受让方') : ''} · ${data.fullExit ? (prefix === 'tx' ? '全部退出' : '全部转让') : (prefix === 'tx' ? '部分出金' : '部分转让')} · ${escape(data.date)}</div>
          <section class="trial-hero"><span class="trial-hero-label">${prefix === 'tx' ? '预计到手' : '受让方获得'}</span><strong class="trial-hero-amount privacy-sensitive">${escape(money(data.actualAmount))}</strong><div class="trial-money-details"><div><span>业绩报酬</span><strong class="privacy-sensitive">${escape(money(data.performanceFee))}</strong></div><div><span>对应人民币</span><strong class="privacy-sensitive">¥${escape(formatMoney(data.cnhAmount))}</strong></div></div></section>
          ${balance(data.recipient ? '出让方账户' : '账户变化', data.sender)}
          ${data.recipient ? balance('受让方账户', data.recipient) : ''}
          <p class="trial-valuation">基于 <strong>${escape(data.valuationDate || '初始净值')}</strong> 的估值 · 单位净值 <strong class="privacy-sensitive">${escape(shares(data.nav))}</strong><br>仅作试算，尚未保存账目。</p>
          <details class="trial-notes"><summary>计算口径与金额说明</summary><p>所选日期没有新估值时沿用此前估值，不预测行情。净扣减 ${value(shares(data.sharesDeducted))} 份，已计入业绩报酬结晶及 GP 自身的报酬回流。${data.fullExit ? '全部退出带入表单的是扣费前权益及对应人民币，实际金额以上述试算为准。' : '部分处置金额表示希望到手或受让方获得的金额。'}正式提交前请核对日期和人民币金额。</p></details>`;
        result.hidden = false;
        apply.hidden = false;
      }
      async function calculate(fullExit) {
        invalidate();
        const requestGeneration = generation;
        const data = payload();
        const fields = prefix === 'tx' ? ['member', 'date'] : ['from-member', 'to-member', 'rate', 'date'];
        if (!fullExit) fields.push('amount');
        for (const field of fields) if (!get(field).reportValidity()) return;
        partial.disabled = true;
        full.disabled = true;
        result.textContent = '正在试算…';
        result.hidden = false;
        result.classList.remove('disposal-trial-error');
        modal.open(dialog, fullExit ? full : partial);
        try {
          const response = await api.previewDisposal({ ...data, fullExit });
          if (generation !== requestGeneration) return;
          preview = response;
          render(response);
        } catch (error) {
          if (generation !== requestGeneration) return;
          result.textContent = error.message;
          result.classList.add('disposal-trial-error');
          result.hidden = false;
        } finally {
          if (generation === requestGeneration) { partial.disabled = false; full.disabled = false; }
        }
      }
      partial.addEventListener('click', () => calculate(false));
      full.addEventListener('click', () => calculate(true));
      apply.addEventListener('click', () => {
        if (!preview) return;
        const data = preview;
        // Retain the gross request for an all-exit operation. The service turns
        // it into the same net cash amount shown above on formal submission.
        get('amount').value = data.input.amount;
        get('amount').dispatchEvent(new Event('input', { bubbles: true }));
        if (prefix === 'tx') get('cnh-amount').value = Number(data.input.cnhAmount).toFixed(2);
        preview = data;
        appliedSignature = JSON.stringify(payload());
        render(data);
        view.textContent = '✓ 已带入试算金额 · ' + money(data.actualAmount) + ' · 查看';
        view.hidden = false;
        modal.close(dialog);
      });
      form.addEventListener('input', invalidate);
      form.addEventListener('change', invalidate);
      form.addEventListener('reset', invalidate);
      invalidate();
      trials.push({ prefix, invalidate, token() {
        return preview && appliedSignature === JSON.stringify(payload()) ? preview.input.previewToken : undefined;
      } });
    }
    return {
      invalidate: () => trials.forEach(trial => trial.invalidate()),
      token: prefix => trials.find(trial => trial.prefix === prefix).token()
    };
  }
  window.FundDisposalTrial = { init };
})();
