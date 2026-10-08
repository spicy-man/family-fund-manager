const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function setup({ failFirstLoad = false, privacyMode = true, positionTransfer = null, scrollY = 0, demoMode = undefined } = {}) {
  const nodes = {};
  let document;
  class Element {
    constructor(tag = 'div') {
      this.tag = tag; this.children = []; this.handlers = {}; this.attributes = {};
      this.dataset = {}; this.style = {}; this.hidden = false; this.value = '';
      this.offsetWidth = 260; this.offsetHeight = 160;
    }
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    before() {}
    replaceChildren(...children) { this.children = []; this.append(...children); }
    matches(selector) {
      if (selector === 'button' || selector === 'input') return this.tag === selector;
      if (selector === '[type="submit"]') return this.type === 'submit';
      if (selector === '[aria-current="true"]') return this.attributes['aria-current'] === 'true';
      return false;
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    focus() { document.activeElement = this; }
    select() {}
    getBoundingClientRect() { return { left: 20, top: 50, bottom: 90, width: 250 }; }
    async dispatch(type, values = {}) {
      const event = { target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
      for (const handler of this.handlers[type] || []) await handler(event);
      if (!event.stopped && this.parent) await this.parent.dispatch(type, event);
      return event;
    }
  }
  const node = (id, tag = 'div') => nodes[id] = new Element(tag);
  for (const id of ['ledger-switcher', 'ledger-menu', 'ledger-menu-list', 'ledger-switcher-status', 'ledger-current-name',
    'manage-ledgers-modal', 'new-ledger-status', 'manage-ledgers-status', 'manage-ledgers-list', 'new-ledger-form']) node(id);
  for (const id of ['ledger-select', 'btn-close-manage-ledgers', 'btn-save-ledger-settings', 'btn-manage-ledgers']) node(id, 'button');
  node('new-ledger-name', 'input');
  nodes['ledger-menu'].hidden = true;
  nodes['ledger-select'].disabled = true;
  nodes['ledger-menu'].append(nodes['ledger-menu-list'], nodes['btn-manage-ledgers']);
  nodes['manage-ledgers-modal'].append(nodes['manage-ledgers-list']);
  nodes['new-ledger-form'].append(nodes['new-ledger-name']);
  const addButton = new Element('button'); addButton.type = 'submit'; nodes['new-ledger-form'].append(addButton);
  const sidebar = new Element(), header = new Element(), exportLink = new Element('a');
  const section = node('members-section'); section.id = 'members-section';
  section.getBoundingClientRect = () => ({ top: -60 });
  const sectionLink = new Element('a'); sectionLink.hash = '#members-section';
  let ready;
  document = {
    body: { classList: { contains: () => privacyMode } },
    activeElement: null,
    createElement: tag => new Element(tag),
    getElementById: id => nodes[id],
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') ready = fn; },
    querySelector: selector => selector === '.sidebar-nav' ? sidebar : selector === '.app-header' ? header : selector === '#new-ledger-form [type="submit"]' ? addButton : null,
    querySelectorAll: selector => selector === 'a[href="/api/backup/export"]' ? [exportLink]
      : selector === '.sidebar-nav a[href^="#"]' ? [sectionLink] : []
  };
  let ledgers = [{ id: 'default', name: '账本1', isDefault: true }, { id: 'ledger-2', name: '账本2', isDefault: false }];
  let requests = 0, opened = false;
  const writes = [];
  const storage = new Map();
  if (positionTransfer) storage.set('family_fund_ledger_position_transfer', JSON.stringify(positionTransfer));
  const scrolls = [], frames = [];
  let destination;
  const context = {
    document, URL, URLSearchParams,
    requestApi: async () => {
      requests++;
      if (failFirstLoad && requests === 1) throw new Error('temporary failure');
      return { data: structuredClone(ledgers) };
    },
    jsonRequest: async (url, method, body) => {
      writes.push([url, method, body.name]);
      if (method === 'POST') ledgers.push({ id: 'ledger-3', name: body.name, isDefault: false });
      else ledgers.find(item => item.id === url.split('/').at(-1)).name = body.name.trim();
    },
    window: {
      FundDemoMode: demoMode,
      location: { search: '?ledger=ledger-2', href: 'http://localhost/?ledger=ledger-2', assign(url) { destination = url; } },
      sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key), removeItem: key => storage.delete(key) },
      scrollY, scrollTo: options => scrolls.push(options), requestAnimationFrame: callback => frames.push(callback),
      innerWidth: 1200, innerHeight: 800, addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      FundModal: {
        bindAccessible(modal) { modal.addEventListener('keydown', event => { if (event.key === 'Escape') opened = false; }); },
        open() { opened = true; }, close() { opened = false; }
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/ledger-switcher.js'), 'utf8'), context);
  await ready();
  return { nodes, writes, exportLink, storage, scrolls, frames, ledger: context.window.FundLedger,
    getDestination: () => destination, isOpen: () => opened, getRequests: () => requests };
}

(async () => {
  const sandbox = await setup({ demoMode: { enabled: true, sandbox: true } });
  assert.strictEqual(sandbox.nodes['ledger-switcher'].hidden, false);
  assert.strictEqual(sandbox.getRequests(), 1);
  await sandbox.nodes['btn-manage-ledgers'].dispatch('click');
  assert.strictEqual(sandbox.isOpen(), true);
  const readOnly = await setup({ demoMode: { enabled: true, sandbox: false } });
  assert.strictEqual(readOnly.nodes['ledger-switcher'].hidden, false);
  assert.strictEqual(readOnly.nodes['btn-manage-ledgers'].hidden, true);
  assert.strictEqual(readOnly.getRequests(), 1);
  const { nodes, writes, exportLink, isOpen } = await setup();
  assert.strictEqual(nodes['ledger-current-name'].textContent, '账本2');
  assert.strictEqual(exportLink.href, '/api/backup/export?ledger=ledger-2');
  await nodes['btn-manage-ledgers'].dispatch('click');
  const rows = nodes['manage-ledgers-list'].children;
  const fields = nodes['manage-ledgers-list'].querySelectorAll('input');
  await rows[0].querySelector('button').dispatch('click'); fields[0].value = '未保存的默认名称';
  await rows[1].querySelector('button').dispatch('click'); fields[1].value = '取消的名称';
  await fields[1].dispatch('keydown', { key: 'Escape' });
  assert(isOpen(), 'cancelling one name must not close the dialog and discard other drafts');
  assert.strictEqual(fields[0].value, '未保存的默认名称');
  assert.strictEqual(fields[1].value, '账本2');
  nodes['new-ledger-name'].value = '第三本';
  await nodes['new-ledger-form'].dispatch('submit');
  assert.strictEqual(nodes['manage-ledgers-list'].querySelectorAll('input')[0].value, '未保存的默认名称', 'adding a ledger must preserve existing rename drafts');
  await nodes['btn-save-ledger-settings'].dispatch('click');
  assert(!isOpen());
  assert.deepStrictEqual(writes, [['/api/ledgers', 'POST', '第三本'], ['/api/ledgers/default', 'PATCH', '未保存的默认名称']]);
  const retry = await setup({ failFirstLoad: true });
  assert.strictEqual(retry.nodes['ledger-select'].disabled, false, 'a failed initial request must leave a retry available');
  await retry.nodes['ledger-select'].dispatch('click');
  assert.strictEqual(retry.getRequests(), 2);
  assert.strictEqual(retry.nodes['ledger-menu'].hidden, false);
  assert.strictEqual(retry.nodes['ledger-switcher-status'].textContent, '');
  for (const privacyMode of [true, false]) {
    const navigation = await setup({ privacyMode, scrollY: 900 });
    await navigation.nodes['ledger-menu-list'].children[1].dispatch('click');
    assert.strictEqual(navigation.storage.size, 0, 'selecting current ledger must not create a transfer');
    await navigation.nodes['ledger-menu-list'].children[0].dispatch('click');
    assert.strictEqual(navigation.getDestination(), 'http://localhost/');
    assert.deepStrictEqual(JSON.parse(navigation.storage.get('family_fund_ledger_privacy_transfer')), {
      ledgerId: 'default', privacyMode
    });
    assert.deepStrictEqual(JSON.parse(navigation.storage.get('family_fund_ledger_position_transfer')), {
      ledgerId: 'default', top: 900, sectionId: 'members-section', offset: -60
    });
  }
  const transfer = { ledgerId: 'ledger-2', top: 900, sectionId: 'members-section', offset: -60 };
  const restored = await setup({ positionTransfer: transfer });
  assert.strictEqual(restored.storage.size, 0, 'position transfer must be consumed on arrival');
  assert.strictEqual(restored.scrolls.length, 0, 'wait for destination content to render');
  restored.nodes['members-section'].getBoundingClientRect = () => ({ top: 1200 });
  restored.ledger.restorePosition();
  restored.frames.shift()();
  assert.strictEqual(restored.scrolls[0].top, 1260, 'preserve section offset when the destination layout changes');
  assert.strictEqual(restored.scrolls[0].behavior, 'instant');
  restored.ledger.restorePosition();
  assert.strictEqual(restored.frames.length, 0, 'later data refreshes must not reset scrolling');
  for (const saved of [{ ...transfer, ledgerId: 'default' }, { ...transfer, top: -1 }]) {
    const ignored = await setup({ positionTransfer: saved });
    ignored.ledger.restorePosition();
    assert.strictEqual(ignored.frames.length, 0, 'ignore invalid or unrelated transfers');
  }
  const fallback = await setup({ positionTransfer: { ...transfer, sectionId: 'missing-section' } });
  fallback.ledger.restorePosition(); fallback.frames.shift()();
  assert.strictEqual(fallback.scrolls[0].top, 900, 'fall back to scroll position when a section is absent');
  console.log('Ledger management draft preservation, Escape isolation, export selection and initial-load retry passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
