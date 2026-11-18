'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SETTINGS_FILE = 'download-directory.json';

async function validateDownloadDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 4096) {
    throw new Error('请先选择保存目录。');
  }
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('保存目录不存在。');
  return directory;
}

async function loadDownloadDirectory(userDataDirectory, defaultDirectory) {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(userDataDirectory, SETTINGS_FILE), 'utf8'));
    return await validateDownloadDirectory(settings && settings.directory);
  } catch { /* Missing or unreadable settings use the system Downloads folder. */ }
  return defaultDirectory;
}

async function saveDownloadDirectory(userDataDirectory, directory) {
  await validateDownloadDirectory(directory);
  await fs.mkdir(userDataDirectory, { recursive: true });
  const settingsFile = path.join(userDataDirectory, SETTINGS_FILE);
  const temporaryFile = `${settingsFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, JSON.stringify({ directory }), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporaryFile, settingsFile);
  } finally {
    await fs.rm(temporaryFile, { force: true }).catch(() => {});
  }
  return directory;
}

module.exports = { loadDownloadDirectory, saveDownloadDirectory, validateDownloadDirectory };
