const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
function checkFollowingPosition(followingY) {
  let reduced = false, mobile = false, closeCallback;
  const animated = [];
  const row = (kind, y) => {
    const classes = new Set(kind ? [kind] : []);
    return {
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, removeEventListener(name) { delete this.handlers[name]; },
      contains: target => target === null ? false : target === undefined ? false : target === kind,
      getBoundingClientRect() { const top = y + (y > 50 && detail.classList.contains('ledger-detail-open') ? 160 : 0); return { top, bottom: top + 40 }; },
      animate(frames, options) { const animation = { cancel() { this.cancelled = true; } }; animated.push({ frames, options, animation }); return animation; }
    };
  };
  const trigger = row('', 0), detail = row('ledger-row--settlement-detail', 40), following = row('', followingY);
  const offscreen = row('', 1200);
  detail.previousElementSibling = trigger;
  const tbody = { children: [trigger, detail, following, offscreen], classList: { add() {} } };
  const window = { innerHeight: 800, matchMedia: query => ({ matches: query === '(width < 480px)' ? mobile : reduced }) };
  vm.runInNewContext(fs.readFileSync('public/js/ledger-hover.js', 'utf8'), {
    window, Element: { prototype: { animate() {} } },
    setTimeout: callback => { closeCallback = callback; }, clearTimeout() {}
  });
  window.FundLedgerHover.bind(tbody);
  trigger.handlers.mouseenter();
  assert(detail.classList.contains('ledger-detail-open'));
  assert.equal(animated[0].frames[0].transform, 'translateY(-160px)');
  assert.equal(animated[0].frames[1].transform, 'translateY(0)');
  assert(animated.every(item => item.frames.every(frame => Object.keys(frame).join() === 'transform')), 'Table geometry must not be animated');
  detail.handlers.mouseenter();
  assert.equal(animated.length, 1, 'Moving into the open details must not restart animation');
  detail.handlers.mouseleave({ relatedTarget: null });
  assert(detail.classList.contains('ledger-detail-open'), 'Keep the detail open during the leave grace period');
  closeCallback();
  assert(!detail.classList.contains('ledger-detail-open'));
  assert.equal(animated[1].frames[0].transform, 'translateY(160px)');
  assert.equal(animated.length, 2, 'Rows outside the viewport both before and after must not animate');
  assert(animated[0].animation.cancelled);
  reduced = true;
  trigger.handlers.mouseenter();
  assert(detail.classList.contains('ledger-detail-open'));
  assert.equal(animated.length, 2, 'Reduced motion must skip row animations');
  window.FundLedgerHover.bind(tbody);
  assert(trigger.handlers.mouseenter, 'Re-render must replace the hover binding');
  closeCallback();
  mobile = true;
  trigger.handlers.mouseenter();
  assert(!detail.classList.contains('ledger-detail-open'), 'Small-screen details must be controlled by the card button, not hover');
}
checkFollowingPosition(80);
checkFollowingPosition(700); // Expanded: 860px, below viewport; collapsed: 700px, visible again.
console.log('Ledger hover geometry offsets, close delay, interruption and reduced-motion checks passed.');
