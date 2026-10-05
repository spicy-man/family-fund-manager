(function () {
  function init({ api, formatMoney }) {
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
      const result = get('trial-result');
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
        partial.disabled = false;
        full.disabled = false;
        if (prefix === 'tx') panel.hidden = !document.getElementById('t-select-withdraw').checked;
      }
      function render(data) {
        result.classList.remove('disposal-trial-error');
        const item = (label, value) => `<article><span>${label}</span><strong class="privacy-sensitive">${escape(value)}</strong></article>`;
        const cards = [
          item(prefix === 'tx' ? '预计到手金额' : '受让方获得金额', money(data.actualAmount)),
          item('应计业绩报酬', money(data.performanceFee)),
          item('出让方净扣减份额', shares(data.sharesDeducted)),
          item('操作前权益', money(data.sender.before.currentValue)),
          item('操作后剩余权益', money(data.sender.after.currentValue)),
          item('操作后剩余份额', shares(data.sender.after.lpShares + data.sender.after.gpCarryShares)),
          item('操作后剩余本金', money(data.sender.after.remainingPrincipal)),
          item('对应人民币金额', '¥' + formatMoney(data.cnhAmount))
        ];
        if (data.recipient) {
          cards.push(item('受让方操作后权益', money(data.recipient.after.currentValue)));
          cards.push(item('受让方操作后本金', money(data.recipient.after.remainingPrincipal)));
        }
        result.innerHTML = `<p>${data.fullExit ? '全部退出' : '部分处置'} · 操作日期 ${escape(data.date)}<br>采用估值：${escape(data.valuationDate || '初始净值（尚无估值记录）')} · 单位净值 ${escape(shares(data.nav))}</p><div class="disposal-trial-grid">${cards.join('')}</div><p>以上为操作当时的权益，沿用上述估值，不预测行情。报酬以份额结晶；GP 本人的净扣减已计入报酬回流。${data.fullExit ? '全部退出带入表单的是扣费前权益及对应人民币，实际金额以上述试算为准。' : ''}试算未保存账目，提交前请核对日期及人民币金额。</p>`;
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
        apply.hidden = true;
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
