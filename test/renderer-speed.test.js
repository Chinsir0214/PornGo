'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('parallel videos keep their own speeds and clear finished attempts', async () => {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) {
      elements.set(key, {
        value: '', textContent: '', hidden: false, disabled: false,
        dataset: {}, style: {}, handlers: {}, attributes: {}, children: [],
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(name, callback) { this.handlers[name] = callback; },
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        replaceChildren(...children) { this.children = children; this.value = ''; },
        append(...children) {
          this.children.push(...children);
          if (!this.value && children[0]?.value) this.value = children[0].value;
        },
        focus() {},
      });
    }
    return elements.get(key);
  }

  let onDownloadEvent;
  const api = {
    getDirectory: async () => path.join(__dirname, '..', 'downtest'),
    sessionStatus: async () => ({ cookieCount: 0 }),
    parse: async () => ({ kind: 'playlist', snapshotId: 'snapshot', title: 'Two videos', entryCount: 2,
      formats: [{ id: 'best', label: 'Best' }] }),
    download: async () => {
      onDownloadEvent({ taskId: 'task-1', type: 'started' });
      return { taskId: 'task-1' };
    },
    concurrencyOptions: async () => ({ fragment: [1, 4], video: [1, 2] }),
    onDownloadEvent: (callback) => { onDownloadEvent = callback; },
    onLoginClosed: () => {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8'), {
    window: { porngo: api },
    document: { getElementById: element, querySelector: element, createElement: () => element(Symbol()) },
    URL,
  });
  await new Promise(setImmediate);
  element('video-url').value = 'https://www.pornhub.com/playlist/123';
  await element('parse-form').handlers.submit({ preventDefault() {} });
  await element('download-button').handlers.click();

  const emit = (type, activeVideos, percent = 50) => onDownloadEvent({
    taskId: 'task-1', type, activeVideos, percent, itemCount: 2, activeCount: activeVideos.length,
  });
  const rows = () => element('progress-videos').children;
  const speeds = () => rows().map((row) => row.children[1].textContent);
  const first = { itemIndex: 1, title: 'First', speed: '1MiB/s', eta: '00:20' };
  const second = { itemIndex: 2, title: 'Second', speed: '2MiB/s', eta: '00:30' };

  emit('progress', [first, second]);
  assert.deepEqual(speeds(), ['1MiB/s', '2MiB/s']);
  assert.match(rows()[0].children[0].textContent, /First/);
  assert.match(rows()[1].children[0].textContent, /Second/);
  assert.equal(element('progress-item').textContent, '当前并发下载：2 条视频');
  assert.doesNotMatch(element('progress-detail').textContent, /当前视频/);

  emit('progress', [{ ...first, speed: '3MiB/s' }, second], 60);
  assert.deepEqual(speeds(), ['3MiB/s', '2MiB/s']);
  assert.equal(element('progress-item').textContent, '当前并发下载：2 条视频');
  assert.equal(element('progress-percent').textContent, '60%');

  const emitConcurrentState = (attempt, retryCount) => onDownloadEvent({
    taskId: 'task-1', type: 'progress', activeVideos: [first, second],
    percent: 60, activeCount: 2, attempt, maxAttempts: 3, retryCount,
  });
  emitConcurrentState(1, 1);
  const concurrentDetail = element('progress-detail').textContent;
  const concurrentStatus = element('progress-status').textContent;
  emitConcurrentState(2, 1);
  assert.equal(element('progress-detail').textContent, concurrentDetail);
  assert.equal(element('progress-status').textContent, concurrentStatus);
  assert.doesNotMatch(concurrentDetail, /同时下载 2 条/);
  assert.match(concurrentDetail, /1 条等待重试/);
  emitConcurrentState(2, 2);
  assert.match(element('progress-detail').textContent, /2 条等待重试/);

  emit('retry', [second], 60);
  assert.deepEqual(speeds(), ['2MiB/s']);
  emit('progress', [{ ...first, speed: '', eta: '' }, second], 60);
  assert.deepEqual(speeds(), ['测速中…', '2MiB/s']);

  emit('completed', [], 100);
  assert.equal(element('progress-videos').hidden, true);
  assert.equal(rows().length, 0);
});
