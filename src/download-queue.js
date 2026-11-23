'use strict';

const MAX_DOWNLOAD_ATTEMPTS = 3;
const FRAGMENT_CONCURRENCY = [1, 4];
const VIDEO_CONCURRENCY = [1, 2];

function validateConcurrency(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label}参数无效。`);
  return value;
}

function validateDownloadConcurrency(kind, fragmentConcurrency, videoConcurrency) {
  const fragments = validateConcurrency(fragmentConcurrency, FRAGMENT_CONCURRENCY, '分片并发数');
  const videos = validateConcurrency(videoConcurrency, VIDEO_CONCURRENCY, '同时下载视频数');
  if (kind === 'video' && videos !== 1) throw new Error('单视频仅可同时下载 1 条。');
  return { fragmentConcurrency: fragments, videoConcurrency: videos };
}

function queueProgressPercent(finishedAttempts, plannedAttempts, activeProgress) {
  if (!plannedAttempts) return 0;
  const active = [...activeProgress.values()].reduce((sum, value) => sum + Math.min(90, value) / 100, 0);
  return Math.min(99, (finishedAttempts + active) / plannedAttempts * 100);
}

async function processDownloadQueue(videos, {
  download, onStart = () => {}, onRetry = () => {}, onSettled = () => {},
  onProgress = () => {}, isCancelled = () => false, concurrency = 1,
}) {
  validateConcurrency(concurrency, VIDEO_CONCURRENCY, '同时下载视频数');
  const queue = videos.map((video, index) => ({ video, index, attempt: 1 }));
  const activeProgress = new Map();
  let completedCount = 0;
  let failedCount = 0;
  let finishedAttempts = 0;
  let plannedAttempts = queue.length;
  const failures = [];
  let peakPercent = 0;
  let retryCount = 0;

  const progress = () => {
    // Adding a retry increases the denominator. Keep visible progress steady.
    peakPercent = Math.max(peakPercent, queueProgressPercent(finishedAttempts, plannedAttempts, activeProgress));
    return peakPercent;
  };
  const worker = async () => {
    while (queue.length && !isCancelled()) {
      const item = queue.shift();
      if (item.attempt > 1) retryCount--;
      const key = `${item.index}:${item.attempt}`;
      activeProgress.set(key, 0);
      onStart({ item, finishedAttempts, plannedAttempts, percent: progress(),
        activeCount: activeProgress.size, retryCount });
      const reportProgress = (percent, details = {}) => {
        if (isCancelled()) return;
        const bounded = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
        activeProgress.set(key, Math.max(activeProgress.get(key) || 0, bounded));
        onProgress({ item, percent: progress(), itemPercent: Number.isFinite(percent) ? activeProgress.get(key) : undefined,
          details: { ...details, completedCount, failedCount,
          activeCount: activeProgress.size, itemCount: videos.length, retryCount } });
      };
      let error;
      try {
        error = await download({ item, finishedAttempts, plannedAttempts, reportProgress });
      } catch (caught) {
        error = String(caught && (caught.message || caught));
      }
      activeProgress.delete(key);
      if (isCancelled()) break;
      finishedAttempts++;

      if (error && item.attempt < MAX_DOWNLOAD_ATTEMPTS) {
        const retry = { ...item, attempt: item.attempt + 1 };
        queue.push(retry);
        retryCount++;
        plannedAttempts++;
        onRetry({ item: retry, error, finishedAttempts, plannedAttempts, percent: progress(),
          activeCount: activeProgress.size, retryCount });
        continue;
      }

      if (error) {
        failedCount++;
        if (failures.length < 3) failures.push(error);
      } else {
        completedCount++;
      }
      onSettled({ item, error, completedCount, failedCount,
        finishedAttempts, plannedAttempts, percent: progress(), activeCount: activeProgress.size,
        retryCount });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { completedCount, failedCount, failures };
}

module.exports = {
  MAX_DOWNLOAD_ATTEMPTS, FRAGMENT_CONCURRENCY, VIDEO_CONCURRENCY,
  validateConcurrency, validateDownloadConcurrency, queueProgressPercent, processDownloadQueue,
};
