'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { FILE_METADATA_PREFIX, artifactYtdlpArgs, parseFileMetadata, applyPublicationTime } = require('./download-artifact');
const { parseProgressLine, explainYtdlpError } = require('./ytdlp-protocol');

function downloadSpawnOptions() {
  // Keep the tree root alive if the utility dies. On Windows libuv's default
  // job kills only direct children, leaving FFmpeg without a root for taskkill.
  return { windowsHide: true, shell: false, detached: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } };
}

function taskkillExecutable() {
  const root = process.env.SystemRoot;
  return root && path.win32.isAbsolute(root) ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe';
}

function stopDirectChild(child) {
  try { child.kill(); } catch { /* It may have already exited. */ }
}

async function terminateProcessTree(child, {
  platform = process.platform, spawnProcess = spawn, killProcess = process.kill,
  timeoutMs = 5000,
} = {}) {
  const pid = child && child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    stopDirectChild(child);
    return false;
  }

  if (platform !== 'win32') {
    try {
      // Non-Windows downloads start in their own process group.
      killProcess(-pid, 'SIGTERM');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { killProcess(-pid, 0); }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      }
      killProcess(-pid, 'SIGKILL');
      return true;
    } catch {
      stopDirectChild(child);
      return false;
    }
  }

  return new Promise((resolve) => {
    let killer;
    try {
      // PID comes only from the ChildProcess we created; no shell is involved.
      killer = spawnProcess(taskkillExecutable(), ['/PID', String(pid), '/T', '/F'], {
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
      ...artifactYtdlpArgs(task.directory, video.downloadTitle, video.url),
    ];
    if (task.format) args.push('-f', task.format);
    args.push('-N', String(task.fragmentConcurrency));
    args.push(video.url);
    const child = spawnProcess(binary, args, downloadSpawnOptions());
    let stderr = '';
    let lineBuffer = '';
    let settled = false;
    let highestProgress = 0;
    let fileMetadata = null;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const complete = (error) => {
      if (settled) return;
      settled = true;
      resolve(error);
    };
    const handleLine = (line) => {
      const metadata = parseFileMetadata(line);
      if (metadata) {
        fileMetadata = metadata;
        video.downloadFileName = path.basename(metadata.filepath);
        return;
      }
      const progress = parseProgressLine(line);
      if (!progress) return;
      highestProgress = Math.max(highestProgress, progress.percent);
      reportProgress(highestProgress, progress);
    };
    child.stdout.on('data', (chunk) => {
      lineBuffer += stdoutDecoder.write(chunk);
      const lines = lineBuffer.split(/\r\n|\r|\n/);
      lineBuffer = lines.pop();
      // Keep complete file records even if the path spans many chunks.
      if (!lineBuffer.startsWith(FILE_METADATA_PREFIX)) lineBuffer = lineBuffer.slice(-16384);
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-4000); });
    child.on('error', (error) => complete(error.code === 'ENOENT'
      ? { message: launchError(error), retryable: false } : launchError(error)));
    child.on('close', async (code) => {
      if (settled) return;
      stderr += stderrDecoder.end();
      lineBuffer += stdoutDecoder.end();
      if (lineBuffer) handleLine(lineBuffer);
      if (code === 0 && !fileMetadata) {
        complete({ message: '视频已下载，但未取得最终文件信息，无法确认发布时间设置。', retryable: false });
        return;
      }
      if (code === 0 && fileMetadata) {
        try { await applyTime(fileMetadata, task.directory); }
        catch (error) {
          complete({ message: `视频已下载，但设置发布时间失败：${error.message}`, retryable: false });
          return;
        }
      }
      if (code === 0) return complete(null);
      const message = explainYtdlpError(stderr, `下载失败（退出码 ${code}）。`);
      const permanent = /redirection detected|require[sd]? log[ -]?in|log[ -]?in (?:is )?required|sign in to|video (?:has been |is )?(?:deleted|removed|private)|no video formats found|requested format is not available/i;
      complete(permanent.test(stderr) ? { message, retryable: false } : message);
    });
  });
}

module.exports = { taskkillExecutable, downloadSpawnOptions, terminateProcessTree, runDownloadProcess };
