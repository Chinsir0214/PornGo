'use strict';

const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { artifactYtdlpArgs, parseFileMetadata, applyPublicationTime } = require('./download-artifact');
const { parseProgressLine, explainYtdlpError } = require('./pornhub');

function downloadSpawnOptions(platform = process.platform) {
  return { windowsHide: true, shell: false, detached: platform !== 'win32' };
}

function stopDirectChild(child) {
  try { child.kill(); } catch { /* It may have already exited. */ }
}

function terminateProcessTree(child, {
  platform = process.platform, spawnProcess = spawn, killProcess = process.kill,
  timeoutMs = 5000,
} = {}) {
  const pid = child && child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    stopDirectChild(child);
    return Promise.resolve(false);
  }

  if (platform !== 'win32') {
    try {
      // Non-Windows downloads start in their own process group.
      killProcess(-pid, 'SIGTERM');
      return Promise.resolve(true);
    } catch {
      stopDirectChild(child);
      return Promise.resolve(false);
    }
  }

  return new Promise((resolve) => {
    let killer;
    try {
      // PID comes only from the ChildProcess we created; no shell is involved.
      killer = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, shell: false, stdio: 'ignore',
      });
    } catch {
      stopDirectChild(child);
      resolve(false);
      return;
    }
    let done = false;
    let timer;
    const finish = (success) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!success) stopDirectChild(child);
      resolve(success);
    };
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { killer.kill(); } catch { /* The helper may already be exiting. */ }
      stopDirectChild(child);
      resolve(false);
    }, timeoutMs);
  });
}

function runDownloadProcess(task, { video }, reportProgress, {
  binary, baseArgs, launchError, spawnProcess = spawn, applyTime = applyPublicationTime,
}) {
  return new Promise((resolve) => {
    const args = [
      ...baseArgs, '--no-playlist', '--newline',
      ...artifactYtdlpArgs(task.directory, video.downloadTitle),
    ];
    if (task.format) args.push('-f', task.format);
    args.push('-N', String(task.fragmentConcurrency));
    args.push(video.url);
    const child = spawnProcess(binary, args, downloadSpawnOptions());
    task.children.add(child);
    let stderr = '';
    let lineBuffer = '';
    let settled = false;
    let highestProgress = 0;
    let fileMetadata = null;
    const stdoutDecoder = new StringDecoder('utf8');
    const complete = (error) => {
      if (settled) return;
      settled = true;
      task.children.delete(child);
      resolve(error);
    };
    const handleLine = (line) => {
      const metadata = parseFileMetadata(line);
      if (metadata) {
        fileMetadata = metadata;
        return;
      }
      const progress = parseProgressLine(line);
      if (!progress) return;
      highestProgress = Math.max(highestProgress, progress.percent);
      reportProgress(highestProgress, progress);
    };
    child.stdout.on('data', (chunk) => {
      lineBuffer += stdoutDecoder.write(chunk);
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop().slice(-16384);
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.on('error', (error) => complete(launchError(error)));
    child.on('close', async (code) => {
      if (settled) return;
      lineBuffer += stdoutDecoder.end();
      if (lineBuffer) handleLine(lineBuffer);
      if (code === 0 && !fileMetadata) {
        complete('视频已下载，但未取得最终文件信息，无法确认发布时间设置。');
        return;
      }
      if (code === 0 && fileMetadata) {
        try { await applyTime(fileMetadata, task.directory); }
        catch (error) {
          complete(`视频已下载，但设置发布时间失败：${error.message}`);
          return;
        }
      }
      complete(code === 0 ? null : explainYtdlpError(stderr, `下载失败（退出码 ${code}）。`));
    });
  });
}

module.exports = { downloadSpawnOptions, terminateProcessTree, runDownloadProcess };
