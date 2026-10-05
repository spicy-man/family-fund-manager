const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
function element() {
  return { value: '', style: {}, dataset: {}, handlers: {}, attributes: {},
    addEventListener(name, fn) { this.handlers[name] = fn; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; delete this[name]; },
    setCustomValidity(value) { this.validity = value; }, focus() {}, select() {},
    remove() { this.removed = true; } };
}
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function load(file, document, globals = {}) {
  const context = { window: {}, document, ...globals };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
  return context.window;
}
async function membersTest() {
  let members = [{ id: 'lp', name: '<LP>', primaryGp: false }];
  const nodes = {}, list = {}, warning = {}, requests = [], notices = [];
  let fail = false;
  const controller = load('member-editor-controller.js', {
    getElementById: id => nodes[id] ||= element()
  }, { confirm: () => true }).FundMemberEditor.create({
    elements: { gpSetupWarning: warning, elMembersEditList: list },
    getMembers: () => members, getState: () => ({ events: [] }), checkIfDark: () => false,
    ui: { escapeHtml, getAvatarText: name => name, getMemberAvatarColor: () => ({ background: 'red', color: 'white' }) },
    showToast: (...args) => notices.push(args), loadAllData: async () => {},
    api: {
      async updateMember(id, name) { if (fail) throw new Error('rename failed'); requests.push(['rename', id, name]); members[0].name = name; },
      async updateMemberRoles(id, roles) { if (fail) throw new Error('roles failed'); requests.push(['roles', id, roles.primaryGp]); members[0].primaryGp = true; },
      async deleteMember(id) { requests.push(['delete', id]); members = []; }
    }
  });
  controller.render();
  assert(list.innerHTML.includes('&lt;LP>'));
  assert.strictEqual(warning.hidden, false);
  const input = nodes['member-name-input-lp'];
  nodes['btn-rename-edit-lp'].handlers.click();
  assert.strictEqual(input.style.display, 'block');
  input.value = 'changed'; input.handlers.keyup({ key: 'Escape' });
  assert.strictEqual(input.value, '<LP>');
  input.value = ' '; await nodes['btn-rename-save-lp'].handlers.click();
  assert.strictEqual(requests.length, 0);
  fail = true; input.value = 'New'; await nodes['btn-rename-save-lp'].handlers.click();
  assert.strictEqual(members[0].name, '<LP>');
  assert.strictEqual(notices.at(-1)[0], 'rename failed');
  fail = false; await nodes['btn-rename-save-lp'].handlers.click();
  assert.deepStrictEqual(requests[0], ['rename', 'lp', 'New']);
  await nodes['member-primary-gp-lp'].handlers.change();
  assert.strictEqual(warning.hidden, true);
  fail = true; await nodes['member-primary-gp-lp'].handlers.change();
  assert.strictEqual(notices.at(-1)[0], 'roles failed');
  assert.strictEqual(warning.hidden, true);
  await nodes['btn-member-del-lp'].handlers.click();
  assert(list.innerHTML.includes('当前家庭无成员数据'));
}
function editTest() {
  const elements = Object.fromEntries(['ledgerTbody', 'editEventId', 'editEventType', 'editDate', 'editRemark',
    'editMember', 'editAmount', 'editCnhAmount', 'editFromMember', 'editToMember', 'editCnhRate', 'editEventModal'].map(name => [name, element()]));
  const groups = {}, calls = [];
  const control = load('ledger-actions-controller.js', { getElementById: id => groups[id] ||= element() }).FundLedgerActions.create({
    elements, getState: () => ({ summary: { cnhRate: 7.8 } }), notifications: {},
    getLatestValuationDate: () => '2026-10-02', prepareEdit: event => calls.push(['prepare', event.id]),
    customSelect: { refresh: modal => { assert.strictEqual(modal, elements.editEventModal); calls.push(['refresh']); } },
    modal: { open: modal => { assert.strictEqual(modal, elements.editEventModal); calls.push(['open']); } }
  });
  control.edit({ id: 'v', type: 'valuation', date: '2026-10-02', totalNAV: 120 });
  assert.strictEqual(elements.editDate.max, '2026-10-02');
  assert.strictEqual(elements.editAmount.value, 120);
  control.edit({ id: 'w', type: 'withdraw', date: '2026-09-27', member: 'lp', amount: 90, cnhAmount: 630, fullExit: true, requestedGrossAmount: 100 });
  assert.strictEqual(elements.editDate.max, undefined);
  assert.strictEqual(elements.editAmount.value, 100);
  assert.strictEqual(elements.editCnhAmount.value, '700.00');
  control.edit({ id: 't', type: 'transfer', date: '2026-09-27', fromMember: 'lp', toMember: 'other', amount: 100, cnhAmount: 650 });
  assert.strictEqual(elements.editCnhRate.value, 6.5);
  assert.strictEqual(groups['edit-group-member'].style.display, 'none');
  assert.strictEqual(groups['edit-group-transfer-members'].style.display, 'flex');
  assert.deepStrictEqual(calls.slice(-3), [['prepare', 't'], ['refresh'], ['open']]);
}
function notificationsTest() {
  const nodes = [], timers = [];
  const notifications = load('notifications.js', {
    getElementById: () => ({ appendChild: node => nodes.push(node) }), createElement: element
  }, { setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {} }).FundNotifications.create({ escapeHtml });
  notifications.showToast('<error>', 'error');
  assert.strictEqual(nodes[0].textContent, '<error>');
  assert.strictEqual(nodes[0].attributes.role, 'alert');
  notifications.showSubmissionSuccess('<saved>');
  assert(nodes[1].innerHTML.includes('&lt;saved>'));
  nodes[0].handlers.click(); nodes[0].handlers.click();
  assert.strictEqual(timers.filter(timer => timer.delay === 280).length, 1);
  timers.at(-1).fn(); assert.strictEqual(nodes[0].removed, true);
}
(async () => {
  await membersTest(); editTest(); notificationsTest();
  console.log('Member editor, ledger edit and notification boundary regressions passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
