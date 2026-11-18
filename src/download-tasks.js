'use strict';

const { mkdir: makeDirectory } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_DOWNLOAD_ATTEMPTS, validateDownloadConcurrency, processDownloadQueue: processQueue } = require('./download-queue');
const { validateDownloadDirectory: validateDirectory } = require('./download-directory');
const { terminateProcessTree: terminateTree } = require('./download-process');
const { formatExpression } = require('./pornhub');

function safeFolderName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '').trim().slice(0, 80) || 'PornGo';
}

function createDownloadTasks({
  getSnapshot, emitDownload, createCookieFile, resolveVideoTitle, downloadOne,
  validateDownloadDirectory = validateDirectory, mkdir = makeDirectory,
  processDownloadQueue = processQueue, terminateProcessTree = terminateTree, createTaskId = randomUUID,
}) {
  let activeDownload = null;
  const pendingDownloads = [];
  const retryableDownloads = new Map();
  let enqueueDownload = Promise.resolve();

  function createTask({ videos, ...settings }) {
    return {
      ...settings, taskId: createTaskId(), videos: videos.map((video) => ({ ...video })),
      cookieFile: null, children: new Set(), cancelled: false, cancelOperations: Promise.resolve(),
      completedCount: 0, failedCount: 0, percent: 0,
    };
  }

  async function runDownloadTask(task) {
    let terminalEvent;
    const settledItems = new Set();
    const failedItems = new Map();
    const activeVideos = new Map();
    const activeVideoSnapshot = () => [...activeVideos.values()].sort((a, b) => a.itemIndex - b.itemIndex);
    try {
      task.cookieFile = await createCookieFile();
      const { failures } = await processDownloadQueue(task.videos, {
        concurrency: task.videoConcurrency,
        isCancelled: () => task.cancelled,
        download: async ({ item, reportProgress }) => {
          await resolveVideoTitle(item.video, task);
          if (task.cancelled) return null;
          reportProgress(0);
          return downloadOne(task, item, reportProgress);
        },
        onProgress: ({ item: { video, index, attempt }, percent, details }) => {
          task.percent = percent;
          activeVideos.set(index, {
            itemIndex: index + 1, title: video.title,
            speed: typeof details.speed === 'string' ? details.speed : activeVideos.get(index)?.speed || '',
            eta: typeof details.eta === 'string' ? details.eta : activeVideos.get(index)?.eta || '',
          });
          emitDownload({
            taskId: task.taskId, type: 'progress', ...details,
            percent, itemIndex: index + 1, itemCount: task.videos.length,
            currentTitle: video.title, attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
            retryCount: details.retryCount, activeVideos: activeVideoSnapshot(),
          });
        },
        onStart: ({ item: { video, index, attempt }, percent, activeCount, retryCount }) => {
          task.percent = percent;
          activeVideos.set(index, { itemIndex: index + 1, title: video.title, speed: '', eta: '' });
          emitDownload({
            taskId: task.taskId, type: 'progress',
            percent, activeCount,
            retryCount,
            itemIndex: index + 1, itemCount: task.videos.length,
            currentTitle: video.title, completedCount: task.completedCount,
            failedCount: task.failedCount, attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
            activeVideos: activeVideoSnapshot(),
          });
        },
        onRetry: ({ item: { video, index, attempt }, error, percent, activeCount, retryCount }) => {
          task.percent = percent;
          activeVideos.delete(index);
          emitDownload({
            taskId: task.taskId, type: 'retry',
            percent, activeCount, retryCount, message: `下载失败，已加入队列末尾等待第 ${attempt} 次尝试：${error}`,
            itemIndex: index + 1, itemCount: task.videos.length,
            currentTitle: video.title, completedCount: task.completedCount,
            failedCount: task.failedCount, attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
            activeVideos: activeVideoSnapshot(),
          });
        },
        onSettled: ({ item: { index }, error, completedCount, failedCount, percent, retryCount }) => {
          settledItems.add(index);
          if (error) failedItems.set(index, String(error));
          activeVideos.delete(index);
          task.completedCount = completedCount;
          task.failedCount = failedCount;
          task.percent = percent;
          emitDownload({ taskId: task.taskId, type: 'progress', percent,
            completedCount, failedCount, activeCount: activeVideos.size,
            retryCount, itemCount: task.videos.length, activeVideos: activeVideoSnapshot() });
        },
      });
      await task.cancelOperations;
      const type = task.cancelled ? 'cancelled'
        : task.failedCount === 0 ? 'completed'
          : task.completedCount === 0 ? 'failed' : 'partial';
      const message = task.cancelled ? '已取消下载。' : failures[0];
      terminalEvent = { taskId: task.taskId, type, message,
        percent: task.cancelled ? task.percent : 100,
        itemCount: task.videos.length, completedCount: task.completedCount,
        failedCount: task.failedCount };
    } catch (error) {
      if (!task.cancelled) {
        task.videos.forEach((_video, index) => {
          if (!settledItems.has(index)) failedItems.set(index, String(error.message || error));
        });
        task.failedCount = failedItems.size;
      }
      terminalEvent = { taskId: task.taskId, type: task.cancelled ? 'cancelled' : 'failed',
        message: String(error.message || error), percent: task.percent,
        itemCount: task.videos.length, completedCount: task.completedCount,
        failedCount: task.failedCount };
    } finally {
      await task.cancelOperations;
      if (task.cookieFile) await task.cookieFile.cleanup().catch(() => {});
      terminalEvent.failedBatch = finishFailedBatch(task, settledItems, failedItems);
      if (activeDownload === task) activeDownload = null;
      emitDownload(terminalEvent);
      pumpDownloadQueue();
    }
  }

  function failedBatchSnapshot(batch) {
    if (!batch) return null;
    return { taskId: batch.taskId, revision: batch.revision, title: batch.title, kind: batch.kind,
      directory: batch.directory, formatId: batch.formatId,
      fragmentConcurrency: batch.fragmentConcurrency, videoConcurrency: batch.videoConcurrency,
      items: [...batch.items.values()].sort((a, b) => a.itemIndex - b.itemIndex)
        .map(({ itemIndex, video, error, pending }) => ({ itemIndex, title: video.title, error, pending })) };
  }

  function finishFailedBatch(task, settledItems, failedItems) {
    let batch = task.retryBatchId ? retryableDownloads.get(task.retryBatchId) : null;
    if (task.retryBatchId && batch) {
      task.originalIndices.forEach((itemIndex, index) => {
        const item = batch.items.get(itemIndex);
        if (!item) return;
        if (settledItems.has(index) && !failedItems.has(index)) batch.items.delete(itemIndex);
        else {
          item.pending = false;
          if (failedItems.has(index)) item.error = failedItems.get(index);
        }
      });
      batch.revision++;
    } else if (failedItems.size) {
      batch = { taskId: task.taskId, revision: 1, kind: task.kind, title: task.title,
        directory: task.directory, format: task.format, formatId: task.formatId,
        fragmentConcurrency: task.fragmentConcurrency, videoConcurrency: task.videoConcurrency,
        items: new Map([...failedItems].map(([index, error]) => [index + 1,
          { itemIndex: index + 1, video: { ...task.videos[index] }, error, pending: false }])) };
      retryableDownloads.set(batch.taskId, batch);
    }
    const snapshot = failedBatchSnapshot(batch);
    if (batch && batch.items.size === 0) retryableDownloads.delete(batch.taskId);
    return snapshot;
  }

  function enqueueTask(task) {
    pendingDownloads.push(task);
    const queuePosition = pendingDownloads.length + (activeDownload ? 1 : 0);
    // Capture pending rows before a fast retry can finish.
    const failedBatch = task.retryBatchId ? failedBatchSnapshot(retryableDownloads.get(task.retryBatchId)) : null;
    pumpDownloadQueue();
    return { taskId: task.taskId, queued: activeDownload !== task, queuePosition, failedBatch };
  }

  function pumpDownloadQueue() {
    if (activeDownload || pendingDownloads.length === 0) return;
    const task = pendingDownloads.shift();
    activeDownload = task;
    emitDownload({ taskId: task.taskId, type: 'started',
      itemCount: task.videos.length, currentTitle: task.title, percent: 0 });
    void runDownloadTask(task);
  }

  async function prepareDownload(request) {
    if (!request || typeof request !== 'object') throw new Error('下载参数无效。');
    const parsed = getSnapshot(request.snapshotId);
    if (!parsed) throw new Error('解析结果已失效，请重新解析这个页面再下载。');
    let directory = await validateDownloadDirectory(request.directory);
    const format = formatExpression(request.formatId);
    const { fragmentConcurrency, videoConcurrency } = validateDownloadConcurrency(
      parsed.kind, request.fragmentConcurrency, request.videoConcurrency);
    if (parsed.kind !== 'video') {
      const folder = `${safeFolderName(parsed.title).slice(0, 60)} [${safeFolderName(parsed.id).slice(0, 32)}]`;
      directory = path.join(directory, folder);
      await mkdir(directory, { recursive: true });
    }
    return enqueueTask(createTask({
      kind: parsed.kind, title: parsed.title, videos: parsed.videos,
      directory, format, formatId: request.formatId, fragmentConcurrency, videoConcurrency,
    }));
  }

  async function prepareRetry(request) {
    const batch = request && retryableDownloads.get(request.taskId);
    const indices = request && request.itemIndices;
    if (!batch || !Array.isArray(indices) || indices.length === 0
        || new Set(indices).size !== indices.length
        || indices.some((index) => !Number.isInteger(index) || !batch.items.has(index) || batch.items.get(index).pending)) {
      throw new Error('请选择尚未重新下载的失败项目。');
    }
    await validateDownloadDirectory(batch.directory);
    const sortedIndices = [...indices].sort((a, b) => a - b);
    const task = createTask({
      kind: batch.kind, title: batch.title, videos: sortedIndices.map((index) => batch.items.get(index).video),
      directory: batch.directory, format: batch.format, formatId: batch.formatId,
      fragmentConcurrency: batch.fragmentConcurrency, videoConcurrency: batch.videoConcurrency,
      retryBatchId: batch.taskId, originalIndices: sortedIndices,
    });
    sortedIndices.forEach((index) => { batch.items.get(index).pending = true; });
    batch.revision++;
    return enqueueTask(task);
  }

  function serializeSubmission(prepare, request) {
    const result = enqueueDownload.then(() => prepare(request));
    enqueueDownload = result.catch(() => {});
    return result;
  }

  function cancelDownload(taskId) {
    if (activeDownload && activeDownload.taskId === taskId) {
      const task = activeDownload;
      if (task.cancelled) return task.cancelOperations;
      task.cancelled = true;
      task.titleAbortController?.abort();
      task.cancelOperations = Promise.allSettled([...task.children].map(terminateProcessTree));
      return task.cancelOperations;
    }
    return removeQueuedDownload(taskId);
  }

  function removeQueuedDownload(taskId) {
    const index = pendingDownloads.findIndex((task) => task.taskId === taskId);
    if (index === -1) return false;
    const [task] = pendingDownloads.splice(index, 1);
    emitDownload({ taskId: task.taskId, type: 'cancelled', percent: 0,
      message: '已从下载队列移除。', itemCount: task.videos.length,
      completedCount: 0, failedCount: 0,
      failedBatch: finishFailedBatch(task, new Set(), new Map()) });
    return true;
  }

  return {
    startDownload: (request) => serializeSubmission(prepareDownload, request),
    retryDownload: (request) => serializeSubmission(prepareRetry, request),
    cancelDownload, removeQueuedDownload,
  };
}

module.exports = { createDownloadTasks };
