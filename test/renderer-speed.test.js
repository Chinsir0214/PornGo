'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererHarness } = require('./helpers/renderer-harness');

test('parallel videos keep their own speeds and clear finished attempts', async () => {
  let onDownloadEvent;
  let nextFrame = 0;
  const frames = new Map();
  function paintFrame() {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback();
  }
  const api = {
    sessionStatus: async () => ({ cookieCount: 0 }),
    parse: async () => ({ kind: 'playlist', snapshotId: 'snapshot', title: 'Two videos', entryCount: 2,
      formats: [{ id: 'best', label: 'Best' }] }),
    download: async () => {
      onDownloadEvent({ taskId: 'task-1', type: 'started' });
      return { taskId: 'task-1', items: [{ itemIndex: 1, title: 'First' }, { itemIndex: 2, title: 'Second' }] };
    },
    concurrencyOptions: async () => ({ fragment: [1, 4], video: [1, 2] }),
    onDownloadEvent: (callback) => { onDownloadEvent = callback; },
    onLoginClosed: () => {},
  };
  const { element } = createRendererHarness(api, {
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  paintFrame();
  await new Promise(setImmediate);
  element('video-url').value = 'https://www.pornhub.com/playlist/123';
  await element('parse-form').dispatch('submit', { preventDefault() {} });
  await element('download-button').dispatch('click');

  const emit = (type, activeVideos, percent = 50, itemUpdate) => onDownloadEvent({
    taskId: 'task-1', type, activeVideos, percent, itemCount: 2, activeCount: activeVideos.length, itemUpdate,
  });
  const rows = () => element('progress-videos').querySelectorAll('[data-testid="progress-item"]');
  const speeds = () => rows().map((row) => row.querySelector('.progress-video-speed').textContent);
  const first = { itemIndex: 1, title: 'First', speed: '1MiB/s', eta: '00:20' };
  const second = { itemIndex: 2, title: 'Second', speed: '2MiB/s', eta: '00:30' };

  const taskDetails = element('download-task-list').querySelector('details');
  taskDetails.open = true;
  taskDetails.dispatch('toggle');
  const itemStatus = (index) => taskDetails.querySelector('ul').querySelectorAll('li')[index].querySelector('.download-task-status').textContent;
  emit('progress', [first], 45, { ...first, state: 'downloading', percent: 90 });
  emit('progress', [first, second], 50, { ...second, state: 'downloading', percent: 10 });
  assert.equal(frames.size, 1);
  assert.equal(element('progress-percent').textContent, '0%');
  paintFrame();
  assert.match(itemStatus(0), /90%.*1MiB\/s/);
  assert.match(itemStatus(1), /10%.*2MiB\/s/);
  assert.deepEqual(speeds(), ['1MiB/s', '2MiB/s']);
  assert.match(rows()[0].querySelector('.progress-video-title').textContent, /First/);
  assert.match(rows()[1].querySelector('.progress-video-title').textContent, /Second/);
  assert.equal(element('progress-item').textContent, '当前并发下载：2 条视频');
  assert.doesNotMatch(element('progress-detail').textContent, /当前视频/);

  const [firstRow, secondRow] = rows();
  emit('progress', [{ ...first, speed: '3MiB/s' }, second], 60);
  paintFrame();
  assert.deepEqual(speeds(), ['3MiB/s', '2MiB/s']);
  assert.equal(rows()[0], firstRow);
  assert.equal(rows()[1], secondRow);
  assert.equal(element('progress-item').textContent, '当前并发下载：2 条视频');
  assert.equal(element('progress-percent').textContent, '60%');

  function emitConcurrentState(attempt, retryCount) {
    onDownloadEvent({ taskId: 'task-1', type: 'progress', activeVideos: [first, second],
      percent: 60, activeCount: 2, attempt, maxAttempts: 3, retryCount });
    paintFrame();
  }
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
  assert.equal(rows()[0], secondRow);
  emit('progress', [{ ...first, speed: '', eta: '' }, second], 60);
  paintFrame();
  assert.deepEqual(speeds(), ['测速中…', '2MiB/s']);

  emit('progress', [first, second], 70);
  assert.equal(frames.size, 1);
  emit('completed', [], 100);
  assert.equal(frames.size, 0);
  paintFrame();
  assert.equal(element('progress-status').textContent, '下载完成');
  assert.equal(element('progress-videos').hidden, true);
  assert.equal(rows().length, 0);
});
