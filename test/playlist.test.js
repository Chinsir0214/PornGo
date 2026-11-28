'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlaylist } = require('../src/playlist');

const resource = { url: 'https://www.pornhub.com/playlist/987654321000', id: '987654321000' };
const pageHtml = (count) => `<title>Sample | Pornhub.com</title><script>var playlistId = "987654321000"; var token = "abc"; var itemsCount = ${count} || 0;</script>`;
const entriesHtml = (ids) => ids.map((id) =>
  `<a href="/view_video.php?viewkey=ph${String(id).padStart(4, '0')}" title="Video ${id}">Video</a>`).join('');
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);

test('fetches all playlist chunks with the first 36 and later 40 entries', async () => {
  const requestedPages = [];
  const result = await parsePlaylist(resource, async (url) => {
    if (url === resource.url) return pageHtml(77);
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/playlist/viewChunked');
    assert.equal(parsed.searchParams.get('id'), resource.id);
    assert.equal(parsed.searchParams.get('token'), 'abc');
    const page = Number(parsed.searchParams.get('page'));
    requestedPages.push(page);
    return entriesHtml(page === 1 ? range(1, 36) : page === 2 ? range(37, 76) : [77]);
  });
  assert.deepEqual(requestedPages, [1, 2, 3]);
  assert.equal(result.title, 'Sample');
  assert.equal(result.videos.length, 77);
  assert.match(result.videos[0].url, /ph0001$/);
  assert.match(result.videos[76].url, /ph0077$/);
});

test('deduplicates entries across chunks before checking the declared count', async () => {
  const result = await parsePlaylist(resource, async (url) => {
    if (url === resource.url) return pageHtml(37);
    const page = Number(new URL(url).searchParams.get('page'));
    return entriesHtml(page === 1 ? range(1, 36) : [36, 37]);
  });
  assert.equal(result.videos.length, 37);
  assert.match(result.videos[36].url, /ph0037$/);
});

test('rejects incomplete playlist chunks and invalid page metadata', async () => {
  await assert.rejects(
    parsePlaylist(resource, async (url) => url === resource.url ? pageHtml(37) : entriesHtml(range(1, 36))),
    /只取得 36 条/,
  );
  await assert.rejects(
    parsePlaylist(resource, async () => pageHtml(20001)),
    /缺少有效的分页信息/,
  );
});

test('partially available playlists report the declared and available counts', async () => {
  const result = await parsePlaylist(resource, async (url) =>
    url === resource.url ? pageHtml(38) : entriesHtml(
      new URL(url).searchParams.get('page') === '1' ? range(1, 36) : [38]));
  assert.equal(result.declaredCount, 38);
  assert.equal(result.videos.length, 37);
  assert.match(result.warning, /可下载 37 条.*删除/);
});
