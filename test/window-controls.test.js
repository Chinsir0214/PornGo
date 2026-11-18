'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('titlebar controls invoke window channels and reflect native maximize changes', async () => {
  const listeners = new Map();
  const calls = [];
  let maximized = false;
  let exposedApi;
  const ipcRenderer = {
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel) { listeners.delete(channel); },
    async invoke(channel) {
      calls.push(channel);
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
    },
  };
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  vm.runInNewContext(preload, {
    require(name) {
      assert.equal(name, 'electron');
      return {
        ipcRenderer,
        contextBridge: { exposeInMainWorld(name, api) {
          assert.equal(name, 'porngo');
          exposedApi = api;
        } },
      };
    },
  });

  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) {
      const classes = new Set();
      const attributes = new Map();
      elements.set(key, {
        value: '', textContent: '', hidden: false, disabled: false,
        dataset: {}, style: {}, handlers: {}, title: '',
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          toggle(name, force) {
            if (force === undefined ? !classes.has(name) : force) classes.add(name);
            else classes.delete(name);
          },
          contains(name) { return classes.has(name); },
        },
        addEventListener(name, callback) { this.handlers[name] = callback; },
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name); },
        removeAttribute(name) { attributes.delete(name); },
        replaceChildren() {},
      });
    }
    return elements.get(key);
  }
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  vm.runInNewContext(renderer, {
    window: { porngo: exposedApi },
    document: { getElementById: element, querySelector: element },
  });
  await new Promise(setImmediate);

  const minimize = element('window-minimize');
  const maximize = element('window-maximize');
  const close = element('window-close');
  const header = element('.app-header');
  assert.equal(maximize.getAttribute('aria-label'), '最大化窗口');

  await minimize.handlers.click();
  assert.equal(calls.at(-1), 'window:minimize');

  await maximize.handlers.click();
  assert.equal(calls.at(-1), 'window:toggle-maximize');
  assert.equal(maximize.getAttribute('aria-label'), '还原窗口');
  assert.equal(maximize.classList.contains('is-maximized'), true);

  await maximize.handlers.click();
  assert.equal(maximize.getAttribute('aria-label'), '最大化窗口');
  assert.equal(maximize.classList.contains('is-maximized'), false);

  const toggleCount = calls.filter((channel) => channel === 'window:toggle-maximize').length;
  header.handlers.dblclick({ target: { closest: () => null } });
  await new Promise(setImmediate);
  assert.equal(calls.filter((channel) => channel === 'window:toggle-maximize').length, toggleCount + 1);
  assert.equal(maximize.getAttribute('aria-label'), '还原窗口');

  header.handlers.dblclick({ target: { closest: () => ({}) } });
  await new Promise(setImmediate);
  assert.equal(calls.filter((channel) => channel === 'window:toggle-maximize').length, toggleCount + 1);

  maximized = false;
  listeners.get('window:state')(null, { maximized: false });
  assert.equal(maximize.getAttribute('aria-label'), '最大化窗口');
  assert.equal(maximize.classList.contains('is-maximized'), false);

  await close.handlers.click();
  assert.equal(calls.at(-1), 'window:close');
});

test('preload subscriptions forward payloads and remove their own handlers', () => {
  const listeners = new Map();
  let api;
  const ipcRenderer = {
    on(channel, handler) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(handler);
    },
    removeListener(channel, handler) { listeners.get(channel).delete(handler); },
  };
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  vm.runInNewContext(preload, {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: {
        exposeInMainWorld(_name, exposedApi) { api = exposedApi; },
      } };
    },
  });
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
    [...listeners.get(channel)][0](null, payload);
    assert.deepEqual(received, [payload]);
    unsubscribe();
    assert.equal(listeners.get(channel).size, 0);
  }
});
