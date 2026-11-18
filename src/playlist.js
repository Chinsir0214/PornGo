'use strict';

const { playlistEntriesFromHtml, pageDisplayTitle } = require('./pornhub');

async function parsePlaylist(resource, fetchPage) {
  const html = await fetchPage(resource.url);
  const pageId = /var\s+playlistId\s*=\s*"([^"]+)"/.exec(html)?.[1];
  const token = /var\s+token\s*=\s*"([^"]+)"/.exec(html)?.[1];
  const declaredCount = Number(/var\s+itemsCount\s*=\s*([0-9]+)\s*\|\|/.exec(html)?.[1]);
  if (pageId !== resource.id || !token || !Number.isSafeInteger(declaredCount)
      || declaredCount < 1 || declaredCount > 20000) {
    throw new Error('片单页面缺少有效的分页信息，请确认在内嵌网页登录窗口可打开。');
  }

  const pageCount = Math.ceil(Math.max(0, declaredCount - 36) / 40) + 1;
  const videos = [];
  const seen = new Set();
  for (let page = 1; page <= pageCount; page++) {
    const chunkUrl = new URL('/playlist/viewChunked', resource.url);
    chunkUrl.searchParams.set('id', pageId);
    chunkUrl.searchParams.set('page', String(page));
    chunkUrl.searchParams.set('token', token);
    const entries = playlistEntriesFromHtml(await fetchPage(chunkUrl.href));
    for (const video of entries) {
      if (seen.has(video.url)) continue;
      seen.add(video.url);
      videos.push(video);
    }
  }
  if (videos.length !== declaredCount) {
    throw new Error(`片单标注 ${declaredCount} 条，但只取得 ${videos.length} 条；请稍后重新解析。`);
  }
  return { title: pageDisplayTitle(html, 'playlist', `片单 ${resource.id}`), videos };
}

module.exports = { parsePlaylist };
