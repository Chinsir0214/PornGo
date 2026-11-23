'use strict';

const { spawn } = require('node:child_process');
const { runDownloadProcess, downloadSpawnOptions, terminateProcessTree } = require('./download-process');
const { readMetadata } = require('./resource-parser');
const { explainYtdlpError } = require('./pornhub');

const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 150;

function launchError(error, packaged) {
  if (error.code !== 'ENOENT') return `无法启动 yt-dlp：${error.message}`;
  return packaged ? '安装包缺少 yt-dlp。请重新安装包含下载工具的完整版本。'
    : '未找到 yt-dlp。请在 PornGo 目录运行 powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1，然后重启应用。';
}

async function captureMetadata(params, spawnProcess) {
  const { binary, baseArgs, url, batch, packaged } = params;
  const args = [...baseArgs, batch ? '--yes-playlist' : '--no-playlist',
    ...(batch ? ['--flat-playlist'] : []), '--dump-single-json', '--skip-download', url];
  const child = spawnProcess(binary, args, downloadSpawnOptions());
  const chunks = [];
  let bytes = 0;
  let stderr = '';
  let stopping;
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (stopping) return;
      bytes += chunk.length;
      if (bytes > MAX_METADATA_BYTES) {
        chunks.length = 0;
        stopping = terminateProcessTree(child);
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once('error', (error) => reject(new Error(launchError(error, packaged))));
    child.once('close', (code) => {
      if (stopping) reject(new Error('页面视频信息过大，已停止解析。'));
      else if (code === 0) resolve();
      else reject(new Error(explainYtdlpError(stderr, `yt-dlp 退出，代码 ${code}。`)));
    });
  }).finally(() => stopping);
  return readMetadata(Buffer.concat(chunks, bytes).toString('utf8'), batch);
}

function serveDownloads(port) {
  const jobs = new Map();
  port.on('message', async ({ data: { type, id, params } }) => {
    if (type === 'cancel') {
      const job = jobs.get(id);
      if (job) {
        job.cancelled = true;
        clearTimeout(job.progressTimer);
      }
      if (job?.child) job.stopping ||= terminateProcessTree(job.child);
      return;
    }
    const job = {};
    jobs.set(id, job);
    const spawnProcess = (...args) => {
      const child = spawn(...args);
      job.child = child;
      if (child.pid) {
        port.postMessage({ type: 'child', id, pid: child.pid });
        child.once('exit', () => {
          job.child = null;
          port.postMessage({ type: 'child', id, pid: null });
        });
      }
      return child;
    };
    try {
      let result;
      if (type === 'metadata') result = await captureMetadata(params, spawnProcess);
      else if (type === 'download') {
        let nextProgress = 0;
        let pending;
        const flush = () => {
          clearTimeout(job.progressTimer);
          job.progressTimer = null;
          if (!pending || job.cancelled) return;
          port.postMessage(pending);
          pending = null;
          nextProgress = performance.now() + PROGRESS_INTERVAL_MS;
        };
        const reportProgress = (percent, details) => {
          if (job.cancelled) return;
          pending = { type: 'progress', id, percent, details };
          const delay = nextProgress - performance.now();
          if (delay <= 0) flush();
          else job.progressTimer ||= setTimeout(flush, delay);
        };
        const { video, directory, format, fragmentConcurrency, binary, baseArgs, packaged } = params;
        const error = await runDownloadProcess({ directory, format, fragmentConcurrency, children: new Set() },
          { video }, reportProgress, { binary, baseArgs, spawnProcess, launchError: (e) => launchError(e, packaged) });
        flush();
        result = { error, fileName: video.downloadFileName };
      } else throw new Error('下载操作无效。');
      await job.stopping;
      port.postMessage({ type: 'result', id, result });
    } catch (error) {
      await job.stopping;
      port.postMessage({ type: 'result', id, error: String(error.message || error) });
    } finally {
      clearTimeout(job.progressTimer);
      jobs.delete(id);
    }
  });
}

if (process.parentPort) serveDownloads(process.parentPort);
module.exports = { serveDownloads };
