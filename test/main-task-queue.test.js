
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDownloadTasks } = require('../src/download-tasks');

function mainQueueHarness(overrides = {}) {
  const runs = [];
  const events = [];
  const parsedResources = new Map([
    ['snapshot-a', { kind: 'video', title: 'A', videos: [{ url: 'https://example.test/a', title: 'A' }] }],
    ['snapshot-b', { kind: 'video', title: 'B', videos: [{ url: 'https://example.test/b', title: 'B' }] }],
  ]);
  let nextId = 0;
  const tasks = createDownloadTasks({
    getSnapshot: (id) => parsedResources.get(id),
    validateDownloadDirectory: async (directory) => directory,
    mkdir: async () => {},
    createCookieFile: async () => ({ file: 'cookie-file', cleanup: async () => {} }),
    processDownloadQueue: (videos, callbacks) => new Promise((resolve) => { runs.push({ resolve, callbacks, videos }); }),
    downloadOne: (task) => Promise.resolve(task),
    resolveVideoTitle: async () => {},
    terminateProcessTree: async () => {},
    emitDownload: (event) => events.push(event),
    createTaskId: () => 'task-' + ++nextId,
    ...overrides,
  });
  return { ...tasks, runs, events, parsedResources };
}

const request = (snapshotId) => ({
  snapshotId, directory: 'C:\\Downloads', formatId: 'best',
  fragmentConcurrency: 1, videoConcurrency: 1,
});
const flush = () => new Promise(setImmediate);

test('main process queues a parsed resource and retains it after its snapshot is evicted', async () => {
  const queue = mainQueueHarness();
  const first = await queue.startDownload(request('snapshot-a'));
  const second = await queue.startDownload(request('snapshot-b'));
  await flush();
  assert.equal(first.queued, false);
  assert.equal(second.queued, true);
  assert.equal(second.queuePosition, 2);
  assert.equal(queue.runs.length, 1);
  queue.parsedResources.delete('snapshot-b');
  await assert.rejects(queue.startDownload(request('snapshot-b')), /解析结果已失效.*重新解析/);

  queue.runs[0].resolve({ failures: [] });
  await flush();
  assert.equal(queue.runs.length, 2);
  assert.equal(queue.runs[1].videos[0].title, 'B');
  assert.deepEqual(queue.events.filter((event) => ['started', 'completed'].includes(event.type))
    .map((event) => [event.taskId, event.type]), [
      ['task-1', 'started'], ['task-1', 'completed'], ['task-2', 'started'],
    ]);
  queue.runs[1].resolve({ failures: [] });
  await flush();
  assert.equal(queue.events.at(-1).taskId, 'task-2');
  assert.equal(queue.events.at(-1).type, 'completed');
});

test('cancellation while resolving a batch video title prevents starting the download process', async () => {
  let finishTitle;
  let spawned = false;
  let downloadTask;
  const queue = mainQueueHarness({
    resolveVideoTitle: (_video, task) => {
      downloadTask = task;
      return new Promise((resolve) => { finishTitle = resolve; });
    },
    downloadOne: () => { spawned = true; },
  });
  const first = await queue.startDownload(request('snapshot-a'));
  await flush();
  const pending = queue.runs[0].callbacks.download({ item: { video: {} }, reportProgress() {} });
  const abortController = new AbortController();
  downloadTask.titleAbortController = abortController;
  await queue.cancelDownload(first.taskId);
  assert.equal(abortController.signal.aborted, true);
  finishTitle();
  assert.equal(await pending, null);
  assert.equal(spawned, false);
  queue.runs[0].resolve({ failures: [] });
  await flush();
});

test('failure and cancellation of the active task still start the next queued URL', async () => {
  for (const terminalType of ['failed', 'cancelled']) {
    const queue = mainQueueHarness();
    const first = await queue.startDownload(request('snapshot-a'));
    const second = await queue.startDownload(request('snapshot-b'));
    await flush();
    if (terminalType === 'cancelled') await queue.cancelDownload(first.taskId);
    else {
      queue.runs[0].callbacks.onSettled({
        item: { index: 0 }, completedCount: 0, failedCount: 1, percent: 99,
      });
      queue.runs[0].resolve({ failures: ['failure'] });
    }
    if (terminalType === 'cancelled') queue.runs[0].resolve({ failures: [] });
    await flush();
    assert.equal(queue.runs.length, 2);
    const firstTerminal = queue.events.find((event) =>
      event.taskId === first.taskId && ['failed', 'cancelled', 'completed'].includes(event.type));
    assert.equal(firstTerminal.type, terminalType);
    assert.ok(queue.events.some((event) => event.taskId === second.taskId && event.type === 'started'));
    queue.runs[1].resolve({ failures: [] });
    await flush();
  }
});

test('queue removal accepts a waiting task and refuses the active task', async () => {
  const queue = mainQueueHarness();
  const first = await queue.startDownload(request('snapshot-a'));
  const second = await queue.startDownload(request('snapshot-b'));
  assert.equal(await queue.removeQueuedDownload(first.taskId), false);
  assert.equal(queue.events.filter((event) => event.taskId === first.taskId && event.type === 'cancelled').length, 0);
  assert.equal(await queue.removeQueuedDownload(second.taskId), true);
  assert.ok(queue.events.some((event) => event.taskId === second.taskId && event.type === 'cancelled'));
  queue.runs[0].resolve({ failures: [] });
  await flush();
  assert.equal(queue.runs.length, 1);
});

function settleRun(run, outcomes) {
  let completedCount = 0;
  let failedCount = 0;
  const failures = [];
  outcomes.forEach((error, index) => {
    if (error) { failedCount++; failures.push(error); }
    else completedCount++;
    run.callbacks.onSettled({ item: { index }, error, completedCount, failedCount, percent: 99 });
  });
  run.resolve({ failures: failures.slice(0, 3) });
}

test('all final failures retain their original settings and retry only selected videos after cache changes', async () => {
  const queue = mainQueueHarness();
  const snapshotId = 'snapshot-a';
  queue.parsedResources.set(snapshotId, { kind: 'playlist', id: 'original', title: 'Original list', videos: Array.from({ length: 5 }, (_, index) =>
    ({ url: `https://example.test/video-${index}`, title: `Video ${index}` })) });
  const original = await queue.startDownload({ ...request(snapshotId), formatId: 'h:720', fragmentConcurrency: 4, videoConcurrency: 2 });
  await flush();
  settleRun(queue.runs[0], [null, 'error 1', 'error 2', 'error 3', 'error 4']);
  await flush();
  const terminal = queue.events.at(-1);
  assert.equal(terminal.type, 'partial');
  assert.equal(terminal.message, 'error 1');
  assert.equal(terminal.completedCount, 1);
  assert.equal(terminal.failedCount, 4);
  const failed = terminal.failedBatch;
  assert.deepEqual(Array.from(failed.items, (item) => item.itemIndex), [2, 3, 4, 5]);
  assert.equal(failed.items[3].error, 'error 4');
  queue.parsedResources.clear();
  const retry = await queue.retryDownload({ taskId: original.taskId, itemIndices: [5, 2], directory: 'wrong', formatId: 'best' });
  await flush();
  assert.deepEqual(Array.from(queue.runs[1].videos, (video) => video.url), ['https://example.test/video-1', 'https://example.test/video-4']);
  const retryTask = await queue.runs[1].callbacks.download({ item: {}, reportProgress() {} });
  assert.equal(retryTask.directory, path.join('C:\\Downloads', 'Original list [original]'));
  assert.match(retryTask.format, /height<=720/);
  assert.equal(retryTask.fragmentConcurrency, 4);
  assert.equal(retryTask.videoConcurrency, 2);
  assert.deepEqual(Array.from(retry.failedBatch.items.filter((item) => item.pending), (item) => item.itemIndex), [2, 5]);
  await assert.rejects(queue.retryDownload({ taskId: original.taskId, itemIndices: [2] }), /请选择/);
  await assert.rejects(queue.retryDownload({ taskId: original.taskId, itemIndices: [1] }), /请选择/);
  await assert.rejects(queue.retryDownload({ taskId: original.taskId, itemIndices: [3, 3] }), /请选择/);
  settleRun(queue.runs[1], [null, 'new error 4']);
  await flush();
  const updated = queue.events.at(-1).failedBatch;
  assert.deepEqual(Array.from(updated.items, (item) => item.itemIndex), [3, 4, 5]);
  assert.equal(updated.items[2].error, 'new error 4');
  assert.ok(updated.items.every((item) => !item.pending));
});

test('cancelling retries restores original failure rows without listing interrupted videos as new failures', async () => {
  const queue = mainQueueHarness();
  const first = await queue.startDownload(request('snapshot-a'));
  await flush();
  settleRun(queue.runs[0], ['original failure']);
  await flush();
  await queue.startDownload(request('snapshot-b'));
  const waitingRetry = await queue.retryDownload({ taskId: first.taskId, itemIndices: [1] });
  await queue.cancelDownload(waitingRetry.taskId);
  assert.equal(queue.events.at(-1).failedBatch.items[0].pending, false);
  assert.equal(queue.events.at(-1).failedBatch.items[0].error, 'original failure');
  const queuedRetry = await queue.retryDownload({ taskId: first.taskId, itemIndices: [1] });
  settleRun(queue.runs[1], [null]);
  await flush();
  await queue.cancelDownload(queuedRetry.taskId);
  queue.runs[2].resolve({ failures: [] });
  await flush();
  assert.equal(queue.events.at(-1).type, 'cancelled');
  assert.equal(queue.events.at(-1).failedBatch.items[0].pending, false);
  const finalRetry = await queue.retryDownload({ taskId: first.taskId, itemIndices: [1] });
  await flush();
  settleRun(queue.runs[3], [null]);
  await flush();
  assert.equal(queue.events.at(-1).failedBatch.items.length, 0);
  await assert.rejects(queue.retryDownload({ taskId: first.taskId, itemIndices: [1] }), /请选择/);
  assert.ok(finalRetry.taskId);
});

test('setup failures expose every unsuccessful video and cancelled tasks expose no interrupted items', async () => {
  const queue = mainQueueHarness({ createCookieFile: async () => { throw new Error('cookie unavailable'); } });
  queue.parsedResources.get('snapshot-a').videos.push({ title: 'Other', url: 'https://example.test/other' });
  await queue.startDownload(request('snapshot-a'));
  await flush();
  const terminal = queue.events.at(-1);
  assert.equal(terminal.type, 'failed');
  assert.equal(terminal.failedCount, 2);
  assert.equal(terminal.failedBatch.items.length, 2);

  const cancelled = mainQueueHarness();
  const task = await cancelled.startDownload(request('snapshot-a'));
  await flush();
  await cancelled.cancelDownload(task.taskId);
  cancelled.runs[0].resolve({ failures: [] });
  await flush();
  assert.equal(cancelled.events.at(-1).failedBatch, null);
});

test('disjoint retries produce increasing revisions when an earlier retry finishes before the next reply arrives', async () => {
  const queue = mainQueueHarness();
  queue.parsedResources.get('snapshot-a').videos.push({ title: 'Other', url: 'https://example.test/other' });
  const original = await queue.startDownload(request('snapshot-a'));
  await flush();
  settleRun(queue.runs[0], ['failure 1', 'failure 2']);
  await flush();
  assert.equal(queue.events.at(-1).failedBatch.revision, 1);
  const firstRetry = await queue.retryDownload({ taskId: original.taskId, itemIndices: [1] });
  const lateReply = await queue.retryDownload({ taskId: original.taskId, itemIndices: [2] });
  assert.equal(firstRetry.failedBatch.revision, 2);
  assert.equal(lateReply.failedBatch.revision, 3);
  settleRun(queue.runs[1], [null]);
  await flush();
  const completed = queue.events.find((event) => event.taskId === firstRetry.taskId && event.type === 'completed');
  assert.equal(completed.failedBatch.revision, 4);
  assert.deepEqual(Array.from(completed.failedBatch.items, (item) => item.itemIndex), [2]);
  assert.equal(completed.failedBatch.items[0].pending, true);
  // The earlier IPC reply remains a detached version-3 snapshot, so the renderer can reject it.
  assert.deepEqual(Array.from(lateReply.failedBatch.items, (item) => item.itemIndex), [1, 2]);
  settleRun(queue.runs[2], [null]);
  await flush();
  assert.equal(queue.events.at(-1).failedBatch.revision, 5);
  assert.equal(queue.events.at(-1).failedBatch.items.length, 0);
});

