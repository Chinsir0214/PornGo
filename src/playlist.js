// @ts-check
'use strict';

const { playlistEntriesFromHtml, pageDisplayTitle } = require('./pornhub');

/**
 * @param {{id: string, url: string}} resource
 * @param {(url: string, options: {signal?: AbortSignal}) => string | Promise<string>} fetchPage
 * @param {{signal?: AbortSignal}} [options]
 */
async function parsePlaylist(resource, fetchPage, { signal } = {}) {
  signal?.throwIfAborted();
  const html = await fetchPage(resource.url, { signal });
  const pageId = /\b(?:var|let|const)\s+playlistId\s*=\s*"([^"]+)"/.exec(html)?.[1];
  const token = /\b(?:var|let|const)\s+token\s*=\s*"([^"]+)"/.exec(html)?.[1];
  const declaredCount = Number(/\b(?:var|let|const)\s+itemsCount\s*=\s*([0-9]+)\s*(?=\|\||;|}|<|$)/.exec(html)?.[1]);
  if (pageId !== resource.id || !token || !Number.isSafeInteger(declaredCount)
      || declaredCount < 1 || declaredCount > 20000) {
    throw new Error('片单页面缺少有效的分页信息，请确认在内嵌网页登录窗口可打开。');
  }

  const pageCount = Math.ceil(Math.max(0, declaredCount - 36) / 40) + 1;
  const videos = [];
  const seen = new Set();
  for (let page = 1; page <= pageCount; page++) {
    signal?.throwIfAborted();
    const chunkUrl = new URL('/playlist/viewChunked', resource.url);
    chunkUrl.searchParams.set('id', pageId);
    chunkUrl.searchParams.set('page', String(page));
    chunkUrl.searchParams.set('token', token);
    const entries = playlistEntriesFromHtml(await fetchPage(chunkUrl.href, { signal }));
    signal?.throwIfAborted();
    const before = videos.length;
    for (const video of entries) {
      if (seen.has(video.url)) continue;
      seen.add(video.url);
      videos.push(video);
    }
    if (videos.length === before) {
      throw new Error(`片单标注 ${declaredCount} 条，但只取得 ${videos.length} 条；第 ${page} 页没有新视频，请稍后重新解析。`);
    }
  }
  if (videos.length > declaredCount) {
    throw new Error(`片单标注 ${declaredCount} 条，但取得 ${videos.length} 条；请稍后重新解析。`);
  }
  return { title: pageDisplayTitle(html, 'playlist', `片单 ${resource.id}`), videos,
    ...(videos.length < declaredCount && { declaredCount, warning: `片单标注 ${declaredCount} 条，可下载 ${videos.length} 条；部分视频可能已删除或设为私密。` }) };
}

module.exports = { parsePlaylist };
