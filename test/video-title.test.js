'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResourceParser, readMetadata } = require('../src/resource-parser');
const { normalizeResourceUrl, chineseTitleLanguage, videoTitlesFromHtml, preferredVideoTitle } = require('../src/pornhub');

const url = 'https://www.pornhub.com/view_video.php?viewkey=ph1234';
const cnUrl = url.replace('://www.', '://cn.');
const resource = normalizeResourceUrl(url);
const page = (language, translated, original = 'Original title', alternatives = '') =>
  `<html lang="${language}"><script>var VIDEO_SHOW = ${JSON.stringify({
    vkey: resource.id, videoTitleOriginal: original, videoTitleTranslated: translated,
  })};</script>${alternatives}</html>`;
const alternate = (language, href) => `<link rel="alternate" hreflang="${language}" href="${href}">`;

test('Chinese locale markers distinguish simplified and traditional title variants', () => {
  for (const language of ['cn', 'zh', 'zh-CN', 'zh_SG', 'zh-Hans', 'zh-Hans-CN']) {
    assert.equal(chineseTitleLanguage(language), 'simplified');
  }
  for (const language of ['tw', 'zh-TW', 'zh_HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW']) {
    assert.equal(chineseTitleLanguage(language), 'traditional');
  }
  for (const language of ['en', 'ja', '']) assert.equal(chineseTitleLanguage(language), null);
});

test('video title extraction decodes title text and parses JSON without evaluating scripts', () => {
  const original = 'Original "};" {nested}';
  const titles = videoTitlesFromHtml(page('cn', ' 简体 &amp; 标题\n100%: \\1 ', original), resource);
  assert.equal(titles.original, original);
  assert.equal(titles.translated, '简体 & 标题 100%: \\1');
  assert.equal(videoTitlesFromHtml('<script>var VIDEO_SHOW = {broken};</script>', resource), null);
  assert.equal(videoTitlesFromHtml(page('cn', '简体').replace('ph1234', 'ph9999'), resource), null);
  assert.equal(videoTitlesFromHtml('<title>Login title</title>', resource), null);
});

test('simplified title takes priority without fetching other pages', async () => {
  const calls = [];
  const title = await preferredVideoTitle(url, async (requested) => {
    calls.push(requested);
    return page('cn', '简体标题', 'Original title', alternate('zh-TW', `${url}&lang=zh-TW`));
  });
  assert.equal(title, '简体标题');
  assert.deepEqual(calls, [cnUrl]);
});

test('missing simplified translation falls back to a same-video traditional alternate', async () => {
  const traditionalUrl = `${url}&lang=zh-TW`;
  const calls = [];
  const title = await preferredVideoTitle(url, async (requested) => {
    calls.push(requested);
    return requested === cnUrl ? page('cn', '', '原始 title', alternate('zh-Hant', traditionalUrl))
      : page('zh-TW', '繁體標題', '原始 title');
  });
  assert.equal(title, '繁體標題');
  assert.deepEqual(calls, [cnUrl, traditionalUrl]);
});

test('a traditional first response still searches advertised simplified variants', async () => {
  const simplifiedUrl = `${url}&lang=zh-Hans`;
  assert.equal(await preferredVideoTitle(url, async (requested) => requested === cnUrl
    ? page('zh-Hant', '繁體標題', 'Original title', alternate('zh-Hans', simplifiedUrl))
    : page('zh-Hans', '简体标题')), '简体标题');
});

test('missing, unchanged, or non-Chinese translations fall back to uploader original title', async () => {
  for (const [language, translated] of [['cn', ''], ['cn', 'Original title'], ['en', 'English translation'], ['ja', '日本語']]) {
    assert.equal(await preferredVideoTitle(url, async () => page(language, translated)), 'Original title');
  }
  assert.equal(await preferredVideoTitle(url, async () => page('cn', '', '繁體原題')), '繁體原題');
});

test('unsupported hosts, protocols, and other video IDs cannot supply alternate titles', async () => {
  const invalidLinks = [
    ['zh-TW', 'https://evil.example/view_video.php?viewkey=ph1234'],
    ['zh-TW', 'https://cn.pornhub.com.evil.example/view_video.php?viewkey=ph1234'],
    ['zh-TW', 'https://cn.pornhub.com/view_video.php?viewkey=ph9999'],
    ['zh-TW', 'http://cn.pornhub.com/view_video.php?viewkey=ph1234'],
    ['zh-TW', 'https://user:secret@cn.pornhub.com/view_video.php?viewkey=ph1234'],
    ['en', `${url}&lang=en`],
  ].map(([language, href]) => alternate(language, href)).join('');
  const calls = [];
  assert.equal(await preferredVideoTitle(url, async (requested) => {
    calls.push(requested);
    return page('cn', '', 'Original title', invalidLinks);
  }), 'Original title');
  assert.deepEqual(calls, [cnUrl]);
});

test('optional title lookup handles network failures and never loops over duplicate alternates', async () => {
  const calls = [];
  assert.equal(await preferredVideoTitle(url, async (requested) => {
    calls.push(requested);
    if (requested === cnUrl) throw new Error('Unavailable');
    return page('en', 'English translation', 'Original title', alternate('zh', cnUrl));
  }), 'Original title');
  assert.deepEqual(calls, [cnUrl, url]);
  assert.equal(await preferredVideoTitle(url, async () => { throw new Error('Unavailable'); }), null);
});

test('cancelled title lookup returns no title and fetches no more alternates', async () => {
  let cancelled = false;
  const calls = [];
  assert.equal(await preferredVideoTitle(url, async (requested) => {
    calls.push(requested);
    cancelled = true;
    return page('cn', '简体标题');
  }, () => cancelled), null);
  assert.deepEqual(calls, [cnUrl]);
});

function titleHarness(fetchPage) {
  return createResourceParser({ fetchSitePage: fetchPage }).resolveVideoTitle;
}

test('resolved download titles update queue display once and remain stable through retries', async () => {
  const calls = [];
  const resolveTitle = titleHarness(async (requested, options) => {
    calls.push({ requested, options });
    return page('cn', '简体标题');
  });
  const video = { url, title: 'List title' };
  const task = { cancelled: false };
  await resolveTitle(video, task);
  assert.equal(video.title, '简体标题');
  assert.equal(video.downloadTitle, '简体标题');
  assert.equal(calls[0].options.timeoutMs, 10000);
  assert.equal(calls[0].options.attempts, 1);
  await resolveTitle(video, task);
  assert.equal(calls.length, 1);
});

test('failed or cancelled lookups leave the existing title usable by the downloader', async () => {
  const unavailable = titleHarness(async () => { throw new Error('Unavailable'); });
  const video = { url, title: 'Existing title' };
  await unavailable(video, { cancelled: false });
  assert.deepEqual(video, { url, title: 'Existing title' });
  const task = { cancelled: false };
  const cancelling = titleHarness(async (_url, options) => {
    task.cancelled = true;
    task.titleAbortController.abort();
    assert.equal(options.signal.aborted, true);
    return page('cn', '简体标题');
  });
  await cancelling(video, task);
  assert.deepEqual(video, { url, title: 'Existing title' });
});

test('single video parsing uses the selected title for returned content and remembered download metadata', async () => {
  const parser = createResourceParser({
    fetchSitePage: async () => page('cn', '简体标题'),
    captureMetadata: async () => readMetadata(JSON.stringify({ id: resource.id, title: 'English displayed title', duration: 123 }), false),
  });
  const parsed = await parser.parse(url);
  const remembered = parser.getSnapshot(parsed.snapshotId);
  assert.equal(parsed.title, '简体标题');
  assert.equal(remembered.title, '简体标题');
  assert.equal(remembered.videos[0].downloadTitle, '简体标题');
});

test('performer entries match the downloadable snapshot after unsupported links are skipped', async () => {
  const parser = createResourceParser({
    fetchSitePage: async () => '',
    captureMetadata: async () => readMetadata(JSON.stringify({ title: 'Performer', entries: [
      { id: 'first123', title: 'First entry' },
      { url: 'https://example.test/removed' },
      { id: 'second456', title: 'Second entry' },
    ] }), true),
  });
  const parsed = await parser.parse('https://www.pornhub.com/model/performer');
  assert.equal(parsed.entryCount, 2);
  assert.deepEqual(parsed.entries, [
    { title: 'First entry', url: 'https://www.pornhub.com/view_video.php?viewkey=first123' },
    { title: 'Second entry', url: 'https://www.pornhub.com/view_video.php?viewkey=second456' },
  ]);
  assert.deepEqual(parsed.entries, parser.getSnapshot(parsed.snapshotId).videos);
});

test('overlapping parses of the same resource retain their own results until evicted', async () => {
  let finishFirst;
  let requests = 0;
  const parser = createResourceParser({
    fetchSitePage: async () => '',
    captureMetadata: () => {
      if (++requests === 1) return new Promise((resolve) => { finishFirst = resolve; });
      return Promise.resolve({ id: resource.id, title: 'New title' });
    },
  });
  const first = parser.parse(url);
  const newer = await parser.parse(cnUrl);
  finishFirst({ id: resource.id, title: 'Old title' });
  const older = await first;
  assert.notEqual(newer.snapshotId, older.snapshotId);
  assert.equal(parser.getSnapshot(newer.snapshotId).videos[0].title, 'New title');
  assert.equal(parser.getSnapshot(older.snapshotId).videos[0].title, 'Old title');

  for (let i = 0; i < 4; i++) await parser.parse(url);
  assert.equal(parser.getSnapshot(newer.snapshotId), undefined);
  assert.equal(parser.getSnapshot(older.snapshotId).title, 'Old title');
});
