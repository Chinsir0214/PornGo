'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderAuth(api) {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      value: '', textContent: '', hidden: false, disabled: false,
      dataset: {}, style: {}, handlers: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute() {}, removeAttribute() {}, replaceChildren() {},
    });
    return elements.get(key);
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8'), {
    window: { porngo: {
      getDirectory: async () => path.join(__dirname, '..', 'downtest'),
      onDownloadEvent() {},
      ...api,
    } },
    document: { getElementById: element, querySelector: element },
  });
  return element;
}

test('session status distinguishes verified login, saved data, and no session', async () => {
  let resolveInitial;
  let onStatus;
  let onClosed;
  const element = renderAuth({
    sessionStatus: () => new Promise((resolve) => { resolveInitial = resolve; }),
    onSessionStatusChanged: (callback) => { onStatus = callback; },
    onLoginClosed: (callback) => { onClosed = callback; },
  });
  onStatus({ cookieCount: 3, loginState: 'verified', revision: 3 });
  assert.equal(element('session-label').textContent, '网站已确认登录');
  assert.equal(element('session-summary').textContent, '已登录');
  assert.equal(element('session-pill').dataset.state, 'verified');

  resolveInitial({ cookieCount: 0, loginState: 'empty' });
  await new Promise(setImmediate);
  assert.equal(element('session-label').textContent, '网站已确认登录', 'stale initial status must not overwrite live status');

  onClosed({ cookieCount: 3, loginState: 'recently_verified', revision: 4 });
  assert.equal(element('session-label').textContent, '最近确认登录');
  assert.equal(element('session-summary').textContent, '最近确认登录');

  onStatus({ cookieCount: 3, loginState: 'unknown', revision: 2 });
  assert.equal(element('session-label').textContent, '最近确认登录', 'older event must not roll back recent confirmation');
  onStatus({ cookieCount: 3, loginState: 'unknown', revision: 5 });
  assert.equal(element('session-label').textContent, '内嵌会话已保存');
  assert.equal(element('session-summary').textContent, '会话已保存 · 登录状态待确认');
  assert.match(element('login-help').textContent, /应用会自动确认并关闭该窗口/);
  onStatus({ cookieCount: 0, loginState: 'empty', revision: 6 });
  assert.equal(element('session-label').textContent, '内嵌会话未保存');
  assert.equal(element('logout-button').hidden, true);
});

test('automatic login closure before the open IPC reply keeps the confirmed status and closed-window button', async () => {
  let resolveOpen;
  let closed;
  let windowChanged;
  const element = renderAuth({
    sessionStatus: async () => ({ cookieCount: 0, loginState: 'empty', revision: 0 }),
    openLogin: () => new Promise((resolve) => { resolveOpen = resolve; }),
    onLoginClosed: (callback) => { closed = callback; },
    onLoginWindowChanged: (callback) => { windowChanged = callback; },
  });
  await new Promise(setImmediate);
  const opening = element('login-button').handlers.click();
  windowChanged({ windowOpen: false, revision: 2 });
  closed({ cookieCount: 3, loginState: 'recently_verified', revision: 2 });
  resolveOpen({ windowOpen: true, revision: 1 });
  await opening;
  assert.equal(element('login-button').textContent, '内嵌网页登录');
  assert.equal(element('session-label').textContent, '最近确认登录');
  assert.equal(element('session-summary').textContent, '最近确认登录');
  assert.match(element('notice-message').textContent, /最近确认过登录/);
});
