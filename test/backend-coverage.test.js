'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { accessLoginFields } = require('../src/login-credentials');
const { createResourceParser } = require('../src/resource-parser');
const { createSiteClient } = require('../src/site-client');
const { registerIpc } = require('../src/ipc-handlers');

const origin = 'https://www.pornhub.com';
const videoUrl = origin + '/view_video.php?viewkey=ph1234';

function loginForm(action = '/login', autocomplete = 'current-password') {
  class Element {
    getAttribute(name) { return name === 'action' ? action : null; }
  }
  class HTMLInputElement extends Element {
    get value() { return this.text || ''; }
    set value(value) { this.text = value; }
    getClientRects() { return [{}]; }
    closest() { return null; }
    dispatchEvent() {}
  }
  const form = new Element();
  const field = (type, name, autocomplete) =>
    Object.assign(new HTMLInputElement(), { type, name, autocomplete, form });
  const username = field('text', 'username', 'username');
  const password = field('password', 'password', autocomplete);
  form.action = field('text', 'action', ''); // Named input shadows the form's action property.
  form.querySelectorAll = () => [username, password, form.action];
  const window = {};
  window.top = window;
  return vm.runInNewContext('(' + accessLoginFields.toString() + ')', {
    window, location: new URL('/login', origin), URL, Element, HTMLInputElement, Event,
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelectorAll: () => [password] },
  });
}

test('fills and reads a login form even with an input named action', () => {
  const access = loginForm();
  const credentials = { origin, username: 'alice', password: 'example' };
  assert.equal(access({ ...credentials, action: 'fill' }).filled, true);
  assert.deepEqual({ ...access({ origin, action: 'read' }) }, credentials);
});

test('rejects clobbered external actions, new passwords, signup and reset forms', () => {
  for (const access of [loginForm('https://evil.example/login'), loginForm('/login', 'new-password'),
    loginForm('/signup'), loginForm('/reset')]) {
    for (const action of ['read', 'fill']) assert.equal(access({ origin, action }), null);
  }
});

test('video parsing resolves the Chinese title and retains the latest five snapshots', async () => {
  const parser = createResourceParser({
    captureMetadata: async () => ({ id: 'ph1234', title: 'Original', formats: [] }),
    fetchSitePage: async () => '<html lang="zh-CN"><script>var VIDEO_SHOW = '
      + '{"vkey":"ph1234","videoTitleOriginal":"Original","videoTitleTranslated":"中文标题"};</script></html>',
  });
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const result = await parser.parse(videoUrl);
    assert.equal(result.kind, 'video');
    assert.equal(result.title, '中文标题');
    ids.push(result.snapshotId);
    if (i === 4) assert.ok(parser.getSnapshot(ids[0]));
  }
  assert.equal(parser.getSnapshot(ids[0]), undefined);
  assert.equal(new Set(ids).size, 6);
  for (const id of ids.slice(1)) assert.equal(parser.getSnapshot(id).videos[0].downloadTitle, '中文标题');
});

test('playlist parsing stores the videos referenced by the returned snapshot', async () => {
  const url = origin + '/playlist/12345';
  const parser = createResourceParser({
    fetchSitePage: async (requested) => requested === url
      ? '<title>Sample</title><script>var playlistId = "12345"; var token = "abc"; var itemsCount = 1;</script>'
      : '<a href="/view_video.php?viewkey=ph1234" title="Video">Video</a>',
  });
  const result = await parser.parse(url);
  assert.deepEqual([result.kind, result.title, result.entryCount], ['playlist', 'Sample', 1]);
  assert.deepEqual(parser.getSnapshot(result.snapshotId).videos, [{ url: videoUrl, title: 'Video' }]);
});

test('site client checks redirect destinations and ports before fetching', async () => {
  const requests = [];
  const client = createSiteClient({ authSession: () => ({ fetch(url, options) {
    requests.push(url);
    assert.equal(options.redirect, 'manual');
    return Response.redirect('https://evil.example/login');
  } }) });
  const denied = { message: '内嵌网页无法读取页面：不允许访问此网站地址。', retryable: false };
  await assert.rejects(client.fetchSitePage(origin), denied);
  await assert.rejects(client.fetchSitePage(origin + ':8443/login'), denied);
  assert.deepEqual(requests, [origin]);
});

test('site client enforces the byte limit with and without Content-Length', async () => {
  for (const headers of [{}, { 'Content-Length': '6' }]) {
    const client = createSiteClient({ maxBytes: 5,
      authSession: () => ({ fetch: () => new Response('中文', { headers }) }) });
    await assert.rejects(client.fetchSitePage(origin), {
      message: '内嵌网页无法读取页面：网站页面超过大小限制。', retryable: false,
    });
  }
});

test('preload requests have IPC handlers and subscriptions match backend senders', () => {
  const source = (name) => readFileSync(require.resolve('../src/' + name), 'utf8');
  const handled = new Set();
  registerIpc({ ipcMain: { handle: (channel) => handled.add(channel) }, auth: {}, downloadTasks: {} });
  const events = {
    onWindowState: 'window:state', onDownloadEvent: 'download:event', onLoginClosed: 'auth:closed',
    onLoginWindowChanged: 'auth:window-changed', onSessionStatusChanged: 'auth:status-changed',
    onCredentialsChanged: 'auth:credentials-changed',
  };
  let api;
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'porngo'); api = value; } },
    ipcRenderer: { invoke: (channel) => channel, on: (channel) => subscribed.push(channel) },
  };
  const subscribed = [];
  vm.runInNewContext(source('preload'), { require(name) { assert.equal(name, 'electron'); return electron; } });
  const invoked = new Set();
  for (const [name, method] of Object.entries(api)) {
    if (Object.hasOwn(events, name)) {
      method(() => {});
      assert.equal(subscribed.at(-1), events[name], name);
    } else {
      const channel = method();
      assert.ok(handled.has(channel), name);
      invoked.add(channel);
    }
  }
  assert.deepEqual(invoked, handled);
  assert.deepEqual(new Set(subscribed), new Set(Object.values(events)));
  const backend = ['main', 'auth-window', 'ipc-handlers'].map(source).join('\n');
  const emitted = new Set(Array.from(backend.matchAll(/(?:webContents\.send|\bpublish)\(\s*['"]([^'"]+)['"]/g),
    (match) => match[1]));
  for (const channel of subscribed) assert.ok(emitted.has(channel), channel);
});

test('redirected video metadata must identify the requested video', async () => {
  let id = 'other';
  const parser = createResourceParser({
    captureMetadata: async () => ({ id, title: 'Original', formats: [] }),
    fetchSitePage: async () => '',
  });
  await assert.rejects(parser.parse(videoUrl), /视频 ID/);
  for (id of ['PH1234', undefined]) assert.equal((await parser.parse(videoUrl)).id, 'ph1234');
});
