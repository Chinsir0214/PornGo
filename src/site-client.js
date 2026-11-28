'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { isSiteHost, isSiteCookie, serializeCookies } = require('./pornhub');

function isAllowedAuthUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && isSiteHost(url.hostname)
      && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function pageError(message, status) {
  return Object.assign(new Error(message), { status, retryable: false });
}

async function readPage(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw pageError('网站页面超过大小限制。', response.status);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw pageError('网站页面超过大小限制。', response.status);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function createSiteClient({ authSession, quitSignal, tempDirectory = os.tmpdir(),
  maxBytes = 10 * 1024 * 1024, delay = sleep }) {
  const activeDirs = new Set();

  async function siteCookies() {
    return (await authSession().cookies.get({})).filter(isSiteCookie);
  }

  async function removeDirectory(dir) {
    await fsp.rm(dir, { recursive: true, force: true });
    activeDirs.delete(dir);
  }

  async function sweepOrphans() {
    const entries = await fsp.readdir(tempDirectory, { withFileTypes: true });
    await Promise.allSettled(entries.map(async (entry) => {
      // mkdtemp adds exactly six random characters. Other porngo-* directories
      // can belong to unrelated tools or tests sharing the same temp folder.
      const match = /^porngo-(?:(\d+)-)?[a-zA-Z0-9]{6}$/.exec(entry.name);
      if (!match || !entry.isDirectory()) return;
      const dir = path.join(tempDirectory, entry.name);
      if (activeDirs.has(dir)) return;
      if (match[1]) {
        try { process.kill(Number(match[1]), 0); return; }
        catch (error) { if (error.code !== 'ESRCH') return; }
      } else if (Date.now() - (await fsp.stat(dir)).mtimeMs < 86400000) {
        // Legacy directories have no owner PID. Give older running apps a day.
        return;
      }
      await removeDirectory(dir);
    }));
  }

  async function createCookieFile() {
    quitSignal?.throwIfAborted();
    const dir = await fsp.mkdtemp(path.join(tempDirectory, `porngo-${process.pid}-`));
    activeDirs.add(dir);
    const file = path.join(dir, 'cookies.txt');
    try {
      const cookies = await siteCookies();
      quitSignal?.throwIfAborted();
      await fsp.writeFile(file, serializeCookies(cookies), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      quitSignal?.throwIfAborted();
      return { file, cleanup: () => removeDirectory(dir) };
    } catch (error) {
      await removeDirectory(dir).catch(() => {});
      throw error;
    }
  }

  function cleanupCookieDirs() {
    return Promise.allSettled([...activeDirs].map(removeDirectory));
  }

  async function fetchPage(initialUrl, signal) {
    let url = initialUrl;
    for (let hops = 0; ; hops++) {
      if (!isAllowedAuthUrl(url)) throw pageError('不允许访问此网站地址。');
      const response = await authSession().fetch(url, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || hops === 5) throw pageError('网站重定向无效或次数过多。', response.status);
        try { url = new URL(location, url).href; }
        catch { throw pageError('网站重定向地址无效。', response.status); }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const error = pageError(`网站返回 HTTP ${response.status}。`, response.status);
        error.retryable = response.status >= 500 && response.status < 600;
        throw error;
      }
      return readPage(response, maxBytes);
    }
  }

  async function fetchSitePage(url, { attempts = 3, timeoutMs = 30000, signal } = {}) {
    const stop = AbortSignal.any([quitSignal, signal].filter(Boolean));
    for (let attempt = 1; ; attempt++) {
      stop.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        return await fetchPage(url, AbortSignal.any([timeout, stop]));
      } catch (error) {
        stop.throwIfAborted();
        if (attempt >= attempts || error.retryable === false) {
          const message = timeout.aborted || error.name === 'TimeoutError' ? '读取网站页面超时。' : error.message;
          const failure = new Error(`内嵌网页无法读取页面：${message}`, { cause: error });
          if (Number.isInteger(error.status)) failure.status = error.status;
          if (error.retryable === false) failure.retryable = false;
          throw failure;
        }
        await delay(100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 80), undefined, { signal: stop });
      }
    }
  }

  return { siteCookies, createCookieFile, sweepOrphans, cleanupCookieDirs, fetchSitePage };
}

module.exports = { createSiteClient, isAllowedAuthUrl };
