'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererHarness } = require('./helpers/renderer-harness');
const { createPreloadHarness } = require('./helpers/preload-harness');

const flush = () => new Promise(setImmediate);

function rendererFixture(overrides = {}) {
  let changed;
  let windowChanged;
  const calls = [];
  const status = { available: true, saved: false };
  const api = {
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
  const { element } = createRendererHarness(api);
  return { element, calls, changed: (payload) => changed(payload), windowChanged: (payload) => windowChanged(payload) };
}

test('credentials require explicit save, permit manual fill, and delete only after confirmation', async () => {
  const fixture = rendererFixture();
  const { element, calls } = fixture;
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(element('credentials-save').disabled, true, 'closed login window cannot save');
  await element('login-button').dispatch('click');
  assert.equal(element('credentials-save').disabled, false);
  await element('credentials-save').dispatch('click');
  assert.equal(element('credentials-save').textContent, '更新网页登录账号密码');
  assert.equal(element('credentials-fill').hidden, false);
  await element('credentials-fill').dispatch('click');
  element('credentials-delete').dispatch('click');
  assert.equal(element('delete-credentials-dialog').open, true);
  element('delete-credentials-dialog').returnValue = 'cancel';
  element('delete-credentials-dialog').dispatch('close');
  assert.equal(calls.filter(([name]) => name === 'delete').length, 0);
  element('delete-credentials-dialog').returnValue = 'confirm';
  element('credentials-delete').dispatch('click');
  assert.equal(element('delete-credentials-dialog').returnValue, '');
  element('delete-credentials-dialog').dispatch('close');
  assert.equal(calls.filter(([name]) => name === 'delete').length, 0);
  element('credentials-delete').dispatch('click');
  element('delete-credentials-dialog').returnValue = 'confirm';
  element('delete-credentials-dialog').dispatch('close');
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
  await element('login-button').dispatch('click');
  const saving = element('credentials-save').dispatch('click');
  assert.equal(element('credentials-save').disabled, true);
  await element('credentials-save').dispatch('click');
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
  await fixture.element('credentials-fill').dispatch('click');
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
  await fixture.element('credentials-fill').dispatch('click');
  assert.equal(fixture.calls.length, 0);
});

test('preload exposes only specific credential actions without arbitrary arguments', async () => {
  const { api: exposed, calls } = createPreloadHarness();
  for (const method of ['credentialsStatus', 'saveCredentials', 'fillCredentials', 'deleteCredentials']) {
    await exposed[method]({ password: 'never sent' });
  }
  assert.deepEqual(calls.map((args) => [...args]), [
    ['auth:credentials-status'], ['auth:credentials-save'], ['auth:credentials-fill'], ['auth:credentials-delete'],
  ]);
});

test('deleting credentials with the login window closed restores focus to the login button', async () => {
  const { element, changed } = rendererFixture();
  await flush();
  changed({ available: true, saved: true });
  await element('credentials-delete').dispatch('click');
  const dialog = element('delete-credentials-dialog');
  dialog.returnValue = 'confirm';
  await dialog.dispatch('close');
  assert.equal(element('credentials-delete').hidden, true);
  assert.equal(dialog.ownerDocument.activeElement, element('login-button'));
});
