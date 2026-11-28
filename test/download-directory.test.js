'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadDownloadDirectory, saveDownloadDirectory, validateDownloadDirectory } = require('../src/download-directory');

async function testDirectories(t) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-settings-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const userData = path.join(sandbox, 'user-data');
  const downloads = path.join(sandbox, 'Downloads');
  const custom = path.join(sandbox, 'custom');
  await fs.mkdir(downloads);
  await fs.mkdir(custom);
  return { userData, downloads, custom };
}

test('uses system Downloads until a custom directory is selected and restores it', async (t) => {
  const { userData, downloads, custom } = await testDirectories(t);
  assert.equal(await loadDownloadDirectory(userData, downloads), downloads);

  assert.equal(await saveDownloadDirectory(userData, custom), custom);
  assert.equal(await loadDownloadDirectory(userData, downloads), custom);
  await saveDownloadDirectory(userData, downloads);
  assert.equal(await loadDownloadDirectory(userData, downloads), downloads);
});

test('falls back to Downloads when a saved directory disappears or settings are invalid', async (t) => {
  const { userData, downloads, custom } = await testDirectories(t);
  await saveDownloadDirectory(userData, custom);
  await fs.rm(custom, { recursive: true });
  assert.equal(await loadDownloadDirectory(userData, downloads), downloads);

  await fs.writeFile(path.join(userData, 'download-directory.json'), '{invalid json');
  assert.equal(await loadDownloadDirectory(userData, downloads), downloads);
});

test('uses the same directory validation for download and saved settings', async (t) => {
  const { userData, downloads } = await testDirectories(t);
  assert.equal(await validateDownloadDirectory(downloads), downloads);
  await assert.rejects(validateDownloadDirectory('relative/path'), /请先选择保存目录/);
  await assert.rejects(saveDownloadDirectory(userData, 'relative/path'), /请先选择保存目录/);
  await assert.rejects(saveDownloadDirectory(userData, path.join(downloads, 'missing')), /保存目录不存在/);
  const file = path.join(downloads, 'video.mp4');
  await fs.writeFile(file, '');
  await assert.rejects(validateDownloadDirectory(file), /保存目录不存在/);
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(path.join(userData, 'download-directory.json'), JSON.stringify({ directory: file }));
  assert.equal(await loadDownloadDirectory(userData, downloads), downloads);
});
