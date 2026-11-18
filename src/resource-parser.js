'use strict';

const { randomUUID } = require('node:crypto');
const { parsePlaylist } = require('./playlist');
const {
  normalizeResourceUrl, pageDisplayTitle, preferredVideoTitle, formatOptions, formatsFromInfo,
} = require('./pornhub');

const MAX_SNAPSHOTS = 5;
const BATCH_FORMATS = formatOptions([1080, 720, 480, 240]);

function batchEntries(info) {
  const entries = Array.isArray(info.entries) ? info.entries : [];
  const videos = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidates = [entry.webpage_url, entry.url];
    if (typeof entry.id === 'string') {
      candidates.push(`https://www.pornhub.com/view_video.php?viewkey=${encodeURIComponent(entry.id)}`);
    }
    for (const candidate of candidates) {
      try {
        const resource = normalizeResourceUrl(candidate);
        if (resource.kind !== 'video') continue;
        videos.push({ url: resource.url, title: String(entry.title || resource.id).slice(0, 180) });
        break;
      } catch { /* A removed or unsupported entry is not downloadable. */ }
    }
  }
  return videos;
}

function createResourceParser({ fetchSitePage, captureMetadata }) {
  // The latest five completed results stay valid for this application session.
  const snapshots = new Map();

  function remember(resource) {
    const snapshotId = randomUUID();
    snapshots.set(snapshotId, resource);
    if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
    return snapshotId;
  }

  function batchSnapshot(resource, title, videos, thumbnail) {
    const snapshotId = remember({ ...resource, title, videos });
    return { snapshotId, kind: resource.kind, id: resource.id, title, thumbnail,
      entryCount: videos.length, formats: BATCH_FORMATS };
  }

  async function resolveVideoTitle(video, task) {
    if (video.downloadTitle || task?.cancelled) return;
    if (task) task.titleAbortController ||= new AbortController();
    const title = await preferredVideoTitle(video.url,
      (url) => fetchSitePage(url, { attempts: 1, timeoutMs: 10000, signal: task?.titleAbortController.signal }),
      () => Boolean(task?.cancelled));
    if (title && !task?.cancelled) {
      video.title = title;
      video.downloadTitle = title;
    }
  }

  async function parse(inputUrl) {
    const resource = normalizeResourceUrl(inputUrl);
    if (resource.kind === 'playlist') {
      const { title, videos } = await parsePlaylist(resource, fetchSitePage);
      return batchSnapshot(resource, title, videos);
    }
    const batch = resource.kind !== 'video';
    const output = await captureMetadata(resource, batch);
    let info;
    try { info = JSON.parse(output); }
    catch { throw new Error('yt-dlp 返回的页面信息无法解析。'); }
    if (!info || typeof info !== 'object') {
      throw new Error('没有取得有效的页面信息。');
    }
    const thumbnail = typeof info.thumbnail === 'string' && info.thumbnail.startsWith('https://')
      ? info.thumbnail : undefined;
    if (batch) {
      const videos = batchEntries(info);
      if (!videos.length) throw new Error('此页面未找到可下载视频。请确认网页内容可见，再重新解析。');
      let title = String(info.title || `${resource.id} 的视频`);
      if (resource.kind === 'pornstar') {
        const html = await fetchSitePage(resource.url).catch(() => '');
        title = pageDisplayTitle(html, 'pornstar', title);
      }
      return batchSnapshot(resource, title, videos, thumbnail);
    }
    if (!info.id || !info.title) throw new Error('没有取得有效的视频信息。');
    const video = { url: resource.url, title: String(info.title) };
    await resolveVideoTitle(video);
    const snapshotId = remember({ ...resource, title: video.title, videos: [video] });
    return { snapshotId, kind: 'video', id: String(info.id), title: video.title, thumbnail,
      duration: Number.isFinite(info.duration) ? info.duration : undefined,
      formats: formatsFromInfo(info) };
  }

  return { parse, getSnapshot: (snapshotId) => snapshots.get(snapshotId), resolveVideoTitle };
}

module.exports = { createResourceParser };
