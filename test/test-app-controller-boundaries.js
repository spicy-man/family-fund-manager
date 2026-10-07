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
  let pendingWrite;
  nodes['member-modal'] = { querySelectorAll: () => Object.values(nodes).filter(node => node.style) };
  const controller = load('member-editor-controller.js', {
    getElementById: id => nodes[id] ||= element()
  }, { confirm: () => true }).FundMemberEditor.create({
    elements: { gpSetupWarning: warning, elMembersEditList: list },
    getMembers: () => members, getState: () => ({ events: [] }), checkIfDark: () => false,
    ui: { escapeHtml, getAvatarText: name => name, getMemberAvatarColor: () => ({ background: 'red', color: 'white' }) },
    showToast: (...args) => notices.push(args), loadAllData: async () => {},
    api: {
      async updateMember(id, name) { if (pendingWrite) await pendingWrite; if (fail) throw new Error('rename failed'); requests.push(['rename', id, name]); members[0].name = name; },
      async updateMembers(changes) { if (pendingWrite) await pendingWrite; if (fail) throw new Error('rename failed'); for (const change of changes) members.find(m => m.id === change.id).name = change.name; },
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
  await nodes['btn-rename-edit-lp'].handlers.click();
  input.value = 'Footer rename';
  assert.strictEqual(await controller.savePendingNames(), true);
  assert.strictEqual(members[0].name, 'Footer rename', 'footer save must persist the active name edit');
  await nodes['btn-rename-edit-lp'].handlers.click(); input.value = 'Retry draft'; fail = true;
  assert.strictEqual(await controller.savePendingNames(), false);
  assert.strictEqual(input.value, 'Retry draft', 'failed saves must retain the edited name');
  assert.strictEqual(members[0].name, 'Footer rename');
  fail = false; input.value = ' ';
  assert.strictEqual(await controller.savePendingNames(), false);
  assert.strictEqual(notices.at(-1)[0], '成员姓名不能为空');
  input.value = 'Retry draft'; assert.strictEqual(await controller.savePendingNames(), true);
  nodes['btn-rename-edit-lp'].handlers.click(); input.value = 'Pending save';
  let finish;
  pendingWrite = new Promise(resolve => { finish = resolve; });
  const saving = controller.savePendingNames();
  assert.strictEqual(input.disabled, true, 'name inputs must be frozen while the footer saves');
  assert.strictEqual(nodes['btn-member-del-lp'].disabled, true, 'other member mutations must be frozen');
  const requestsBefore = requests.length;
  await nodes['member-primary-gp-lp'].handlers.change();
  assert.strictEqual(requests.length, requestsBefore, 'a competing role write must not run during name saving');
  assert.strictEqual(await controller.savePendingNames(), false, 'duplicate footer saves must be ignored');
  finish(); await saving; pendingWrite = undefined;
  assert.strictEqual(members[0].name, 'Pending save');
  assert(!input.disabled, 'the editor must unlock after saving');
  await nodes['member-primary-gp-lp'].handlers.change();
  assert.strictEqual(warning.hidden, true);
  fail = true; await nodes['member-primary-gp-lp'].handlers.change();
  assert.strictEqual(notices.at(-1)[0], 'roles failed');
  assert.strictEqual(warning.hidden, true);
  fail = false;
  members.push({ id: 'lp2', name: 'Second', primaryGp: false });
  controller.render();
  nodes['btn-rename-edit-lp2'].handlers.click();
  nodes['member-name-input-lp2'].value = 'Second draft';
  nodes['member-id-save-lp2'].handlers.click();
  nodes['member-id-input-lp2'].value = '987654';
  await nodes['member-primary-gp-lp'].handlers.change();
  assert.strictEqual(nodes['member-name-input-lp2'].value, 'Second draft');
  assert.strictEqual(nodes['member-id-input-lp2'].value, '987654');
  nodes['btn-rename-edit-lp'].handlers.click(); input.value = 'First confirmed';
  await nodes['btn-rename-save-lp'].handlers.click();
  assert.strictEqual(nodes['member-name-input-lp2'].value, 'Second draft');
  assert.strictEqual(nodes['member-id-input-lp2'].value, '987654');
  await nodes['btn-member-del-lp'].handlers.click();
  assert(list.innerHTML.includes('当前家庭无成员数据'));
}
async function memberRefreshFailureTest() {
  let members = [{ id: '123456', name: 'A' }, { id: '234567', name: 'B' }];
  const nodes = {}, list = {}, requests = [];
  const controller = load('member-editor-controller.js', {
    getElementById: id => nodes[id] ||= element()
  }).FundMemberEditor.create({
    elements: { elMembersEditList: list }, getMembers: () => members,
    setMembers: value => { members = value; }, getState: () => ({ events: [] }),
    checkIfDark: () => false, showToast: () => {}, loadAllData: async () => { throw new Error('refresh failed'); },
    ui: { escapeHtml, getAvatarText: name => name, getMemberAvatarColor: () => ({}) },
    api: { async updateMembers(changes) {
      requests.push(changes);
      return { data: members.map(member => {
        const change = changes.find(item => item.id === member.id);
        return change ? { ...member, id: change.memberId, name: change.name } : member;
      }) };
    }, async updateMember() {}, async updateMemberRoles() {} }
  });
  controller.render(); nodes['member-id-save-123456'].handlers.click();
  nodes['member-id-input-123456'].value = '345678';
  assert.strictEqual(await controller.savePendingNames(), true);
  assert.strictEqual(members[0].id, '345678', 'confirmed IDs must survive refresh failure');
  nodes['btn-rename-edit-345678'].handlers.click();
  nodes['member-name-input-345678'].value = 'A2';
  await controller.savePendingNames();
  assert.strictEqual(requests[1][0].id, '345678', 'next edit must address the confirmed ID');
  nodes['member-id-save-345678'].handlers.click(); nodes['member-id-input-345678'].value = '234567';
  nodes['member-id-save-234567'].handlers.click(); nodes['member-id-input-234567'].value = '345678';
  assert.strictEqual(await controller.savePendingNames(), true, 'successful commits must survive refresh exceptions');
  const count = requests.length;
  assert.strictEqual(await controller.savePendingNames(), true);
  assert.strictEqual(requests.length, count, 'retry after refresh failure must not reverse a confirmed ID swap');
  assert.strictEqual(members[0].id, '234567');
  assert.strictEqual(members[1].id, '345678');
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
function memberOrderTest() {
  const { compareEvents } = require('../lib/event-order');
  const renderer = load('member-renderer.js', {}).FundMemberRenderer;
  const members = ['empty', 'late', 'recipient', 'first', 'gp', 'empty2'].map(id => ({ id, name: id }));
  const events = [
    { date: '2026-10-02', sequenceNumber: 1, member: 'late' },
    { date: '2026-10-01', sequenceNumber: 3, fromMember: 'first', toMember: 'recipient', performanceFee: { gpMember: 'gp' } },
    { date: '2026-10-01', sequenceNumber: 2, member: 'first' }
  ].sort(compareEvents);
  const snapshot = JSON.stringify({ members, events });
  const ids = result => Array.from(result, member => member.id);
  assert.deepStrictEqual(ids(renderer.sortByFirstRecord(members, events)),
    ['first', 'recipient', 'gp', 'late', 'empty', 'empty2'],
    'first ledger record determines member order, including transfer recipients and GP fees');
  assert.strictEqual(JSON.stringify({ members, events }), snapshot, 'display sorting must not modify ledger data');
  assert.deepStrictEqual(ids(renderer.sortByFirstRecord(members)), ids(members),
    'members without records keep their original order');
}
(async () => {
  await membersTest(); await memberRefreshFailureTest(); editTest(); notificationsTest(); memberOrderTest();
  console.log('Member editor, ledger edit and notification boundary regressions passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
