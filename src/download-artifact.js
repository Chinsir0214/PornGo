'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const OUTPUT_TEMPLATE = '%(title).180B [%(id)s].%(ext)s';
const FILE_METADATA_PREFIX = 'PORNGO_FILE:';
// Colons in the FROM template must be escaped for yt-dlp's FROM:TO parser.
// The empty fallback cannot match .+, so missing dates do not create a tag.
const CREATION_TIME_MAPPING = '%(timestamp>%Y-%m-%dT%H\\:%M\\:%SZ,upload_date>%Y-%m-%dT00\\:00\\:00Z|)s:(?P<meta_creation_time>.+)';

function artifactYtdlpArgs(directory, title) {
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
    '--progress', '-P', directory, '-o', OUTPUT_TEMPLATE,
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

async function applyPublicationTime(record, directory) {
  const date = publicationDate(record);
  if (!date) return;
  const file = path.resolve(record.filepath);
  // Only the final media in this task's destination may receive a timestamp.
  if (path.dirname(file) !== path.resolve(directory)) {
    throw new Error('视频输出路径不在下载目录中。');
  }
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error('视频输出路径不是文件。');
  await fsp.utimes(file, stat.atime, date);
}

module.exports = {
  OUTPUT_TEMPLATE, FILE_METADATA_PREFIX, artifactYtdlpArgs,
  parseFileMetadata, publicationDate, applyPublicationTime,
};
