'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = () => new Promise(setImmediate);

function rendererFixture(overrides = {}) {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      value: '', textContent: '', hidden: false, disabled: false,
      dataset: {}, style: {}, handlers: {}, returnValue: '', modal: false,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute() {}, removeAttribute() {}, replaceChildren() {}, focus() {},
      showModal() { this.modal = true; },
    });
    return elements.get(key);
  }
  let changed;
  let windowChanged;
  const calls = [];
  const status = { available: true, saved: false };
  const api = {
    getDirectory: async () => path.join(__dirname, '..', 'downtest'),
    sessionStatus: async () => ({ cookieCount: 0, loginState: 'empty' }),
    onDownloadEvent() {}, onLoginClosed() {}, openLogin: async () => ({ windowOpen: true, revision: 1 }),
    onLoginWindowChanged(callback) { windowChanged = callback; },
    credentialsStatus: async () => status,
    onCredentialsChanged(callback) { changed = callback; },
    saveCredentials: async (...args) => {
      calls.push(['save', args]);
      changed({ available: true, saved: true });
    },
    fillCredentials: async (...args) => { calls.push(['fill', args]); return { filled: true }; },
    deleteCredentials: async (...args) => {
      calls.push(['delete', args]);
      changed({ available: true, saved: false });
    },
    ...overrides,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8'), {
    window: { porngo: api }, document: { getElementById: element, querySelector: element },
  });
  return { element, calls, changed: (payload) => changed(payload), windowChanged: (payload) => windowChanged(payload) };
}

test('credentials require explicit save, permit manual fill, and delete only after confirmation', async () => {
  const fixture = rendererFixture();
  const { element, calls } = fixture;
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(element('credentials-save').disabled, true, 'closed login window cannot save');
  await element('login-button').handlers.click();
  assert.equal(element('credentials-save').disabled, false);
  await element('credentials-save').handlers.click();
  assert.equal(element('credentials-save').textContent, '更新网页登录账号密码');
  assert.equal(element('credentials-fill').hidden, false);
  await element('credentials-fill').handlers.click();
  element('credentials-delete').handlers.click();
  assert.equal(element('delete-credentials-dialog').modal, true);
  element('delete-credentials-dialog').returnValue = 'cancel';
  element('delete-credentials-dialog').handlers.close();
  assert.equal(calls.filter(([name]) => name === 'delete').length, 0);
  element('delete-credentials-dialog').returnValue = 'confirm';
  element('credentials-delete').handlers.click();
  assert.equal(element('delete-credentials-dialog').returnValue, '');
  element('delete-credentials-dialog').handlers.close();
  assert.equal(calls.filter(([name]) => name === 'delete').length, 0);
  element('credentials-delete').handlers.click();
  element('delete-credentials-dialog').returnValue = 'confirm';
  element('delete-credentials-dialog').handlers.close();
  await flush();
  assert.deepEqual(calls, [['save', []], ['fill', []], ['delete', []]], 'renderer never sends password fields');
  assert.equal(element('credentials-delete').hidden, true);
  assert.match(element('notice-message').textContent, /当前网站会话仍会保留/);
});

test('save rejects duplicate requests and restores usable controls after failure', async () => {
  let rejectSave;
  let saveCount = 0;
  const { element } = rendererFixture({
    saveCredentials: () => {
      saveCount++;
      return new Promise((_resolve, reject) => { rejectSave = reject; });
    },
  });
  await flush();
  await element('login-button').handlers.click();
  const saving = element('credentials-save').handlers.click();
  assert.equal(element('credentials-save').disabled, true);
  await element('credentials-save').handlers.click();
  assert.equal(saveCount, 1);
  rejectSave(new Error('请先填写网页登录表单'));
  await saving;
  assert.equal(element('credentials-save').disabled, false);
  assert.match(element('notice-message').textContent, /保存账号密码失败：请先填写/);
});

test('live credential status beats initial status and unavailable encryption still permits deletion', async () => {
  let resolveInitial;
  const fixture = rendererFixture({
    credentialsStatus: () => new Promise((resolve) => { resolveInitial = resolve; }),
  });
  fixture.windowChanged({ windowOpen: true, revision: 1 });
  fixture.changed({ available: false, saved: true });
  resolveInitial({ available: true, saved: false });
  await flush();
  assert.equal(fixture.element('credentials-save').disabled, true);
  assert.equal(fixture.element('credentials-fill').disabled, true);
  assert.equal(fixture.element('credentials-delete').disabled, false);
});

test('a cancelled fill does not show a success notice', async () => {
  const fixture = rendererFixture({ fillCredentials: async () => ({ filled: false }) });
  await flush();
  fixture.windowChanged({ windowOpen: true, revision: 1 });
  fixture.changed({ available: true, saved: true });
  await fixture.element('credentials-fill').handlers.click();
  assert.match(fixture.element('notice-message').textContent, /填充账号密码失败/);
  assert.equal(fixture.element('credentials-fill').disabled, false);
});

test('corrupt credential status disables fill while retaining update and deletion controls', async () => {
  const fixture = rendererFixture();
  await flush();
  fixture.windowChanged({ windowOpen: true, revision: 1 });
  fixture.changed({ available: true, saved: true, error: '无法解密' });
  assert.equal(fixture.element('credentials-fill').disabled, true);
  assert.equal(fixture.element('credentials-delete').disabled, false);
  assert.equal(fixture.element('credentials-save').disabled, false);
  await fixture.element('credentials-fill').handlers.click();
  assert.equal(fixture.calls.length, 0);
});

test('preload exposes only specific credential actions without arbitrary arguments', async () => {
  let exposed;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, api) { exposed = api; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); }, on() {}, removeListener() {} },
    }),
  });
  for (const method of ['credentialsStatus', 'saveCredentials', 'fillCredentials', 'deleteCredentials']) {
    await exposed[method]({ password: 'never sent' });
  }
  assert.deepEqual(calls.map((args) => [...args]), [
    ['auth:credentials-status'], ['auth:credentials-save'], ['auth:credentials-fill'], ['auth:credentials-delete'],
  ]);
});
