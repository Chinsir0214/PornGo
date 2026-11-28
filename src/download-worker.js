'use strict';

const { spawn } = require('node:child_process');
const { runDownloadProcess, downloadSpawnOptions, terminateProcessTree } = require('./download-process');
const { readMetadata } = require('./resource-parser');
const { explainYtdlpError, parseProgressLine } = require('./ytdlp-protocol');
const { StringDecoder } = require('node:string_decoder');

const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 150;

function launchError(error, packaged) {
  if (error.code !== 'ENOENT') return `无法启动 yt-dlp：${error.message}`;
  return packaged ? '安装包缺少 yt-dlp。请重新安装包含下载工具的完整版本。'
    : '未找到 yt-dlp。请在 PornGo 目录运行 powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1，然后重启应用。';
}

async function captureMetadata(params, spawnProcess, job) {
  const { binary, baseArgs, url, batch, packaged } = params;
  const args = [...baseArgs, batch ? '--yes-playlist' : '--no-playlist',
    ...(batch ? ['--flat-playlist'] : []), '--dump-single-json', '--skip-download', url];
  const child = spawnProcess(binary, args, downloadSpawnOptions());
  const chunks = [];
  let bytes = 0;
  let stderr = '';
  const decoder = new StringDecoder('utf8');
  let oversized = false;
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (job.cancelled || oversized) return;
      bytes += chunk.length;
      if (bytes > MAX_METADATA_BYTES) {
        chunks.length = 0;
        oversized = true;
        stopJob(job);
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + decoder.write(chunk)).slice(-4000); });
    child.once('error', (error) => reject(new Error(launchError(error, packaged))));
    child.once('close', (code) => {
      stderr += decoder.end();
      if (job.cancelled) reject(new Error('已取消解析。'));
      else if (oversized) reject(new Error('页面视频信息过大，已停止解析。'));
      else if (code === 0) resolve();
      else reject(new Error(explainYtdlpError(stderr, `yt-dlp 退出，代码 ${code}。`)));
    });
  }).finally(() => job.stopping);
  if (job.cancelled) throw new Error('已取消解析。');
  return readMetadata(Buffer.concat(chunks, bytes).toString('utf8'), batch);
}

function stopJob(job) {
  const child = job.child;
  if (!child) return;
  job.stopping ||= terminateProcessTree(child).catch(() => false).finally(() => {
    // Descendants can keep these pipes open after the downloader exits.
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
  });
}

function serveDownloads(port) {
  const post = (message) => {
    try { port.postMessage(message); } catch { /* The parent channel has closed. */ }
  };
  const jobs = new Map();
  port.on('message', async (event) => {
    try { await handleMessage(event?.data); }
    catch (error) {
      if (Number.isSafeInteger(event?.data?.id)) {
        post({ type: 'result', id: event.data.id, error: String(error?.message || error) });
      }
    }
  });

  async function handleMessage(data) {
    if (!data || !Number.isSafeInteger(data.id) || data.id <= 0) return;
    const { type, id, params } = data;
    if (type === 'cancel') {
      const job = jobs.get(id);
      if (job) {
        job.cancelled = true;
        clearTimeout(job.progressTimer);
        stopJob(job);
      }
      return;
    }
    if (jobs.has(id)) return;
    if (!['download', 'metadata'].includes(type) || typeof params?.binary !== 'string' ||
        !Array.isArray(params.baseArgs) || !params.baseArgs.every((arg) => typeof arg === 'string') ||
        (type === 'metadata' ? typeof params.url !== 'string' :
          typeof params.video?.url !== 'string' || typeof params.directory !== 'string')) {
      throw new Error('下载操作无效。');
    }
    const job = {};
    jobs.set(id, job);
    const spawnProcess = (...args) => {
      const child = spawn(...args);
      job.child = child;
      if (child.pid) {
        post({ type: 'child', id, pid: child.pid });
        child.once('close', () => {
          job.child = null;
          post({ type: 'child', id, pid: null });
        });
      }
      return child;
    };
    try {
      let result;
      if (type === 'metadata') result = await captureMetadata(params, spawnProcess, job);
      else {
        let nextProgress = 0;
        let pending;
        const flush = () => {
          clearTimeout(job.progressTimer);
          job.progressTimer = null;
          if (!pending || job.cancelled) return;
          post(pending);
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
      }
      await job.stopping;
      post({ type: 'result', id, result });
    } finally {
      await job.stopping;
      clearTimeout(job.progressTimer);
      jobs.delete(id);
    }
  }
}

if (process.parentPort) serveDownloads(process.parentPort);
module.exports = { serveDownloads };
