'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeResourceUrl } = require('../src/pornhub');

test('renderer delegates URL validation and keeps batch concurrency when editing single-video settings', async () => {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) {
      elements.set(key, {
        value: '', textContent: '', hidden: false, disabled: false,
        dataset: {}, style: {}, handlers: {}, attributes: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, callback) { this.handlers[name] = callback; },
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        focus() { this.focused = true; },
        replaceChildren() { this.value = ''; },
        append(option) { if (!this.value) this.value = option.value; },
      });
    }
    return elements.get(key);
  }
  const url = 'http://de.pornhub.com/view_video.php?viewkey=example';
  let submitted;
  let emit;
  let networkFailure = false;
  let saved = JSON.stringify({ fragmentConcurrency: '1', videoConcurrency: '2' });
  const parsedUrls = [];
  const api = {
    getDirectory: async () => path.join(__dirname, '..', 'downtest'),
    sessionStatus: async () => ({ cookieCount: 0 }),
    parse: async (input) => {
      parsedUrls.push(input);
      if (networkFailure) throw new Error('连接超时');
      const resource = normalizeResourceUrl(input);
      return { ...resource, snapshotId: `snapshot-${parsedUrls.length}`, entryCount: 3,
        title: 'Sample', formats: [{ id: 'best', label: 'Best' }] };
    },
    concurrencyOptions: async () => ({ fragment: [1, 4], video: [1, 2] }),
    download: async (request) => {
      submitted = request;
      emit({ taskId: 'test-task', type: 'started' });
      return { taskId: 'test-task' };
    },
    onDownloadEvent: (listener) => { emit = listener; }, onLoginClosed: () => {},
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  vm.runInNewContext(source, {
    window: { porngo: api, localStorage: { getItem: () => saved, setItem: (_key, value) => { saved = value; } } },
    document: { getElementById: element, querySelector: element, createElement: () => ({}) },
    URL,
  });
  await new Promise(setImmediate);
  const submit = () => element('parse-form').handlers.submit({ preventDefault() {} });
  await submit();
  assert.deepEqual(parsedUrls, []);
  assert.equal(element('video-url').attributes['aria-invalid'], 'true');
  assert.equal(element('video-url').focused, true);

  const invalidHost = 'https://pornhub.com.evil.example/view_video.php?viewkey=example';
  element('video-url').value = invalidHost;
  await submit();
  assert.deepEqual(parsedUrls, [invalidHost]);
  assert.match(element('notice-message').textContent, /解析失败：仅支持 Pornhub/);
  assert.equal(element('download-button').disabled, true);

  const defaultPort = 'http://de.pornhub.com:80/view_video.php?viewkey=example';
  element('video-url').value = defaultPort;
  await submit();
  assert.deepEqual(parsedUrls, [invalidHost, defaultPort]);
  assert.match(element('notice-message').textContent, /解析失败：链接格式无效/);
  assert.equal(element('download-button').disabled, true);

  networkFailure = true;
  element('video-url').value = url;
  await submit();
  assert.match(element('notice-message').textContent, /解析失败：连接超时/);
  assert.equal(element('download-button').disabled, true);

  networkFailure = false;
  await submit();
  assert.equal(parsedUrls.at(-1), url);
  assert.equal(element('video-concurrency').value, '1');
  assert.equal(element('video-concurrency').disabled, true);
  element('fragment-concurrency').value = '4';
  element('fragment-concurrency').handlers.change();
  assert.deepEqual(JSON.parse(saved), { fragmentConcurrency: '4', videoConcurrency: '2' });
  await element('download-button').handlers.click();
  assert.equal(submitted.videoConcurrency, 1);
  assert.equal(submitted.fragmentConcurrency, 4);
  assert.equal(submitted.snapshotId, 'snapshot-4');

  element('video-url').value = 'https://www.pornhub.com/playlist/123';
  element('video-url').handlers.input();
  await submit();
  assert.equal(element('video-concurrency').disabled, false);
  assert.equal(element('video-concurrency').value, '2');
});
