'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runDownloadProcess } = require('../src/download-process');
const { spawnSync } = require('node:child_process');
const {
  FILE_METADATA_PREFIX, artifactYtdlpArgs,
  parseFileMetadata, publicationDate, applyPublicationTime,
} = require('../src/download-artifact');

test('all downloads use the same title and ID filename without a list position', () => {
  const args = artifactYtdlpArgs(process.platform === 'win32' ? 'C:\\dl' : '/dl');
  assert.equal(args[args.indexOf('-o') + 1], '%(title).180B [%(id)s].%(ext)s');
  assert.ok(!args.includes('--replace-in-metadata'));
  assert.ok(args.includes('--no-overwrites'));
  assert.ok(args.includes('--embed-metadata'));
  assert.match(args[args.indexOf('--parse-metadata') + 1], /meta_creation_time/);
  assert.ok(args.includes('--no-mtime'));
  assert.ok(args.includes('--progress'));
  assert.match(args[args.indexOf('--print') + 1], /^after_move:PORNGO_FILE:/);
});

test('bundled yt-dlp applies literal Chinese title to filenames and metadata offline', {
  skip: process.platform !== 'win32' || !fs.existsSync(path.join(__dirname, '..', 'tools', 'yt-dlp.exe')),
}, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'porngo-title-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const infoFile = path.join(directory, 'sample.info.json');
  await fsp.writeFile(infoFile, JSON.stringify({
    id: 'ph1234', title: 'Original title', ext: 'mp4', url: 'https://example.invalid/video.mp4',
    extractor: 'PornHub', extractor_key: 'PornHub',
    webpage_url: 'https://www.pornhub.com/view_video.php?viewkey=ph1234',
  }));
  const title = '简体 100% %(id)s: \\1 \\g<title>';
  const result = spawnSync(path.join(__dirname, '..', 'tools', 'yt-dlp.exe'), [
    ...artifactYtdlpArgs(directory, title), '--no-check-formats', '--load-info-json', infoFile,
    '--skip-download', '--print', '%(.{title,meta_title,_filename})j',
  ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const info = JSON.parse(result.stdout.trim());
  assert.equal(info.title, title);
  assert.equal(info.meta_title, title);
  assert.ok(path.basename(info._filename).startsWith('简体 100% %(id)s'));
  assert.ok(path.basename(info._filename).endsWith(' [ph1234].mp4'));
});

test('publication time uses timestamp then validated upload date, never missing or invalid dates', () => {
  assert.equal(publicationDate({ timestamp: 1727138096, upload_date: '20200101' }).toISOString(),
    '2024-09-24T00:34:56.000Z');
  assert.equal(publicationDate({ timestamp: 'NA', upload_date: '20240229' }).toISOString(),
    '2024-02-29T00:00:00.000Z');
  for (const upload_date of ['20230229', '20240431', '20241301', '', 'NA', null]) {
    assert.equal(publicationDate({ upload_date }), null);
  }
  assert.equal(publicationDate({ timestamp: Infinity }), null);
});

test('final file records handle quoted paths while ignoring normal progress and malformed JSON', () => {
  const record = { filepath: 'C:\\Downloads\\quoted "title" [ph1234].mp4', upload_date: '20240924' };
  assert.deepEqual(parseFileMetadata(FILE_METADATA_PREFIX + JSON.stringify(record)), record);
  assert.equal(parseFileMetadata('[download] 100%'), null);
  assert.equal(parseFileMetadata(FILE_METADATA_PREFIX + '{}'), null);
  assert.equal(parseFileMetadata(FILE_METADATA_PREFIX + '{'), null);
});

test('publication time is applied only to the completed file in the destination and absent dates leave it intact', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'porngo-time-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const filepath = path.join(directory, 'sample [ph1234].mp4');
  await fsp.writeFile(filepath, 'synthetic media');
  const original = (await fsp.stat(filepath)).mtimeMs;
  await applyPublicationTime({ filepath, upload_date: 'NA' }, directory);
  assert.equal((await fsp.stat(filepath)).mtimeMs, original);
  await applyPublicationTime({ filepath, upload_date: '20240924' }, directory);
  assert.equal((await fsp.stat(filepath)).mtime.toISOString(), '2024-09-24T00:00:00.000Z');
  await assert.rejects(applyPublicationTime({
    filepath: path.join(directory, '..', 'outside.mp4'), upload_date: '20240924',
  }, directory), /输出路径不在下载目录/);
});

function downloadHarness({ timeError = null } = {}) {
  const calls = [];
  const timeCalls = [];
  let child;
  const options = {
    applyTime: async (record, directory) => {
      timeCalls.push({ record, directory });
      await new Promise(setImmediate);
      if (timeError) throw new Error(timeError);
    },
    binary: 'fake-yt-dlp', baseArgs: [], launchError: (error) => error.message,
    spawnProcess: (_tool, args) => {
      calls.push(args);
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    },
  };
  const task = { kind: 'pornstar', directory: 'downloads', cookieFile: { file: 'cookies' },
    fragmentConcurrency: 4, children: new Set() };
  const video = { url: 'https://www.pornhub.com/view_video.php?viewkey=ph1234' };
  return { task, video, calls, timeCalls,
    run: (index = 0) => runDownloadProcess(task, { index, video }, () => {}, options),
    child: () => child,
  };
}

test('main waits until successful postprocessing ends before setting the final file time', async () => {
  const harness = downloadHarness();
  const pending = harness.run(17);
  const record = { filepath: 'downloads/中文 [ph1234].mp4', timestamp: 1727138096 };
  const line = FILE_METADATA_PREFIX + JSON.stringify(record);
  const bytes = Buffer.from('[download] 30%\n' + line);
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  harness.child().stdout.emit('data', bytes.subarray(0, split));
  harness.child().stdout.emit('data', bytes.subarray(split));
  assert.equal(harness.timeCalls.length, 0);
  harness.child().emit('close', 0);
  assert.equal(await pending, null);
  assert.deepEqual(harness.timeCalls, [{ record, directory: 'downloads' }]);
  assert.equal(harness.video.downloadFileName, '中文 [ph1234].mp4');
  assert.equal(harness.task.children.size, 0);
  const firstTemplate = harness.calls[0][harness.calls[0].indexOf('-o') + 1];
  harness.task.kind = 'video';
  const second = harness.run(0);
  harness.child().stdout.emit('data', Buffer.from(FILE_METADATA_PREFIX + JSON.stringify(record) + '\n'));
  harness.child().emit('close', 0);
  await second;
  assert.equal(harness.calls[1][harness.calls[1].indexOf('-o') + 1], firstTemplate);
});

test('failed downloads never change file time and time failures are returned to the queue', async () => {
  const harness = downloadHarness();
  const pending = harness.run();
  const record = { filepath: 'downloads/sample.mp4', upload_date: '20240924' };
  harness.child().stdout.emit('data', Buffer.from(FILE_METADATA_PREFIX + JSON.stringify(record) + '\n'));
  harness.child().emit('close', 1);
  assert.match(await pending, /下载失败/);
  assert.equal(harness.timeCalls.length, 0);
  assert.equal(harness.video.downloadFileName, 'sample.mp4');
  const failing = downloadHarness({ timeError: 'write denied' });
  const failed = failing.run();
  failing.child().stdout.emit('data', Buffer.from(FILE_METADATA_PREFIX + JSON.stringify(record) + '\n'));
  failing.child().emit('close', 0);
  assert.deepEqual(await failed, { message: '视频已下载，但设置发布时间失败：write denied', retryable: false });
});

test('a successful child without a final file record reports the metadata failure', async () => {
  const harness = downloadHarness();
  const pending = harness.run();
  harness.child().emit('close', 0);
  const error = await pending;
  assert.match(error.message, /未取得最终文件信息/);
  assert.equal(error.retryable, false);
  assert.equal(harness.timeCalls.length, 0);
});

test('Windows timestamps accept case differences and extended-length paths', async () => {
  const directory = 'C:\\Downloads';
  const filepath = '\\\\?\\c:\\DOWNLOADS\\clip.mp4';
  let updated;
  await applyPublicationTime({ filepath, upload_date: '20240924' }, directory, {
    platform: 'win32',
    fs: {
      realpath: async (name) => name,
      stat: async () => ({ isFile: () => true, atime: new Date(0) }),
      utimes: async (name) => { updated = name; },
    },
  });
  assert.equal(updated, filepath);
});

test('Windows title budget shrinks beyond the path threshold with a 40 byte floor',
  { skip: process.platform !== 'win32' }, () => {
    for (const [length, bytes] of [[42, 180], [43, 179], [183, 40]]) {
      const args = artifactYtdlpArgs('C:\\' + 'a'.repeat(length - 3));
      assert.equal(args.at(-1), '%(title).' + bytes + 'B [%(id)s].%(ext)s');
    }
  });
