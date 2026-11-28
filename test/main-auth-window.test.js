'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthController } = require('../src/auth-window');
const { authOptions } = require('./auth-window-fixture');

const flush = () => new Promise(setImmediate);
function authHarness(t) {
  const fixture = authOptions(t);
  const auth = createAuthController(fixture.options);
  t.after(auth.stopLoginObservation);
  return { ...fixture, ...auth,
    runStatusTimer: async () => { t.mock.timers.tick(500); await flush(); },
    tick: () => t.mock.timers.tick(2500),
  };
}

test('verified login promptly updates the main window, closes only the login window, and preserves confirmation', async (t) => {
  const auth = authHarness(t);
  auth.openLogin();
  auth.observe(async () => 'verified');
  auth.windows[0].webContents.emit('did-finish-load');
  await auth.runStatusTimer();
  assert.equal(auth.windows[0].destroyed, true);
  assert.equal(auth.windows[0].closeCalls, 1);
  assert.deepEqual(auth.events.filter(({ type }) => type !== 'auth:window-changed').map(({ type, result }) => [type, result.loginState]), [
    ['auth:status-changed', 'verified'], ['auth:closed', 'recently_verified'],
  ]);
  assert.equal(auth.events.filter(({ type }) => type === 'auth:window-changed').at(-1).result.windowOpen, false);
});

test('saved anonymous cookies do not close the login window and same-page polling detects later success', async (t) => {
  const auth = authHarness(t);
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

test('an old verification result cannot close a replacement login window', async (t) => {
  const auth = authHarness(t);
  auth.openLogin();
  const oldWindow = auth.windows[0];
  let finishObservation;
  auth.observe(() => new Promise((resolve) => { finishObservation = resolve; }));
  auth.windows.at(-1).webContents.emit('did-navigate');
  const pending = auth.runStatusTimer();
  await flush();
  oldWindow.destroyed = true;
  oldWindow.emit('closed');
  await flush();
  auth.openLogin();
  finishObservation('verified');
  await pending;
  assert.equal(auth.windows[1].closeCalls, 0);
  assert.equal(auth.events.some(({ result }) => result.loginState === 'recently_verified'), false);
});

test('logout invalidates an in-flight verification and retains empty session state', async (t) => {
  const auth = authHarness(t);
  const opened = auth.openLogin();
  let finishObservation;
  auth.observe(() => new Promise((resolve) => { finishObservation = resolve; }));
  auth.windows.at(-1).webContents.emit('did-navigate');
  const pending = auth.runStatusTimer();
  await flush();
  const result = await auth.logout();
  finishObservation('verified');
  await pending;
  assert.equal(result.loginState, 'empty');
  assert.equal(auth.events.some(({ result }) => result.loginState === 'recently_verified'), false);
  assert.equal(auth.events.some(({ result: event }) => event.loginState === 'verified'), false);
  assert.deepEqual(auth.events.filter(({ type }) => type === 'auth:window-changed')
    .map(({ result }) => [result.windowOpen, result.revision]), [
    [true, opened.revision], [false, opened.revision + 1],
  ]);
});

test('closing a signed-out login window and reopening advances independent revisions', async (t) => {
  const auth = authHarness(t);
  const opened = auth.openLogin();
  auth.observe(async () => 'signed_out');
  auth.windows.at(-1).webContents.emit('did-navigate');
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
