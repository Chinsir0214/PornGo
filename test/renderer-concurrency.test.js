'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererHarness } = require('./helpers/renderer-harness');
const { normalizeResourceUrl } = require('../src/pornhub');

test('renderer delegates URL validation and keeps batch concurrency when editing single-video settings', async () => {
  const url = 'http://de.pornhub.com/view_video.php?viewkey=example';
  let submitted;
  let emit;
  let networkFailure = false;
  let saved = JSON.stringify({ fragmentConcurrency: '1', videoConcurrency: '2' });
  const parsedUrls = [];
  const api = {
    sessionStatus: async () => ({ cookieCount: 0 }),
    parse: async (input) => {
      parsedUrls.push(input);
      if (networkFailure) throw new Error('连接超时');
      const resource = normalizeResourceUrl(input);
      return { ...resource, snapshotId: `snapshot-${parsedUrls.length}`, entryCount: 3,
        title: 'Sample', formats: [{ id: 'best', label: 'Best' }] };
    },
    concurrencyOptions: async () => ({ fragment: [1, 4], video: [1, 2] }),
    download: async (request) => {
      submitted = request;
      emit({ taskId: 'test-task', type: 'started' });
      return { taskId: 'test-task' };
    },
    onDownloadEvent: (listener) => { emit = listener; }, onLoginClosed: () => {},
  };
  const { element, document } = createRendererHarness(api, {
    localStorage: { getItem: () => saved, setItem: (_key, value) => { saved = value; } },
  });
  await new Promise(setImmediate);
  const submit = () => element('parse-form').dispatch('submit', { preventDefault() {} });
  await submit();
  assert.deepEqual(parsedUrls, []);
  assert.equal(element('video-url').attributes['aria-invalid'], 'true');
  assert.equal(document.activeElement, element('video-url'));

  const invalidHost = 'https://pornhub.com.evil.example/view_video.php?viewkey=example';
  element('video-url').value = invalidHost;
  await submit();
  assert.deepEqual(parsedUrls, [invalidHost]);
  assert.match(element('notice-message').textContent, /解析失败：仅支持 Pornhub/);
  assert.equal(element('download-button').disabled, true);

  const defaultPort = 'http://de.pornhub.com:80/view_video.php?viewkey=example';
  element('video-url').value = defaultPort;
  await submit();
  assert.deepEqual(parsedUrls, [invalidHost, defaultPort]);
  assert.match(element('notice-message').textContent, /解析失败：链接格式无效/);
  assert.equal(element('download-button').disabled, true);

  networkFailure = true;
  element('video-url').value = url;
  await submit();
  assert.match(element('notice-message').textContent, /解析失败：连接超时/);
  assert.equal(element('download-button').disabled, true);

  networkFailure = false;
  await submit();
  assert.equal(parsedUrls.at(-1), url);
  assert.equal(element('video-concurrency').value, '1');
  assert.equal(element('video-concurrency').disabled, true);
  element('fragment-concurrency').value = '4';
  element('fragment-concurrency').dispatch('change');
  assert.deepEqual(JSON.parse(saved), { fragmentConcurrency: '4', videoConcurrency: '2' });
  await element('download-button').dispatch('click');
  assert.equal(submitted.videoConcurrency, 1);
  assert.equal(submitted.fragmentConcurrency, 4);
  assert.equal(submitted.snapshotId, 'snapshot-4');

  element('video-url').value = 'https://www.pornhub.com/playlist/123';
  element('video-url').dispatch('input');
  await submit();
  assert.equal(element('video-concurrency').disabled, false);
  assert.equal(element('video-concurrency').value, '2');
});

test('startup uses the default concurrency options when IPC rejects', async () => {
  const { element } = createRendererHarness({
    concurrencyOptions: async () => { throw new Error('offline'); },
  });
  await new Promise(setImmediate);
  for (const [id, options, selected] of [
    ['fragment-concurrency', ['1', '4'], '1'], ['video-concurrency', ['1', '2'], '1'],
  ]) {
    const select = element(id);
    assert.deepEqual(select.querySelectorAll('option').map((option) => option.value), options);
    assert.equal(select.value, selected);
  }
  assert.match(element('notice-message').textContent, /已使用默认设置.*offline/);
});
