'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const OUTPUT_TEMPLATE = '%(title).180B [%(id)s].%(ext)s';
const FILE_METADATA_PREFIX = 'PORNGO_FILE:';
// Colons in the FROM template must be escaped for yt-dlp's FROM:TO parser.
// The empty fallback cannot match .+, so missing dates do not create a tag.
const CREATION_TIME_MAPPING = '%(timestamp>%Y-%m-%dT%H\\:%M\\:%SZ,upload_date>%Y-%m-%dT00\\:00\\:00Z|)s:(?P<meta_creation_time>.+)';

function outputTemplate(directory, videoUrl) {
  if (process.platform !== 'win32') return OUTPUT_TEMPLATE;
  // Leave room for the separator, video ID, extension and temporary format suffix.
  const idLength = /[?&]viewkey=([a-z0-9]+)/i.exec(videoUrl || '')?.[1].length || 16;
  const available = 259 - path.resolve(directory).length - idLength - 21;
  if (available < 1) throw new Error('下载路径过长，请选择较短的保存目录后重试。');
  const bytes = Math.min(180, Math.max(40, available));
  return OUTPUT_TEMPLATE.replace('180B', `${bytes}B`);
}

function artifactYtdlpArgs(directory, title, videoUrl) {
  return [
    '--no-overwrites', '--embed-metadata', '--no-embed-info-json', '--no-mtime',
    // Python replacement strings interpret backslashes; the title is otherwise
    // literal, so percent signs and colons cannot become templates or mappings.
    ...(typeof title === 'string' && title.trim() ? [
      '--replace-in-metadata', 'title', '(?s)^.+$', title.replaceAll('\\', '\\\\'),
      '--parse-metadata', 'title:(?s)(?P<meta_title>.+)',
    ] : []),
    '--parse-metadata', CREATION_TIME_MAPPING,
    '--print', `after_move:${FILE_METADATA_PREFIX}%(.{filepath,timestamp,upload_date})j`,
    '--progress', '-P', directory, '-o', outputTemplate(directory, videoUrl),
  ];
}

function parseFileMetadata(line) {
  if (!line.startsWith(FILE_METADATA_PREFIX)) return null;
  try {
    const record = JSON.parse(line.slice(FILE_METADATA_PREFIX.length));
    return record && typeof record.filepath === 'string' && record.filepath ? record : null;
  } catch {
    return null;
  }
}

function publicationDate(record) {
  if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
    const date = new Date(record.timestamp * 1000);
    if (Number.isFinite(date.getTime())) return date;
  }
  const value = record.upload_date;
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null;
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replaceAll('-', '') === value
    ? date : null;
}

function comparablePath(file, platform) {
  if (platform !== 'win32') return file;
  return file.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase();
}

async function applyPublicationTime(record, directory, { fs = fsp, platform = process.platform } = {}) {
  const date = publicationDate(record);
  if (!date) return;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const file = paths.resolve(record.filepath);
  const destination = paths.resolve(directory);
  const inDestination = (name, folder) => paths.dirname(comparablePath(name, platform)) ===
    comparablePath(folder, platform);
  try {
    // Only the final media in this task's destination may receive a timestamp.
    if (!inDestination(file, destination)) throw new Error('视频输出路径不在下载目录中。');
    const [realFile, realDirectory] = await Promise.all([fs.realpath(file), fs.realpath(destination)]);
    if (!inDestination(realFile, realDirectory)) throw new Error('视频输出路径不在下载目录中。');
    const stat = await fs.stat(realFile);
    if (!stat.isFile()) throw new Error('视频输出路径不是文件。');
    await fs.utimes(realFile, stat.atime, date);
  } catch (error) {
    error.retryable = false;
    throw error;
  }
}

module.exports = {
  OUTPUT_TEMPLATE, FILE_METADATA_PREFIX, outputTemplate, artifactYtdlpArgs,
  parseFileMetadata, publicationDate, applyPublicationTime,
};
