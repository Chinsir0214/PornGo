'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererHarness } = require('./helpers/renderer-harness');

function rendererHarness(download, retryDownload, { autoStart = true, cancel, parseResource } = {}) {
  let emit;
  const requests = [];
  const cancellations = [];
  function startUnqueued(task) {
    if (autoStart && !task.queued) emit({ type: 'started', taskId: task.taskId });
    return task;
  }
  const api = {
    sessionStatus: async () => ({ cookieCount: 0 }),
    parse: parseResource || (async (url) => url.endsWith('/first')
      ? { kind: 'playlist', snapshotId: 'first-snapshot', title: 'First list', entryCount: 3,
        formats: [{ id: 'best', label: 'Best' }] }
      : { kind: 'video', snapshotId: 'second-snapshot', title: 'Second video',
        formats: [{ id: 'best', label: 'Best' }] }),
    download: async (request) => {
      requests.push(request);
      return startUnqueued(await download(request, requests.length));
    },
    cancel: async (taskId) => { cancellations.push(taskId); return cancel?.(taskId); },
    removeQueued: async (taskId) => { cancellations.push(taskId); return true; },
    retryDownload: retryDownload && (async (request) => startUnqueued(await retryDownload(request))),
    concurrencyOptions: async () => ({ fragment: [1, 4], video: [1, 2] }),
    onDownloadEvent: (callback) => { emit = callback; },
    onLoginClosed: () => {},
  };
  const { element, document } = createRendererHarness(api);
  return { element, requests, cancellations, document, emit: (event) => emit(event) };
}

async function parse(harness, url) {
  harness.element('video-url').value = url;
  harness.element('video-url').dispatch('input');
  await harness.element('parse-form').dispatch('submit', { preventDefault() {} });
}

test('performer selections survive collapsing, block empty submissions and reset for the next parse', async () => {
  const entries = ['One', 'Two', 'Three'].map((title) => ({ title, url: `https://example.test/${title}` }));
  const harness = rendererHarness(() => ({ taskId: 'selection-task' }), undefined, {
    parseResource: async (url) => ({
      snapshotId: 'selection', title: 'Test', formats: [{ id: 'best' }],
      ...(url.endsWith('/star') ? { kind: 'pornstar', entryCount: entries.length, entries } : { kind: 'video' }),
    }),
  });
  const { element, requests } = harness;
  await new Promise(setImmediate);
  await parse(harness, 'https://example.test/star');
  const list = element('performer-entries');
  const details = element('performer-details');
  const all = element('performer-select-all');
  assert.equal(details.open, true);
  assert.equal(all.checked, true);
  assert.equal(list.querySelectorAll('.performer-url')[1].textContent, entries[1].url);
  list.querySelectorAll('input')[1].checked = false;
  list.dispatch('change');
  assert.equal(all.indeterminate, true);
  details.open = false;
  assert.equal(element('performer-selection-count').textContent, '已选 2 / 3 条');
  await element('download-button').dispatch('click');
  assert.deepEqual(Array.from(requests[0].itemIndices), [1, 3]);
  details.open = true;
  assert.equal(list.querySelectorAll('input')[1].checked, false);
  all.checked = false;
  all.dispatch('change');
  assert.equal(list.querySelectorAll('input').every((input) => !input.checked), true);
  assert.equal(all.indeterminate, false);
  assert.equal(element('download-button').disabled, true);
  await element('download-button').dispatch('click');
  assert.equal(requests.length, 1);
  all.checked = true;
  all.dispatch('change');
  assert.equal(list.querySelectorAll('input').every((input) => input.checked), true);
  assert.equal(element('download-button').disabled, false);
  await parse(harness, 'https://example.test/video');
  assert.equal(details.hidden, true);
  assert.equal(list.children.length, 0);
  assert.equal(element('video-details').parentElement, element('video-preview'));
});

test('a second link can be parsed and queued while the first download continues', async () => {
  const harness = rendererHarness((_request, index) => ({
    taskId: 'task-' + index, queued: index > 1, queuePosition: index,
  }));
  const { element, requests, emit } = harness;
  await new Promise(setImmediate);
  await parse(harness, 'https://www.pornhub.com/first');
  await element('download-button').dispatch('click');
  assert.equal(requests[0].snapshotId, 'first-snapshot');
  assert.equal(Object.hasOwn(requests[0], 'url'), false);
  assert.equal(element('video-url').disabled, false);
  assert.equal(element('parse-button').disabled, false);

  await parse(harness, 'https://www.pornhub.com/second');
  assert.equal(element('parsed-title').textContent, 'Second video');
  assert.equal(element('download-label').textContent, '加入下载队列');
  await element('download-button').dispatch('click');
  assert.equal(requests[1].snapshotId, 'second-snapshot');
  assert.equal(requests[1].videoConcurrency, 1);
  assert.equal(element('queue-status').textContent, '排队等待：1 个任务');

  emit({ taskId: 'task-1', type: 'progress', percent: 45,
    itemIndex: 2, itemCount: 3, currentTitle: 'First item', activeVideos: [] });
  assert.match(element('progress-item').textContent, /第 2 \/ 3 条.*First item/);
  assert.equal(element('progress-percent').textContent, '45%');

  emit({ taskId: 'task-1', type: 'completed', percent: 100, completedCount: 3 });
  assert.equal(element('queue-toggle').hidden, false);
  assert.equal(element('progress-status').textContent, '下载完成');
  element('queue-toggle').focus();
  emit({ taskId: 'task-2', type: 'started', percent: 0 });
  assert.equal(element('queue-toggle').hidden, true);
  assert.equal(harness.document.activeElement, element('progress-status'));
  emit({ taskId: 'task-2', type: 'progress', percent: 60,
    itemIndex: 1, itemCount: 1, currentTitle: 'Second video', activeVideos: [] });
  assert.equal(element('progress-percent').textContent, '60%');
  assert.equal(element('progress-item').hidden, true);
  emit({ taskId: 'task-2', type: 'completed', percent: 100, completedCount: 1 });
  assert.equal(element('progress-status').textContent, '下载完成');
  assert.equal(element('download-label').textContent, '开始下载');
});

test('a queued task that starts before its IPC reply still becomes the active task', async () => {
  let resolveSecond;
  const harness = rendererHarness((_request, index) => index === 1
    ? { taskId: 'task-1', queued: false, queuePosition: 1 }
    : new Promise((resolve) => { resolveSecond = resolve; }));
  const { element, emit } = harness;
  await new Promise(setImmediate);
  await parse(harness, 'https://www.pornhub.com/first');
  await element('download-button').dispatch('click');
  await parse(harness, 'https://www.pornhub.com/second');
  const pendingReply = element('download-button').dispatch('click');

  emit({ taskId: 'task-1', type: 'completed', percent: 100, completedCount: 3 });
  emit({ taskId: 'task-2', type: 'started', percent: 0 });
  emit({ taskId: 'task-2', type: 'progress', percent: 25,
    itemIndex: 1, itemCount: 1, currentTitle: 'Second video', activeVideos: [] });
  resolveSecond({ taskId: 'task-2', queued: true, queuePosition: 2 });
  await pendingReply;
  assert.equal(element('progress-percent').textContent, '25%');
  assert.equal(element('progress-status').textContent, '正在下载');
  assert.equal(element('queue-toggle').hidden, true);

  emit({ taskId: 'task-1', type: 'progress', percent: 90, activeVideos: [] });
  assert.equal(element('progress-percent').textContent, '25%');
  emit({ taskId: 'task-2', type: 'completed', percent: 100, completedCount: 1 });
  assert.equal(element('progress-status').textContent, '下载完成');
});

test('the expanded queue keeps focus across task starts and moves it after removal', async () => {
  const harness = rendererHarness((_request, index) => ({
    taskId: 'task-' + index, queued: index > 1, queuePosition: index,
  }));
  const { element, emit, cancellations, document } = harness;
  await new Promise(setImmediate);
  await parse(harness, 'https://www.pornhub.com/first');
  await element('download-button').dispatch('click');
  await parse(harness, 'https://www.pornhub.com/second');
  await element('download-button').dispatch('click');
  await element('download-button').dispatch('click');

  assert.equal(element('queue-toggle').hidden, false);
  assert.equal(element('queue-list').hidden, true);
  element('queue-toggle').dispatch('click');
  assert.equal(element('queue-toggle').attributes['aria-expanded'], 'true');
  assert.equal(element('queue-list').hidden, false);
  element('queue-list').querySelectorAll('[data-testid="queue-item"]')[1].querySelector('button').focus();
  emit({ taskId: 'task-1', type: 'completed', completedCount: 3 });
  emit({ taskId: 'task-2', type: 'started' });
  const row = element('queue-list').querySelector('[data-testid="queue-item"]');
  const title = row.querySelector('.queue-row-title');
  const remove = row.querySelector('button');
  assert.match(title.textContent, /Second video/);
  assert.equal(document.activeElement, remove);
  await remove.dispatch('click');
  assert.deepEqual(cancellations, ['task-3']);
  assert.equal(remove.attributes['aria-disabled'], 'false');
  emit({ taskId: 'task-3', type: 'cancelled', message: '已从下载队列移除。' });
  assert.equal(element('queue-toggle').hidden, true);
  assert.equal(element('queue-list').children.length, 0);
  assert.equal(document.activeElement, element('cancel-button'));
});

test('a cancellation reply or error cannot modify the next active task', async () => {
  for (const failure of [false, true]) {
    let finishCancel;
    const harness = rendererHarness((_request, index) => ({
      taskId: `task-${index}`, queued: index > 1, queuePosition: index,
    }), undefined, { cancel: () => new Promise((resolve, reject) => {
      finishCancel = failure ? () => reject(new Error('late error')) : resolve;
    }) });
    const { element, emit, cancellations } = harness;
    await new Promise(setImmediate);
    await parse(harness, 'https://www.pornhub.com/first');
    await element('download-button').dispatch('click');
    await element('download-button').dispatch('click');
    const cancelling = element('cancel-button').dispatch('click');
    assert.equal(element('progress-status').textContent, '正在取消');
    assert.equal(element('cancel-button').hidden, false);
    emit({ taskId: 'task-1', type: 'cancelled' });
    assert.equal(element('progress-status').textContent, '已取消');
    assert.equal(element('cancel-button').hidden, true);
    const card = harness.document.querySelector('.progress-card');
    assert.equal(card.dataset.outcome, 'cancelled');
    emit({ taskId: 'task-2', type: 'started' });
    emit({ taskId: 'task-2', type: 'progress', percent: 50 });
    assert.equal(element('cancel-button').hidden, false);
    assert.equal(card.dataset.outcome, undefined);
    finishCancel();
    await cancelling;
    assert.deepEqual(cancellations, ['task-1']);
    assert.equal(element('progress-status').textContent, '正在下载');
    assert.equal(element('progress-percent').textContent, '50%');
    assert.equal(element('cancel-button').disabled, false);
    assert.doesNotMatch(element('notice-message').textContent, /late error/);
  }
});

const failedSnapshot = (revision, items) => ({
  taskId: 'task-1', revision, title: 'First list', kind: 'playlist',
  directory: 'C:\\Original\\First list', formatId: 'h:720',
  fragmentConcurrency: 4, videoConcurrency: 2,
  items: items.map((item) => ({ title: `Failed ${item.itemIndex}`, error: 'server error', pending: false, ...item })),
});
const failedGroup = (harness) => harness.element('failed-batches').querySelector('[data-testid="failed-batch"]');
const failedCheckbox = (group, index) => group.querySelectorAll('[data-testid="failed-item"]')[index].querySelector('input');
const clickCheckbox = (checkbox, checked) => { checkbox.checked = checked; checkbox.dispatch('change'); };

test('failed batches survive the next queued task and support selection, all, retry, cancellation and removal', async () => {
  const retries = [];
  const harness = rendererHarness((_request, index) => ({ taskId: `task-${index}`, queued: index > 1, queuePosition: index }),
    async (request) => {
      retries.push(request);
      return { taskId: 'retry-1', queued: true, queuePosition: 2,
        failedBatch: failedSnapshot(2, [{ itemIndex: 2, pending: true }, { itemIndex: 3, pending: true }]) };
    });
  await new Promise(setImmediate);
  await parse(harness, 'https://www.pornhub.com/first');
  await harness.element('download-button').dispatch('click');
  await parse(harness, 'https://www.pornhub.com/second');
  await harness.element('download-button').dispatch('click');
  harness.emit({ taskId: 'task-1', type: 'partial', percent: 100, completedCount: 1, failedCount: 2,
    failedBatch: failedSnapshot(1, [{ itemIndex: 2 }, { itemIndex: 3 }]) });
  assert.equal(harness.element('failed-downloads').hidden, false);
  assert.equal(harness.element('progress-status').textContent, '部分完成');
  harness.emit({ taskId: 'task-2', type: 'started' });
  const group = failedGroup(harness);
  assert.match(group.querySelector('.failed-batch-context').textContent, /720p.*Original/);
  assert.equal(group.querySelector('button').disabled, true);
  clickCheckbox(failedCheckbox(group, 0), true);
  assert.equal(group.querySelector('.failed-select-all').querySelector('input').indeterminate, true);
  assert.match(group.querySelector('button').textContent, /（1）/);
  clickCheckbox(group.querySelector('.failed-select-all').querySelector('input'), true);
  assert.ok(failedCheckbox(group, 0).checked && failedCheckbox(group, 1).checked);
  await group.querySelector('button').dispatch('click');
  assert.deepEqual(JSON.parse(JSON.stringify(retries)), [{ taskId: 'task-1', itemIndices: [2, 3] }]);
  assert.equal(failedCheckbox(failedGroup(harness), 0).disabled, true);
  assert.match(failedGroup(harness).querySelector('[data-testid="failed-item"]').querySelector('.failed-item-error').textContent, /队列/);
  harness.emit({ taskId: 'retry-1', type: 'cancelled', failedBatch: failedSnapshot(3, [{ itemIndex: 2 }, { itemIndex: 3 }]) });
  assert.equal(failedCheckbox(failedGroup(harness), 0).disabled, false);
  assert.equal(failedGroup(harness).querySelector('button').disabled, true);
  harness.emit({ taskId: 'task-2', type: 'completed', percent: 100, completedCount: 1 });
  assert.equal(harness.element('failed-downloads').hidden, false);
});

test('older retry replies cannot resurrect successful rows and early terminal events remove completed batches', async () => {
  let resolveSecond;
  let callCount = 0;
  const harness = rendererHarness(() => ({ taskId: 'task-1', queued: false, queuePosition: 1 }),
    async () => ++callCount === 1
      ? { taskId: 'retry-a', queued: false, queuePosition: 1,
        failedBatch: failedSnapshot(2, [{ itemIndex: 2, pending: true }, { itemIndex: 3 }]) }
      : new Promise((resolve) => { resolveSecond = resolve; }));
  await new Promise(setImmediate);
  await parse(harness, 'https://www.pornhub.com/first');
  await harness.element('download-button').dispatch('click');
  harness.emit({ taskId: 'task-1', type: 'failed', failedBatch: failedSnapshot(1, [{ itemIndex: 2 }, { itemIndex: 3 }]) });
  clickCheckbox(failedCheckbox(failedGroup(harness), 0), true);
  await failedGroup(harness).querySelector('button').dispatch('click');
  clickCheckbox(failedCheckbox(failedGroup(harness), 1), true);
  const pending = failedGroup(harness).querySelector('button').dispatch('click');
  harness.emit({ taskId: 'retry-a', type: 'completed', percent: 100, completedCount: 1,
    failedBatch: failedSnapshot(4, [{ itemIndex: 3, pending: true }]) });
  harness.emit({ taskId: 'retry-b', type: 'started' });
  harness.emit({ taskId: 'retry-b', type: 'completed', percent: 100, completedCount: 1,
    failedBatch: failedSnapshot(5, []) });
  resolveSecond({ taskId: 'retry-b', queued: true, queuePosition: 2,
    failedBatch: failedSnapshot(3, [{ itemIndex: 2, pending: true }, { itemIndex: 3, pending: true }]) });
  await pending;
  assert.equal(harness.element('failed-downloads').hidden, true);
  assert.equal(harness.element('failed-batches').children.length, 0);
  assert.equal(harness.element('progress-status').textContent, '下载完成');
});

test('rejected retry submission keeps selected failures available', async () => {
  const harness = rendererHarness(() => ({ taskId: 'task-1', queued: false }),
    async () => { throw new Error('folder missing'); });
  await new Promise(setImmediate);
  await parse(harness, 'https://www.pornhub.com/first');
  await harness.element('download-button').dispatch('click');
  harness.emit({ taskId: 'task-1', type: 'failed', failedBatch: failedSnapshot(1, [{ itemIndex: 2 }]) });
  assert.equal(harness.element('progress-status').textContent, '下载失败');
  clickCheckbox(failedCheckbox(failedGroup(harness), 0), true);
  await failedGroup(harness).querySelector('button').dispatch('click');
  assert.equal(failedCheckbox(failedGroup(harness), 0).checked, true);
  assert.equal(failedCheckbox(failedGroup(harness), 0).disabled, false);
  assert.equal(failedGroup(harness).querySelector('button').disabled, false);
  assert.match(harness.element('notice-message').textContent, /folder missing/);
});

test('download details preserve per-video updates before an IPC reply and when another task starts', async () => {
  let resolveFirst;
  const harness = rendererHarness((_request, index) => index === 1
    ? new Promise((resolve) => { resolveFirst = resolve; })
    : { taskId: 'task-2', queued: true, queuePosition: 2, items: [{ itemIndex: 1, title: 'Queued video' }] },
  undefined, { autoStart: false });
  const { element, emit } = harness;
  const maxAttempts = 3;
  const sendFirst = (type, itemUpdate, details) => emit({ taskId: 'task-1', type, itemUpdate, ...details });
  await new Promise(setImmediate);
  await parse(harness, 'https://www.pornhub.com/first');
  const pending = element('download-button').dispatch('click');
  sendFirst('started', undefined, { percent: 0 });
  sendFirst('progress', { itemIndex: 1, state: 'completed', percent: 100, fileName: 'A [123].mp4' });
  sendFirst('retry', { itemIndex: 2, state: 'retry', error: 'interrupted', attempt: 2, maxAttempts });
  sendFirst('progress', { itemIndex: 3, state: 'failed', error: 'unavailable', attempt: 3, maxAttempts });
  resolveFirst({ taskId: 'task-1', queued: false, items: ['A', 'B', 'C'].map((title, index) => ({ itemIndex: index + 1, title })) });
  await pending;

  const list = element('download-task-list');
  const first = list.querySelector('details');
  const status = first.querySelector('summary').querySelector('.download-task-status');
  first.open = true;
  first.dispatch('toggle');
  const rows = first.querySelector('ul').querySelectorAll('li');
  assert.deepEqual(rows.map((row) => row.querySelector('strong').textContent), ['1. A', '2. B', '3. C']);
  assert.match(rows[0].querySelector('.download-task-status').textContent, /下载完成.*100%/);
  assert.equal(rows[0].querySelector('.download-task-file').textContent, 'A [123].mp4');
  assert.match(rows[1].querySelector('.download-task-status').textContent, /等待重试.*第 2\/3 次尝试/);
  assert.equal(rows[1].querySelector('.download-task-error').textContent, 'interrupted');
  assert.equal(rows[2].querySelector('.download-task-error').textContent, 'unavailable');

  sendFirst('progress', { itemIndex: 2, state: 'downloading', percent: 40,
    speed: '1MiB/s', eta: '00:08', attempt: 2, maxAttempts }, { percent: 65 });
  assert.match(status.textContent, /正在下载.*65%/);
  assert.match(rows[1].querySelector('.download-task-status').textContent, /40%.*1MiB\/s.*00:08/);
  assert.equal(rows[1].querySelector('progress').value, 40);
  assert.equal(rows[1].querySelector('.download-task-error').hidden, true);

  await parse(harness, 'https://www.pornhub.com/second');
  await element('download-button').dispatch('click');
  element('queue-toggle').dispatch('click');
  const queued = element('queue-list').querySelector('[data-testid="queue-item"]').querySelector('details');
  queued.open = true;
  queued.dispatch('toggle');
  assert.equal(queued.querySelector('li').querySelector('strong').textContent, '1. Queued video');
  assert.equal(queued.querySelector('li').querySelector('.download-task-status').textContent, '排队等待');
  queued.querySelector('summary').focus();

  sendFirst('progress', { itemIndex: 2, state: 'completed', percent: 100, attempt: 2, maxAttempts });
  sendFirst('partial', undefined, { percent: 100, completedCount: 2, failedCount: 1 });
  emit({ taskId: 'task-2', type: 'started' });
  assert.equal(list.children.length, 2);
  assert.equal(list.querySelectorAll('details')[1], queued);
  assert.equal(queued.open, true);
  assert.equal(harness.document.activeElement, queued.querySelector('summary'));
  assert.match(status.textContent, /部分完成.*成功 2 条，失败 1 条/);
  assert.match(rows[1].querySelector('.download-task-status').textContent, /下载完成/);
  assert.equal(rows[2].querySelector('.download-task-error').textContent, 'unavailable');
});

test('failed batch updates retain the focused checkbox when its row moves', async () => {
  const harness = rendererHarness((_request, index) => ({
    taskId: `task-${index}`, queued: index > 1, queuePosition: index
  }));
  await new Promise(setImmediate);
  await parse(harness, 'https://www.pornhub.com/first');
  await harness.element('download-button').dispatch('click');
  await parse(harness, 'https://www.pornhub.com/second');
  await harness.element('download-button').dispatch('click');
  const update = (taskId, revision, indices) => harness.emit({ taskId, type: 'failed',
    failedBatch: failedSnapshot(revision, indices.map((itemIndex) => ({ itemIndex }))) });
  update('task-1', 1, [1, 2]);
  const group = failedGroup(harness);
  const checkbox = failedCheckbox(group, 1);
  checkbox.focus();
  group.querySelector('ul').scrollTop = 48;
  update('task-2', 2, [2, 1, 3]);
  assert.equal(failedCheckbox(failedGroup(harness), 0) === checkbox, true);
  assert.equal(harness.document.activeElement === checkbox, true);
  assert.equal(group.querySelector('ul').scrollTop, 48);
});
