'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderWithApi(overrides) {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) {
      elements.set(key, {
        value: '', textContent: '', hidden: false, disabled: false,
        dataset: {}, style: {}, handlers: {}, open: false,
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, callback) { this.handlers[name] = callback; },
        setAttribute() {}, removeAttribute() {}, replaceChildren() {}, focus() {},
        showModal() { this.open = true; },
      });
    }
    return elements.get(key);
  }

  const api = {
    getDirectory: async () => path.join(__dirname, '..', 'downtest'),
    sessionStatus: async () => ({ cookieCount: 0 }),
    onDownloadEvent() {},
    onLoginClosed() {},
    ...overrides,
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  vm.runInNewContext(source, {
    window: { porngo: api },
    document: { getElementById: element, querySelector: element },
  });
  return element;
}

test('folder picker remains disabled during unrelated control updates and opens only once', async () => {
  let choose;
  let pickerCalls = 0;
  const selected = new Promise((resolve) => { choose = resolve; });
  const element = renderWithApi({
    selectDirectory: () => { pickerCalls++; return selected; },
  });
  await new Promise(setImmediate);

  const button = element('directory-button');
  assert.equal(button.disabled, false);
  const firstSelection = button.handlers.click();
  assert.equal(button.disabled, true);
  element('format-select').handlers.change();
  assert.equal(button.disabled, true);
  await button.handlers.click();
  assert.equal(pickerCalls, 1);

  const custom = path.join(__dirname, '..', 'downtest', 'custom');
  choose(custom);
  await firstSelection;
  assert.equal(button.disabled, false);
  assert.equal(element('directory-label').textContent, custom);
});

test('clearing a saved session requires the app dialog confirmation', async () => {
  let logoutCalls = 0;
  const element = renderWithApi({
    sessionStatus: async () => ({ cookieCount: 1 }),
    logout: async () => { logoutCalls++; return { cookieCount: 0 }; },
  });
  await new Promise(setImmediate);

  const logoutButton = element('logout-button');
  const dialog = element('clear-session-dialog');
  logoutButton.handlers.click();
  assert.equal(dialog.open, true);
  assert.equal(logoutCalls, 0);
  dialog.returnValue = 'cancel';
  dialog.handlers.close();
  assert.equal(logoutCalls, 0);

  logoutButton.handlers.click();
  dialog.returnValue = 'confirm';
  dialog.handlers.close();
  await new Promise(setImmediate);
  assert.equal(logoutCalls, 1);
  assert.equal(logoutButton.hidden, true);
});
