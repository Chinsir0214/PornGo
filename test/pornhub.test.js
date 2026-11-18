'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeResourceUrl, playlistEntriesFromHtml, pageDisplayTitle,
  serializeCookies, formatsFromInfo, formatExpression,
  parseProgressLine, explainYtdlpError,
} = require('../src/pornhub');

test('video links normalize to the canonical page without unrelated parameters', () => {
  assert.deepEqual(normalizeResourceUrl('https://cn.pornhub.com/view_video.php?viewkey=ph123456789&t=1#comments'), {
    url: 'https://www.pornhub.com/view_video.php?viewkey=ph123456789',
    kind: 'video', id: 'ph123456789',
  });
  for (const url of [
    'https://www.pornhub.com/video/show?viewkey=ph123456789',
    'https://www.pornhub.com/embed/ph123456789',
  ]) {
    assert.deepEqual(normalizeResourceUrl(url), {
      url: 'https://www.pornhub.com/view_video.php?viewkey=ph123456789',
      kind: 'video', id: 'ph123456789',
    });
  }
});

test('playlist links normalize to the full playlist', () => {
  assert.deepEqual(normalizeResourceUrl('http://de.pornhub.com/playlist/987654321000?page=2#top'), {
    url: 'https://www.pornhub.com/playlist/987654321000', kind: 'playlist', id: '987654321000',
  });
});

test('pornstar and model links normalize to their video listings', () => {
  assert.deepEqual(normalizeResourceUrl('https://www.pornhub.com/pornstar/sample-performer'), {
    url: 'https://www.pornhub.com/pornstar/sample-performer/videos', kind: 'pornstar', id: 'sample-performer',
  });
  assert.deepEqual(normalizeResourceUrl('https://www.pornhub.com/pornstar/sample-performer/videos?o=mv&page=3&utm_source=x'), {
    url: 'https://www.pornhub.com/pornstar/sample-performer/videos?o=mv&page=3',
    kind: 'pornstar', id: 'sample-performer',
  });
  assert.deepEqual(normalizeResourceUrl('https://www.pornhub.com/model/sample_model/videos?o=cm'), {
    url: 'https://www.pornhub.com/model/sample_model/videos?o=cm', kind: 'pornstar', id: 'sample_model',
  });
});

test('unexpected hosts, paths and parameters never reach yt-dlp', () => {
  for (const url of [
    'https://pornhub.com.evil.example/view_video.php?viewkey=ph123456789',
    'https://www.pornhubpremium.com/view_video.php?viewkey=ph123456789',
    'file:///etc/passwd',
    'https://user:pass@www.pornhub.com/view_video.php?viewkey=ph123456789',
    'https://www.pornhub.com:443/playlist/987654321000',
    'https://www.pornhub.com/users/example',
    'https://www.pornhub.com/view_video.php?viewkey=../../bad',
    'https://www.pornhub.com/view_video.php?viewkey=ph123456789&viewkey=ph999999999',
    'https://www.pornhub.com/playlist/987654321000/more',
    'https://www.pornhub.com/pornstar/sample-performer/../other/videos',
    'https://www.pornhub.com/pornstar/sample-performer/videos?page=0',
    'https://www.pornhub.com/pornstar/sample-performer/videos?page=1&page=2',
    'https://www.pornhub.com/pornstar/sample-performer/videos?o=--exec',
    'https://www.pornhub.com/pornstar/sample-performer/videos?o=mv&o=lg',
    'https://www.pornhub.com/pornstar/sample-performer/videos/paid',
  ]) {
    assert.throws(() => normalizeResourceUrl(url), url);
  }
});

test('cookie export keeps site scope and HttpOnly cookies', () => {
  const output = serializeCookies([
    { domain: '.pornhub.com', name: 'auth', value: 'token', path: '/', secure: true,
      httpOnly: true, session: true },
    { domain: 'example.com', name: 'other', value: 'secret', path: '/', secure: true },
  ]);
  assert.match(output, /#HttpOnly_\.pornhub\.com\tTRUE\t\/\tTRUE\t0\tauth\ttoken/);
  assert.doesNotMatch(output, /example\.com|secret/);
});

test('embedded page playlist extraction keeps one entry per video in page order', () => {
  const html = '<a href="/view_video.php?viewkey=ph1111" class="foo" title="First">1</a>'
    + '<a href="/view_video.php?viewkey=ph1111" title="First">1 again</a>'
    + '<a href="/view_video.php?x=1&viewkey=ph2222" title="Second">2</a>';
  assert.deepEqual(playlistEntriesFromHtml(html), [
    { url: 'https://www.pornhub.com/view_video.php?viewkey=ph1111', title: 'First' },
    { url: 'https://www.pornhub.com/view_video.php?viewkey=ph2222', title: 'Second' },
  ]);
});

test('page titles provide readable playlist and creator folder names', () => {
  assert.equal(pageDisplayTitle('<title>Sample Playlist - 来自某人的色情片片单 &#124; Pornhub.com</title>',
    'playlist', '片单 123'), 'Sample Playlist');
  assert.equal(pageDisplayTitle('<title>Sample Performer的全新色情片2026 &#124; Pornhub</title>',
    'pornstar', 'sample-performer'), 'Sample Performer');
  assert.equal(pageDisplayTitle('<html></html>', 'playlist', '片单 123'), '片单 123');
});

test('quality options are accepted and invalid quality IDs are rejected', () => {
  const heights = [100, 144, 720, 720, 4320, 4321];
  const expected = ['best', 'h:4320', 'h:720', 'h:144'];
  const options = formatsFromInfo({ formats: heights.map((height) => ({ height, vcodec: 'video' })) });
  assert.deepEqual(options.map(({ id }) => id), expected);
  for (const { id } of options) assert.doesNotThrow(() => formatExpression(id));
  assert.equal(formatExpression('best'), null);
  assert.match(formatExpression('h:720'), /height<=720/);
  assert.throws(() => formatExpression('h:100'), /请选择有效的画质/);
  assert.throws(() => formatExpression('--exec=bad'));
});

test('progress parser handles ordinary yt-dlp output', () => {
  assert.deepEqual(parseProgressLine('[download]  37.5% of 12.4MiB at 1.2MiB/s ETA 00:12'), {
    percent: 37.5, speed: '1.2MiB/s', eta: '00:12',
    message: '[download]  37.5% of 12.4MiB at 1.2MiB/s ETA 00:12',
  });
});

test('yt-dlp failures show the actionable error without unrelated warnings', () => {
  assert.match(explainYtdlpError('Deprecated Feature: Python 3.10\nERROR: [PornHub] abc: No video formats found!'), /未找到可下载画质/);
  assert.match(explainYtdlpError('ERROR: [PornHub] abc: Redirection detected; the video may be deleted or require login'), /登录后重试/);
  assert.equal(explainYtdlpError('WARNING: ignored\nERROR: Network failure'), 'Network failure');
  assert.match(explainYtdlpError('ERROR: unable to download video data: HTTP Error 474: Client Error'), /其他视频/);
});
