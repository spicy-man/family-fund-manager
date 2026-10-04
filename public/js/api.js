/**
 * Frontend API client with consistent HTTP, timeout, and JSON error handling.
 */
const API_TIMEOUT_MS = 15000;
const API_PREFIX = window.FundDemoMode?.enabled ? '/api/demo' : '/api';

function resolveApiUrl(url) {
  if (window.FundDemoMode?.staticDemo) {
    const request = new URL(url, window.location.href);
    const files = {
      '/api/state': 'state.json',
      '/api/members': 'members.json',
      '/api/ticker-ath': 'ticker-ath.json',
      '/api/settings/tickers': 'tickers.json',
      '/api/settings/custom-benchmark': request.searchParams.get('slot') === '1'
        ? 'custom-benchmark-1.json' : 'custom-benchmark-0.json'
    };
    const file = files[request.pathname];
    if (!file) throw new Error('演示模式为只读，此操作不可用。');
    return new URL('demo-data/' + file, window.location.href).href;
  }
  return url.startsWith('/api/') ? `${API_PREFIX}${url.slice(4)}` : url;
}

async function requestApi(url, options = {}) {
  if (window.FundDemoMode?.sandbox) return window.FundDemoSandbox.request(url, options);
  if (window.FundDemoMode?.staticDemo && (options.method || 'GET').toUpperCase() !== 'GET') {
    throw new Error('演示模式为只读，此操作不可用。');
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await fetch(resolveApiUrl(url), { ...options, signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
      throw new Error('网络连接失败，请检查服务是否可用');
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(response.ok ? '服务返回了无法识别的数据' : `请求失败（HTTP ${response.status}）`);
    }

    if (!response.ok) throw new Error(payload?.message || `请求失败（HTTP ${response.status}）`);
    if (!payload?.success) throw new Error(payload?.message || '请求处理失败');
    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

const jsonRequest = (url, method, body) => requestApi(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const Api = {
  async getState() { return (await requestApi('/api/state')).data; },
  async addTransaction(data) { return jsonRequest('/api/transaction', 'POST', data); },
  async updateValuation(data) { return jsonRequest('/api/valuation', 'POST', data); },
  async deleteEvent(id) { return requestApi(`/api/event/${id}`, { method: 'DELETE' }); },
  async updateEvent(id, data) { return jsonRequest(`/api/event/${id}`, 'PUT', data); },
  async updateSettings(data) { return jsonRequest('/api/settings', 'POST', data); },
  async importBackup(file) {
    return requestApi('/api/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file
    });
  },
  async getMembers() { return (await requestApi('/api/members')).data; },
  async addMember(name) { return (await jsonRequest('/api/members', 'POST', { name })).data; },
  async updateMember(id, name) { return jsonRequest(`/api/members/${id}`, 'PUT', { name }); },
  async updateMemberRoles(id, roles) { return jsonRequest(`/api/members/${id}/roles`, 'PUT', roles); },
  async deleteMember(id) { return (await requestApi(`/api/members/${id}`, { method: 'DELETE' })).data; },
  async syncCnhRate() { return (await requestApi('/api/settings/sync-rate', { method: 'POST' })).cnhRate; },
  async addTransfer(data) { return jsonRequest('/api/transfer', 'POST', data); },
  async previewSettlement(data) { return (await jsonRequest('/api/performance-settlement/preview', 'POST', data)).data; },
  async confirmSettlement(data) { return jsonRequest('/api/performance-settlement', 'POST', data); },
  async reverseLatestSettlement(settlementId, remark) { return jsonRequest('/api/performance-settlement/reverse-latest', 'POST', { settlementId, remark }); },
  async getTickerAth() {
    return requestApi('/api/ticker-ath', { cache: 'no-store' });
  },
  async refreshTickerAth() {
    return requestApi('/api/ticker-ath/refresh', { method: 'POST', cache: 'no-store' });
  },
  async getTickers() { return (await requestApi('/api/settings/tickers')).data; },
  async saveTickers(tickers) { return jsonRequest('/api/settings/tickers', 'POST', { tickers }); },
  async getCustomBenchmark(slot = 0) {
    return (await requestApi(`/api/settings/custom-benchmark?slot=${slot}`)).data;
  },
  async saveCustomBenchmark(customBenchmark, slot = 0) {
    return jsonRequest('/api/settings/custom-benchmark', 'POST', { customBenchmark, slot });
  }
};
