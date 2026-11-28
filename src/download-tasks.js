'use strict';

const fsp = require('node:fs/promises');
const { outputTemplate } = require('./download-artifact');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_DOWNLOAD_ATTEMPTS, validateDownloadConcurrency, processDownloadQueue: processQueue } = require('./download-queue');
const { validateDownloadDirectory: validateDirectory } = require('./download-directory');
const { formatExpression } = require('./ytdlp-protocol');

const MAX_PENDING_DOWNLOADS = 20;
const MAX_RETRY_BATCHES = 20;

function safeFolderName(value, maxLength) {
  const name = String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
    .slice(0, maxLength).replace(/[. ]+$/g, '') || 'PornGo';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ? '_' + name : name;
}

function createDownloadTasks({
  getSnapshot, emitDownload: notifyDownload, onBusyChange = () => {}, createCookieFile, resolveVideoTitle, downloadOne,
  validateDownloadDirectory = validateDirectory, mkdir = fsp.mkdir, realpath = fsp.realpath,
  processDownloadQueue = processQueue, cancelRunning, createTaskId = randomUUID,
}) {
  let activeDownload = null;
  let closing = false;
  let activeFinished;
  const pendingDownloads = [];
  const retryableDownloads = new Map();
  let enqueueDownload = Promise.resolve();

  let submissions = 0;
  const isBusy = () => Boolean(activeDownload || pendingDownloads.length);

  function emitDownload(event) {
    try { notifyDownload(event); } catch { /* A closed window cannot receive events. */ }
  }

  function assertOpen() {
    if (closing) throw new Error('应用正在退出。');
  }

  function createTask({ videos, ...settings }) {
    return {
      ...settings, taskId: createTaskId(), videos: videos.map((video) => ({ ...video })),
      cookieFile: null, abortController: new AbortController(), cancelled: false, cancelOperations: Promise.resolve(),
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
          const { signal } = task.abortController;
          if (signal.aborted) return null;
          try {
            await resolveVideoTitle(item.video, { signal });
          } catch (error) {
            if (signal.aborted) return null;
            throw error;
          }
          if (signal.aborted) return null;
          reportProgress();
          if (task.videoConcurrency === 1) return downloadOne(task, item, reportProgress);
          const file = path.join(path.dirname(task.cookieFile.file), randomUUID() + '.txt');
          try {
            await fsp.copyFile(task.cookieFile.file, file, fsp.constants.COPYFILE_EXCL);
            if (signal.aborted) return null;
            return await downloadOne({ ...task, cookieFile: { file } }, item, reportProgress);
          } finally {
            await fsp.rm(file, { force: true });
          }
        },
        onProgress: ({ item: { video, index, attempt }, percent, itemPercent, details }) => {
          task.percent = percent;
          const previous = activeVideos.get(index);
          const activeVideo = {
            itemIndex: index + 1, title: video.title,
            speed: details.speed ?? previous?.speed ?? '', eta: details.eta ?? previous?.eta ?? '',
            percent: itemPercent ?? previous?.percent,
          };
          activeVideos.set(index, activeVideo);
          emitDownload({
            taskId: task.taskId, type: 'progress', ...details,
            percent, itemIndex: index + 1, itemCount: task.videos.length,
            currentTitle: video.title, attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
            retryCount: details.retryCount, activeVideos: activeVideoSnapshot(),
            itemUpdate: { ...activeVideo, state: 'downloading', attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS },
          });
        },
        onStart: ({ item: { video, index, attempt }, percent, activeCount, retryCount }) => {
          task.percent = percent;
          const activeVideo = { itemIndex: index + 1, title: video.title, speed: '', eta: '' };
          activeVideos.set(index, activeVideo);
          emitDownload({
            taskId: task.taskId, type: 'progress',
            percent, activeCount,
            retryCount,
            itemIndex: index + 1, itemCount: task.videos.length,
            currentTitle: video.title, completedCount: task.completedCount,
            failedCount: task.failedCount, attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
            activeVideos: activeVideoSnapshot(),
            itemUpdate: { ...activeVideo, state: 'downloading', attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS },
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
            itemUpdate: { itemIndex: index + 1, title: video.title, state: 'retry',
              error: String(error), attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS },
          });
        },
        onSettled: ({ item: { index, attempt }, error, completedCount, failedCount, percent, retryCount }) => {
          settledItems.add(index);
          if (error) failedItems.set(index, String(error));
          const previous = activeVideos.get(index);
          activeVideos.delete(index);
          task.completedCount = completedCount;
          task.failedCount = failedCount;
          task.percent = percent;
          emitDownload({ taskId: task.taskId, type: 'progress', percent,
            completedCount, failedCount, activeCount: activeVideos.size,
            retryCount, itemCount: task.videos.length, activeVideos: activeVideoSnapshot(),
            itemUpdate: { itemIndex: index + 1, title: task.videos[index].title,
              state: error ? 'failed' : 'completed', error: error ? String(error) : '',
              percent: error ? previous?.percent : 100, attempt, maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
              fileName: task.videos[index].downloadFileName } });
        },
      });
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
      try {
        await task.cancelOperations;
      } finally {
        try {
          if (task.cookieFile) {
            try { await task.cookieFile.cleanup(); } catch { /* Retry cleanup on exit. */ }
          }
          terminalEvent.failedBatch = finishFailedBatch(task, settledItems, failedItems);
          emitDownload(terminalEvent);
        } finally {
          if (activeDownload === task) activeDownload = null;
          pumpDownloadQueue();
          onBusyChange();
        }
      }
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

    }
    const snapshot = failedBatchSnapshot(batch);
    if (batch) {
      retryableDownloads.delete(batch.taskId);
      if (batch.items.size) retryableDownloads.set(batch.taskId, batch);
      const idle = [...retryableDownloads.values()].filter((entry) =>
        ![...entry.items.values()].some((item) => item.pending));
      for (const entry of idle.slice(0, Math.max(0, idle.length - MAX_RETRY_BATCHES))) {
        retryableDownloads.delete(entry.taskId);
      }
    }
    return snapshot;
  }

  function enqueueTask(task) {
    pendingDownloads.push(task);
    const queuePosition = pendingDownloads.length + (activeDownload ? 1 : 0);
    // Capture pending rows before a fast retry can finish.
    const failedBatch = task.retryBatchId ? failedBatchSnapshot(retryableDownloads.get(task.retryBatchId)) : null;
    const items = task.videos.map((video, index) => ({ itemIndex: index + 1, title: video.title }));
    pumpDownloadQueue();
    return { taskId: task.taskId, queued: activeDownload !== task, queuePosition, failedBatch, items };
  }

  function pumpDownloadQueue() {
    if (closing || activeDownload || pendingDownloads.length === 0) return;
    const task = pendingDownloads.shift();
    activeDownload = task;
    emitDownload({ taskId: task.taskId, type: 'started',
      itemCount: task.videos.length, currentTitle: task.title, percent: 0 });
    activeFinished = runDownloadTask(task);
    activeFinished.catch(() => {});
    onBusyChange();
  }

  async function prepareDownload(request) {
    if (!request || typeof request !== 'object') throw new Error('下载参数无效。');
    const parsed = getSnapshot(request.snapshotId);
    if (!parsed) throw new Error('解析结果已失效，请重新解析这个页面再下载。');
    let videos = parsed.videos;
    if (request.itemIndices !== undefined) {
      const indices = request.itemIndices;
      if (parsed.kind !== 'pornstar' || !Array.isArray(indices) || !indices.length || indices.length > videos.length) {
        throw new Error('请选择当前明星页面中的有效视频。');
      }
      const selected = new Set(indices);
      if (selected.size !== indices.length || [...selected].some((index) =>
        !Number.isInteger(index) || index < 1 || index > videos.length)) {
        throw new Error('请选择当前明星页面中的有效视频。');
      }
      videos = videos.filter((_video, index) => selected.has(index + 1));
    }
    let directory = await validateDownloadDirectory(request.directory);
    assertOpen();
    const format = formatExpression(request.formatId);
    const { fragmentConcurrency, videoConcurrency } = validateDownloadConcurrency(
      parsed.kind, request.fragmentConcurrency, request.videoConcurrency);
    if (parsed.kind !== 'video') {
      const folder = `${safeFolderName(parsed.title, 60)} [${safeFolderName(parsed.id, 32)}]`;
      const base = await realpath(directory);
      const batchDir = path.join(base, folder);
      for (const video of videos) outputTemplate(batchDir, video.url);
      await mkdir(batchDir, { recursive: true });
      directory = await realpath(batchDir);
      if (path.relative(base, path.dirname(directory)) !== '') {
        throw new Error('批次文件夹位于所选保存目录之外，请重新选择目录。');
      }
      assertOpen();
    }
    for (const video of videos) outputTemplate(directory, video.url);
    return enqueueTask(createTask({
      kind: parsed.kind, title: parsed.title, videos,
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
    if (batch.kind !== 'video' && path.relative(batch.directory, await realpath(batch.directory)) !== '') {
      throw new Error('批次文件夹的位置已变化，请重新选择目录。');
    }
    assertOpen();
    if (retryableDownloads.get(batch.taskId) !== batch) throw new Error('失败项目已失效。');
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
    if (closing) return Promise.reject(new Error('应用正在退出。'));
    if (pendingDownloads.length + submissions >= MAX_PENDING_DOWNLOADS) {
      return Promise.reject(new Error('下载队列已满，请稍后再试。'));
    }
    submissions++;
    const result = enqueueDownload.then(() => {
      assertOpen();
      return prepare(request);
    }).finally(() => { submissions--; });
    enqueueDownload = result.catch(() => {});
    return result;
  }

  function cancelDownload(taskId) {
    if (activeDownload && activeDownload.taskId === taskId) {
      const task = activeDownload;
      if (task.cancelled) return task.cancelOperations;
      task.cancelled = true;
      task.abortController.abort();
      try {
        task.cancelOperations = Promise.resolve(cancelRunning(task.taskId));
      } catch (error) {
        task.cancelOperations = Promise.reject(error);
      }
      task.cancelOperations.catch(() => {});
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
    cancelDownload, removeQueuedDownload, isBusy,
    async close() {
      closing = true;
      if (activeDownload) cancelDownload(activeDownload.taskId);
      await enqueueDownload;
      pendingDownloads.length = 0;
      await activeFinished;
    },
  };
}

module.exports = { createDownloadTasks };
