// @ts-check
(() => {
  'use strict';

  const kindNames = { video: '单视频', playlist: '片单', pornstar: '色情明星视频' };
  const downloadStates = {
    queued: '排队等待', downloading: '正在下载', retry: '等待重试', cancelling: '正在取消',
    completed: '下载完成', partial: '部分完成', failed: '下载失败', cancelled: '已取消',
  };
  const terminalDownloadStates = ['completed', 'partial', 'failed', 'cancelled'];

  /** @param {unknown} seconds */
  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '';
    const minutes = Math.floor(value / 60);
    const remaining = Math.floor(value % 60);
    const hours = Math.floor(minutes / 60);
    if (hours) return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
    return `${minutes}:${String(remaining).padStart(2, '0')}`;
  }

  /** @param {unknown} value */
  function safeThumbnailUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:') return '';
      if (host !== 'pornhub.com' && !host.endsWith('.pornhub.com') && host !== 'phncdn.com' && !host.endsWith('.phncdn.com')) return '';
      return url.href;
    } catch {
      return '';
    }
  }

  /** @param {{completedCount?: unknown, failedCount?: unknown} | null | undefined} event */
  function batchCounts(event) {
    const completed = Number(event && event.completedCount);
    const failed = Number(event && event.failedCount);
    if (!Number.isInteger(completed) || completed < 0 || !Number.isInteger(failed) || failed < 0) return '';
    return `成功 ${completed} 条，失败 ${failed} 条`;
  }

  /** @param {unknown} error */
  function errorMessage(error) {
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '');
    }
    if (typeof error === 'string' && error.trim()) return error;
    return '操作失败，请稍后重试。';
  }

  /** @param {unknown} formatId */
  function formatQuality(formatId) {
    if (formatId === 'best') return '最佳可用画质';
    if (typeof formatId !== 'string') return '';
    return formatId.startsWith('h:') ? formatId.slice(2) + 'p 及以下' : formatId;
  }

  /** @returns {(revision?: number) => boolean} */
  function createRevisionGuard() {
    let latest = -1;
    return (revision) => {
      if (revision === undefined || !Number.isInteger(revision)) return true;
      if (revision < latest) return false;
      latest = revision;
      return true;
    };
  }

  const helpers = { formatDuration, safeThumbnailUrl, formatQuality, batchCounts, errorMessage, kindNames, downloadStates, terminalDownloadStates, createRevisionGuard };
  if (typeof window !== 'undefined') {
    const host = /** @type {Window & {PornGoRenderer?: Partial<typeof helpers>}} */ (window);
    Object.assign(host.PornGoRenderer ||= {}, helpers);
  }
  if (typeof module === 'object' && module.exports) module.exports = helpers;
})();
