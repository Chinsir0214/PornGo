'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRevisionGate, inspectSiteLoginState, resolveObservedLogin } = require('../src/auth-status');

const flush = () => new Promise(setImmediate);

function authHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const start = source.indexOf('async function readSessionStatus(');
  const end = source.indexOf('function credentialsStatus(', start);
  const windows = [];
  const events = [];
  const timers = new Map();
  let nextTimer = 0;
  let cookies = 3;
  let observe = async () => 'unknown';
  let poll;
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.closeCalls = 0;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.getURL = () => this.url;
      this.webContents.executeJavaScript = () => observe(this);
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    async loadURL(url) { this.url = url; }
    close() {
      this.closeCalls++;
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit('closed'); }
    }
  }
  const context = {
    BrowserWindow: FakeWindow, ICON_PATH: 'icon', AUTH_PARTITION: 'auth',
    setWindowAppDetails: () => {},
    setupLoginCredentials: () => {},
    mainWindow: { isDestroyed: () => false, webContents: { send: (type, result) => events.push({ type, result }) } },
    loginWindow: null, loginWindowRevision: 0, clearingSession: false, recentlyVerifiedLogin: false,
    loginClosePending: false, loginCloseApproved: false, stopAuthPolling: null,
    authRevision: createRevisionGate(), inspectSiteLoginState, resolveObservedLogin,
    siteCookies: async () => Array(cookies).fill({}),
    isAllowedAuthUrl: (url) => typeof url === 'string' && url.startsWith('https://www.pornhub.com/'),
    startStatusPolling: (callback) => { poll = callback; return () => { poll = null; }; },
    authSession: () => ({ clearStorageData: async () => { cookies = 0; } }),
    dialog: { showErrorBox() {} },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end)
    + '\nglobalThis.authApi = { openLogin, scheduleSessionStatusUpdate, logout };', context);
  return {
    ...context.authApi, context, windows, events,
    observe: (callback) => { observe = callback; },
    tick: () => { if (poll) poll(); },
    runStatusTimer: async () => {
      const entry = [...timers].find(([, timer]) => timer.delay === 500);
      assert.ok(entry, 'status timer should be scheduled');
      timers.delete(entry[0]);
      await entry[1].callback();
      await flush();
    },
  };
}

test('verified login promptly updates the main window, closes only the login window, and preserves confirmation', async () => {
  const auth = authHarness();
  auth.openLogin();
  auth.observe(async () => 'verified');
  auth.windows[0].webContents.emit('did-finish-load');
  await auth.runStatusTimer();
  assert.equal(auth.windows[0].destroyed, true);
  assert.equal(auth.windows[0].closeCalls, 1);
  assert.deepEqual(auth.events.filter(({ type }) => type !== 'auth:window-changed').map(({ type, result }) => [type, result.loginState]), [
    ['auth:status-changed', 'verified'], ['auth:closed', 'recently_verified'],
  ]);
  assert.equal(auth.context.loginWindow, null);
});

test('saved anonymous cookies do not close the login window and same-page polling detects later success', async () => {
  const auth = authHarness();
  auth.openLogin();
  auth.observe(async () => 'signed_out');
  auth.windows[0].webContents.emit('did-finish-load');
  await auth.runStatusTimer();
  assert.equal(auth.windows[0].closeCalls, 0);
  assert.equal(auth.events.at(-1).result.loginState, 'signed_out');
  auth.observe(async () => 'verified');
  auth.tick();
  await auth.runStatusTimer();
  assert.equal(auth.windows[0].destroyed, true);
  assert.equal(auth.events.at(-1).result.loginState, 'recently_verified');
});

test('an old verification result cannot close a replacement login window', async () => {
  const auth = authHarness();
  auth.openLogin();
  const oldWindow = auth.windows[0];
  let finishObservation;
  auth.observe(() => new Promise((resolve) => { finishObservation = resolve; }));
  auth.scheduleSessionStatusUpdate();
  const pending = auth.runStatusTimer();
  await flush();
  oldWindow.destroyed = true;
  oldWindow.emit('closed');
  await flush();
  auth.openLogin();
  finishObservation('verified');
  await pending;
  assert.equal(auth.windows[1].closeCalls, 0);
  assert.equal(auth.context.recentlyVerifiedLogin, false);
});

test('logout invalidates an in-flight verification and retains empty session state', async () => {
  const auth = authHarness();
  const opened = auth.openLogin();
  let finishObservation;
  auth.observe(() => new Promise((resolve) => { finishObservation = resolve; }));
  auth.scheduleSessionStatusUpdate();
  const pending = auth.runStatusTimer();
  await flush();
  const result = await auth.logout();
  finishObservation('verified');
  await pending;
  assert.equal(result.loginState, 'empty');
  assert.equal(auth.context.recentlyVerifiedLogin, false);
  assert.equal(auth.events.some(({ result: event }) => event.loginState === 'verified'), false);
  assert.deepEqual(auth.events.filter(({ type }) => type === 'auth:window-changed')
    .map(({ result }) => [result.windowOpen, result.revision]), [
    [true, opened.revision], [false, opened.revision + 1],
  ]);
});

test('closing a signed-out login window and reopening advances independent revisions', async () => {
  const auth = authHarness();
  const opened = auth.openLogin();
  auth.observe(async () => 'signed_out');
  auth.scheduleSessionStatusUpdate();
  await auth.runStatusTimer();
  const focused = auth.openLogin();
  assert.equal(focused.revision, opened.revision);
  auth.windows[0].close();
  await flush();
  assert.equal(auth.windows[0].destroyed, true);
  assert.equal(auth.events.at(-1).type, 'auth:closed');
  assert.notEqual(auth.events.at(-1).result.loginState, 'recently_verified');
  const reopened = auth.openLogin();
  assert.equal(reopened.windowOpen, true);
  assert.deepEqual(auth.events.filter(({ type }) => type === 'auth:window-changed')
    .map(({ result }) => [result.windowOpen, result.revision]), [
    [true, opened.revision], [false, opened.revision + 1], [true, reopened.revision],
  ]);
  assert.equal(reopened.revision, opened.revision + 2);
});
