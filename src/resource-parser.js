'use strict';

const { randomUUID } = require('node:crypto');
const { parsePlaylist } = require('./playlist');
const {
  normalizeResourceUrl, pageDisplayTitle, preferredVideoTitle,
} = require('./pornhub');
const { formatOptions, formatsFromInfo } = require('./ytdlp-protocol');

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

function readMetadata(output, batch) {
  let info;
  try { info = JSON.parse(output); }
  catch { throw new Error('yt-dlp 返回的页面信息无法解析。'); }
  if (!info || typeof info !== 'object') throw new Error('没有取得有效的页面信息。');
  const thumbnail = typeof info.thumbnail === 'string' && info.thumbnail.startsWith('https://')
    ? info.thumbnail : undefined;
  if (batch) {
    const videos = batchEntries(info);
    if (!videos.length) throw new Error('此页面未找到可下载视频。请确认网页内容可见，再重新解析。');
    return { title: String(info.title || ''), thumbnail, videos };
  }
  if (!info.id || !info.title) throw new Error('没有取得有效的视频信息。');
  return { id: String(info.id), title: String(info.title), thumbnail,
    duration: Number.isFinite(info.duration) ? info.duration : undefined, formats: formatsFromInfo(info) };
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
      entryCount: videos.length, formats: BATCH_FORMATS,
      ...(resource.kind === 'pornstar' && { entries: videos.map(({ title, url }) => ({ title, url })) }) };
  }

  async function resolveVideoTitle(video, { signal } = {}) {
    if (video.downloadTitle || signal?.aborted) return;
    const title = await preferredVideoTitle(video.url,
      (url) => fetchSitePage(url, { attempts: 1, timeoutMs: 10000, signal }),
      () => Boolean(signal?.aborted));
    if (title && !signal?.aborted) {
      video.title = title;
      video.downloadTitle = title;
    }
  }

  async function parse(inputUrl, { signal } = {}) {
    signal?.throwIfAborted();
    const resource = normalizeResourceUrl(inputUrl);
    if (resource.kind === 'playlist') {
      const { title, videos, ...availability } = await parsePlaylist(resource, fetchSitePage, { signal });
      return { ...batchSnapshot(resource, title, videos), ...availability };
    }
    const batch = resource.kind !== 'video';
    const info = await captureMetadata(resource, batch);
    signal?.throwIfAborted();
    const { thumbnail } = info;
    if (batch) {
      const { videos } = info;
      let title = String(info.title || `${resource.id} 的视频`);
      if (resource.kind === 'pornstar') {
        const html = await fetchSitePage(resource.url, { signal }).catch(() => '');
        signal?.throwIfAborted();
        title = pageDisplayTitle(html, 'pornstar', title);
      }
      return batchSnapshot(resource, title, videos, thumbnail);
    }
    if (typeof info.id === 'string' && info.id.length && info.id.toLowerCase() !== resource.id.toLowerCase()) {
      throw new Error('下载工具返回的视频 ID 与请求的链接不一致，请检查网页是否重定向。');
    }
    const video = { url: resource.url, title: String(info.title) };
    await resolveVideoTitle(video, { signal });
    signal?.throwIfAborted();
    const snapshotId = remember({ ...resource, title: video.title, videos: [video] });
    return { snapshotId, kind: 'video', id: resource.id, title: video.title, thumbnail,
      duration: info.duration, formats: info.formats };
  }

  return { parse, getSnapshot: (snapshotId) => snapshots.get(snapshotId), resolveVideoTitle };
}

module.exports = { createResourceParser, readMetadata };
