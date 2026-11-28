'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRendererHarness } = require('./helpers/renderer-harness');
const { createPreloadHarness } = require('./helpers/preload-harness');

test('titlebar controls invoke window channels and reflect native maximize changes', async () => {
  let maximized = false;
  const { api, calls, emit } = createPreloadHarness((channel) => {
    switch (channel) {
      case 'window:state': return { maximized };
      case 'window:minimize': return undefined;
      case 'window:toggle-maximize':
        maximized = !maximized;
        return { maximized };
      case 'window:close': return undefined;
      case 'directory:get': return path.join(__dirname, '..', 'downtest');
      case 'auth:status': return { cookieCount: 0 };
      default: throw new Error(`Unexpected IPC channel: ${channel}`);
    }
  });
  const { element, document } = createRendererHarness(api);
  await new Promise(setImmediate);

  const minimize = element('window-minimize');
  const maximize = element('window-maximize');
  const close = element('window-close');
  const header = document.querySelector('.app-header');
  assert.equal(maximize.getAttribute('aria-label'), '最大化窗口');

  await minimize.dispatch('click');
  assert.equal(calls.at(-1)[0], 'window:minimize');

  await maximize.dispatch('click');
  assert.equal(calls.at(-1)[0], 'window:toggle-maximize');
  assert.equal(maximize.getAttribute('aria-label'), '还原窗口');
  assert.equal(maximize.classList.contains('is-maximized'), true);

  await maximize.dispatch('click');
  assert.equal(maximize.getAttribute('aria-label'), '最大化窗口');
  assert.equal(maximize.classList.contains('is-maximized'), false);

  const toggleCount = calls.filter(([channel]) => channel === 'window:toggle-maximize').length;
  header.dispatch('dblclick', { target: { closest: () => null } });
  await new Promise(setImmediate);
  assert.equal(calls.filter(([channel]) => channel === 'window:toggle-maximize').length, toggleCount + 1);
  assert.equal(maximize.getAttribute('aria-label'), '还原窗口');

  header.dispatch('dblclick', { target: { closest: () => ({}) } });
  await new Promise(setImmediate);
  assert.equal(calls.filter(([channel]) => channel === 'window:toggle-maximize').length, toggleCount + 1);

  maximized = false;
  emit('window:state', { maximized: false });
  assert.equal(maximize.getAttribute('aria-label'), '最大化窗口');
  assert.equal(maximize.classList.contains('is-maximized'), false);

  await close.dispatch('click');
  assert.equal(calls.at(-1)[0], 'window:close');
});

test('preload subscriptions forward payloads and remove their own handlers', () => {
  const { api, listeners, emit } = createPreloadHarness();
  for (const [method, channel] of [
    ['onWindowState', 'window:state'],
    ['onLoginClosed', 'auth:closed'],
    ['onSessionStatusChanged', 'auth:status-changed'],
    ['onDownloadEvent', 'download:event'],
  ]) {
    assert.throws(() => api[method](null), /需要事件回调函数/);
    const received = [];
    const unsubscribe = api[method]((payload) => received.push(payload));
    const payload = { channel };
    assert.equal(listeners.get(channel).size, 1);
    emit(channel, payload);
    assert.deepEqual(received, [payload]);
    unsubscribe();
    assert.equal(listeners.get(channel).size, 0);
  }
});

test('pagehide unsubscribes all six renderer IPC listeners', async () => {
  const { api, listeners } = createPreloadHarness();
  const { dispatchPagehide } = createRendererHarness(api);
  await new Promise(setImmediate);
  const channels = ['auth:closed', 'auth:credentials-changed', 'auth:status-changed',
    'auth:window-changed', 'download:event', 'window:state'];
  assert.deepEqual([...listeners.keys()].sort(), channels);
  for (const channel of channels) assert.equal(listeners.get(channel).size, 1, channel);
  await dispatchPagehide();
  for (const channel of channels) assert.equal(listeners.get(channel).size, 0, channel);
});
