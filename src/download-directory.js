// @ts-check
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile, createAsyncQueue } = require('./atomic-file');

const serialize = createAsyncQueue();

const SETTINGS_FILE = 'download-directory.json';

/** @param {unknown} directory */
async function validateDownloadDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 4096) {
    throw new Error('请先选择保存目录。');
  }
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('保存目录不存在。');
  return directory;
}

/**
 * @param {string} userDataDirectory
 * @param {string} defaultDirectory
 */
async function readDirectory(userDataDirectory, defaultDirectory) {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(userDataDirectory, SETTINGS_FILE), 'utf8'));
    return await validateDownloadDirectory(settings && settings.directory);
  } catch { /* Missing or unreadable settings use the system Downloads folder. */ }
  return defaultDirectory;
}

/**
 * @param {string} userDataDirectory
 * @param {string} defaultDirectory
 */
function loadDownloadDirectory(userDataDirectory, defaultDirectory) {
  return serialize(() => readDirectory(userDataDirectory, defaultDirectory));
}

/**
 * @param {string} userDataDirectory
 * @param {string} directory
 */
function saveDownloadDirectory(userDataDirectory, directory) {
  return serialize(async () => {
    await validateDownloadDirectory(directory);
    await atomicWriteFile(path.join(userDataDirectory, SETTINGS_FILE), JSON.stringify({ directory }));
    return directory;
  });
}

module.exports = { loadDownloadDirectory, saveDownloadDirectory, validateDownloadDirectory };
