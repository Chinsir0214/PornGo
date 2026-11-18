'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { inspectSiteLoginState, createRevisionGate, startStatusPolling, resolveObservedLogin } = require('../src/auth-status');

function control({ href = '', text = '', label = '', visible = true, rect, style,
  parent = null, hiddenAncestor = false, occluded = false }) {
  return {
    href, textContent: text, innerText: text, isConnected: true, childElementCount: 0,
    rect, style, parentElement: parent, occluded,
    getAttribute: () => label,
    getClientRects() { return visible ? [this.rect] : []; },
    getBoundingClientRect() { return this.rect; },
    contains(hit) { return hit === this; },
    matches: () => true,
    closest: () => hiddenAncestor ? {} : null,
  };
}

function inspect(controls) {
  controls.forEach((node, index) => {
    if (!node.rect) node.rect = {
      left: 10, top: 10 + index * 30, right: 110, bottom: 30 + index * 30,
      width: 100, height: 20,
    };
  });
  return vm.runInNewContext(`(${inspectSiteLoginState.toString()})()`, {
    window: { innerWidth: 400, innerHeight: 300 },
    document: {
      querySelectorAll: () => controls,
      elementFromPoint(x, y) {
        const found = controls.find((node) => x >= node.rect.left && x < node.rect.right
          && y >= node.rect.top && y < node.rect.bottom);
        return found && !found.occluded ? found : {};
      },
    },
    getComputedStyle: (node) => ({
      display: 'block', visibility: 'visible', opacity: '1',
      contentVisibility: 'visible', overflowX: 'visible', overflowY: 'visible',
      ...node.style,
    }),
  });
}

test('session polling registers a callback and cancels it when stopped', () => {
  const timer = { tick: null };
  let observations = 0;
  const stop = startStatusPolling(() => { observations++; }, {
    setInterval(callback) { timer.tick = callback; return timer; },
    clearInterval(activeTimer) { if (activeTimer === timer) timer.tick = null; },
  });
  timer.tick();
  stop();
  timer.tick?.();
  assert.equal(observations, 1);
});

test('only a complete, visible account menu confirms login', () => {
  const profile = (options) => control({ text: '查看您的个人资料', ...options });
  const logout = (options) => control({ text: '注销', ...options });
  const templateParent = profile();
  templateParent.matches = () => false;
  templateParent.childElementCount = 1;
  const hiddenProfileChild = profile();
  hiddenProfileChild.innerText = '';
  hiddenProfileChild.childElementCount = 1;
  const clip = control({ rect: { left: 0, top: 0, right: 50, bottom: 300, width: 50, height: 300 },
    style: { overflowX: 'hidden', overflowY: 'hidden' } });
  const menuRect = (left) => ({ left, top: 20, right: left + 100, bottom: 40, width: 100, height: 20 });
  for (const [description, controls] of [
    ['hidden template', [profile({ visible: false }), logout({ visible: false })]],
    ['conflicting sign-in control', [profile(), logout(), control({ text: '登录' })]],
    ['missing profile action', [logout()]],
    ['template text', [templateParent, logout()]],
    ['hidden child text', [hiddenProfileChild, logout()]],
    ['clipped action', [profile({ parent: clip, rect: menuRect(100) }), logout()]],
    ['offscreen action', [profile({ rect: menuRect(450) }), logout()]],
    ['transparent action', [profile({ style: { opacity: '0' } }), logout()]],
    ['hidden ancestor', [profile({ hiddenAncestor: true }), logout()]],
    ['occluded logout', [profile(), logout({ occluded: true })]],
  ]) {
    assert.equal(inspect(controls), 'unknown', description);
  }
  for (const label of ['注销', 'Log out']) {
    assert.equal(inspect([profile(), logout({ label })]), 'verified', label);
  }
});

test('closing after a confirmed menu retains a recent confirmation until sign-out', () => {
  const live = resolveObservedLogin('verified', false);
  assert.deepEqual(live, { loginState: 'verified', recentlyVerified: true });
  const afterClose = resolveObservedLogin('unknown', live.recentlyVerified);
  assert.deepEqual(afterClose, { loginState: 'recently_verified', recentlyVerified: true });
  const signedOut = resolveObservedLogin('signed_out', afterClose.recentlyVerified);
  assert.deepEqual(signedOut, { loginState: 'signed_out', recentlyVerified: false });
});

test('revision gate rejects a completed older check after a newer check or logout', async () => {
  const gate = createRevisionGate();
  const oldCheck = gate.begin();
  const newCheck = gate.begin();
  await Promise.resolve();
  assert.equal(gate.isCurrent(oldCheck), false);
  assert.equal(gate.isCurrent(newCheck), true);
  gate.begin(); // logout or login-window closure
  assert.equal(gate.isCurrent(newCheck), false);
});

function accountMenuHarness({ delayed = false, navigationHref = null, inForm = false,
  inHeader = true, anonymous = false } = {}) {
  let opened = false;
  let clicks = 0;
  let signedOut = anonymous;
  const header = control({ rect: { left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 } });
  const menu = control({ parent: header,
    rect: { left: 10, top: 60, right: 250, bottom: 160, width: 240, height: 100 } });
  menu.getClientRects = () => opened ? [menu.rect] : [];
  const trigger = control({ parent: header,
    rect: { left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 } });
  trigger.closest = (selector) => selector === 'form' ? inForm ? {} : null
    : selector.includes('header') ? inHeader ? header : null : null;
  trigger.getAttribute = (name) => name === 'href' ? navigationHref : null;
  trigger.click = () => { clicks++; if (!delayed) opened = true; };
  const profile = control({ text: '查看您的个人资料', parent: menu,
    rect: { left: 20, top: 70, right: 220, bottom: 90, width: 200, height: 20 } });
  const logout = control({ text: '注销', parent: menu,
    rect: { left: 20, top: 100, right: 220, bottom: 120, width: 200, height: 20 } });
  const login = control({ text: '登录', parent: menu, rect: logout.rect });
  header.querySelector = () => menu;
  const controls = () => [trigger, ...(signedOut ? [login] : [profile, logout])];
  const context = vm.createContext({
    window: { innerWidth: 400, innerHeight: 300 },
    document: {
      readyState: 'complete', querySelectorAll: controls, querySelector: () => trigger,
      elementFromPoint(x, y) {
        const found = controls().find((node) => (node === trigger || opened)
          && x >= node.rect.left && x < node.rect.right && y >= node.rect.top && y < node.rect.bottom);
        return found || (opened ? menu : {});
      },
    },
    getComputedStyle: (node) => ({ display: node === menu && !opened ? 'none' : 'block',
      visibility: 'visible', opacity: '1', contentVisibility: 'visible',
      overflowX: 'visible', overflowY: 'visible' }),
  });
  const run = () => vm.runInContext(`(${inspectSiteLoginState.toString()})({revealAccountMenu:true})`, context);
  return { run, clicks: () => clicks, reveal: () => { opened = true; },
    collapse: () => { opened = false; }, login: () => { signedOut = false; opened = false; } };
}

test('a collapsed account menu is revealed once and asynchronously verified on the next poll', () => {
  const menu = accountMenuHarness({ delayed: true });
  assert.equal(menu.run(), 'unknown');
  assert.equal(menu.clicks(), 1);
  assert.equal(menu.run(), 'unknown');
  assert.equal(menu.clicks(), 1, 'polling must not repeatedly toggle a pending menu');
  menu.reveal();
  assert.equal(menu.run(), 'verified');
  assert.equal(menu.clicks(), 1, 'an already open authenticated menu must stay open');
});

test('AJAX login can reuse an anonymously probed header node and then confirm its new menu', () => {
  const menu = accountMenuHarness({ anonymous: true });
  assert.equal(menu.run(), 'unknown');
  assert.equal(menu.run(), 'signed_out');
  menu.login();
  assert.equal(menu.run(), 'unknown');
  assert.equal(menu.run(), 'verified');
  assert.equal(menu.clicks(), 2);
});

test('account probing never clicks forms, navigation links, or controls outside the header', () => {
  for (const options of [{ inForm: true }, { navigationHref: '/login' }, { inHeader: false }]) {
    const menu = accountMenuHarness(options);
    assert.equal(menu.run(), 'unknown');
    assert.equal(menu.clicks(), 0);
  }
});
