'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FRAGMENT_CONCURRENCY, VIDEO_CONCURRENCY,
  validateConcurrency, validateDownloadConcurrency, processDownloadQueue } = require('../src/download-queue');

test('failed videos move behind untouched videos and keep their original index', async () => {
  const started = [];
  const retried = [];
  const settled = [];
  const result = await processDownloadQueue(['first', 'second', 'third'], {
    download: async ({ item }) => {
      started.push([item.video, item.index, item.attempt]);
      return item.video === 'first' && item.attempt === 1 ? 'temporary error' : null;
    },
    onRetry: ({ item }) => retried.push([item.video, item.attempt]),
    onSettled: ({ item, error, completedCount, failedCount }) =>
      settled.push([item.video, error, completedCount, failedCount]),
  });

  assert.deepEqual(started, [
    ['first', 0, 1], ['second', 1, 1], ['third', 2, 1], ['first', 0, 2],
  ]);
  assert.deepEqual(retried, [['first', 2]]);
  assert.deepEqual(settled, [
    ['second', null, 1, 0], ['third', null, 2, 0], ['first', null, 3, 0],
  ]);
  assert.deepEqual(result, { completedCount: 3, failedCount: 0, failures: [] });
});

test('permanent failures stop after three attempts and count once', async () => {
  const attempts = [];
  const result = await processDownloadQueue(['broken'], {
    download: async ({ item }) => {
      attempts.push(item.attempt);
      return 'server rejected download';
    },
  });

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(result, {
    completedCount: 0, failedCount: 1, failures: ['server rejected download'],
  });
});

test('concurrency settings accept only offered values', () => {
  assert.deepEqual(FRAGMENT_CONCURRENCY, [1, 4]);
  assert.deepEqual(VIDEO_CONCURRENCY, [1, 2]);
  assert.equal(validateConcurrency(4, FRAGMENT_CONCURRENCY, '分片并发数'), 4);
  assert.throws(() => validateConcurrency(100, FRAGMENT_CONCURRENCY, '分片并发数'), /参数无效/);
  assert.throws(() => validateConcurrency('2', VIDEO_CONCURRENCY, '同时下载视频数'), /参数无效/);
  assert.deepEqual(validateDownloadConcurrency('playlist', 4, 2),
    { fragmentConcurrency: 4, videoConcurrency: 2 });
  assert.deepEqual(validateDownloadConcurrency('video', 4, 1),
    { fragmentConcurrency: 4, videoConcurrency: 1 });
  assert.throws(() => validateDownloadConcurrency('video', 4, 2), /单视频仅可同时下载 1 条/);
});

test('two workers keep the concurrency limit and retries behind untouched entries', async () => {
  const started = [];
  const waiting = [];
  let active = 0;
  let peak = 0;
  const running = processDownloadQueue(['first', 'second', 'third'], {
    concurrency: 2,
    onStart: ({ item }) => started.push(`${item.video}:${item.attempt}`),
    download: async ({ item }) => {
      active++;
      peak = Math.max(peak, active);
      const error = await new Promise((resolve) => waiting.push({ item, resolve }));
      active--;
      return error;
    },
  });
  assert.deepEqual(started, ['first:1', 'second:1']);
  waiting.shift().resolve('temporary');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first:1', 'second:1', 'third:1']);
  waiting.find(({ item }) => item.video === 'second').resolve(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first:1', 'second:1', 'third:1', 'first:2']);
  waiting.find(({ item }) => item.video === 'third').resolve(null);
  waiting.find(({ item }) => item.video === 'first' && item.attempt === 2).resolve(null);
  assert.deepEqual(await running, { completedCount: 3, failedCount: 0, failures: [] });
  assert.equal(peak, 2);
});

test('cancellation starts no retries and waits for all active workers', async () => {
  for (const options of [{}, { concurrency: 2 }]) {
    const workerCount = options.concurrency ?? 1;
    let cancelled = false;
    const waiting = [];
    const started = [];
    const running = processDownloadQueue(['first', 'second', 'third'], {
      ...options,
      isCancelled: () => cancelled,
      onStart: ({ item }) => started.push(item.video),
      download: () => new Promise((resolve) => waiting.push(resolve)),
    });
    cancelled = true;
    for (const finish of waiting.slice(0, -1)) finish('interrupted');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['first', 'second'].slice(0, workerCount));
    let done = false;
    running.then(() => { done = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false);
    waiting.at(-1)('interrupted');
    assert.deepEqual(await running, { completedCount: 0, failedCount: 0, failures: [] });
  }
});

test('aggregate progress is monotonic while concurrent attempts and retries complete', async () => {
  const percents = [];
  const result = await processDownloadQueue(['first', 'second'], {
    concurrency: 2,
    onStart: ({ percent }) => percents.push(percent),
    onRetry: ({ percent }) => percents.push(percent),
    onSettled: ({ percent }) => percents.push(percent),
    onProgress: ({ percent }) => percents.push(percent),
    download: async ({ item, reportProgress }) => {
      reportProgress(30);
      reportProgress(90);
      return item.video === 'first' && item.attempt === 1 ? 'temporary' : null;
    },
  });
  assert.ok(percents.every((percent, index) => index === 0 || percent >= percents[index - 1]));
  assert.ok(percents.every((percent) => percent < 100));
  assert.deepEqual(result, { completedCount: 2, failedCount: 0, failures: [] });
});

test('queue reports progress and settlement to its callbacks in order', async () => {
  const events = [];
  await processDownloadQueue(['video', 'another'], {
    onStart: ({ activeCount }) => events.push(['start', activeCount]),
    download: ({ item, reportProgress }) => {
      if (item.index === 0) {
        reportProgress();
        reportProgress(50, { speed: '1MiB/s' });
      }
      return null;
    },
    onProgress: ({ percent, itemPercent, details: { speed, activeCount, itemCount } }) =>
      events.push(['progress', percent, itemPercent, speed, activeCount, itemCount]),
    onSettled: ({ completedCount, failedCount, activeCount }) =>
      events.push(['settled', completedCount, failedCount, activeCount]),
  });
  assert.deepEqual(events, [
    ['start', 1],
    ['progress', 0, undefined, undefined, 1, 2],
    ['progress', 25, 50, '1MiB/s', 1, 2],
    ['settled', 1, 0, 0],
    ['start', 1],
    ['settled', 2, 0, 0],
  ]);
});

test('queue callbacks expose retries waiting behind active videos', async () => {
  const starts = [];
  const retries = [];
  const result = await processDownloadQueue(['first', 'second'], {
    concurrency: 2,
    onStart: ({ item, retryCount }) => starts.push([item.video, item.attempt, retryCount]),
    onRetry: ({ item, retryCount }) => retries.push([item.video, item.attempt, retryCount]),
    download: async ({ item }) => item.video === 'first' && item.attempt === 1 ? 'temporary' : null,
  });

  assert.deepEqual(result, { completedCount: 2, failedCount: 0, failures: [] });
  assert.deepEqual(starts, [['first', 1, 0], ['second', 1, 0], ['first', 2, 0]]);
  assert.deepEqual(retries, [['first', 2, 1]]);
});

test('permanent returned and thrown errors settle once and allow later videos to finish', async () => {
  const attempts = [];
  const result = await processDownloadQueue(['private', 'missing executable', 'ok'], {
    download: async ({ item }) => {
      attempts.push(item.attempt);
      if (item.index === 0) return { message: 'private', retryable: false };
      if (item.index === 1) throw Object.assign(new Error('missing executable'), { code: 'ENOENT' });
    },
    onRetry: () => assert.fail('unexpected retry'),
  });
  assert.deepEqual(attempts, [1, 1, 1]);
  assert.deepEqual(result, { completedCount: 1, failedCount: 2, failures: ['private', 'missing executable'] });
});
