'use strict';

function createDownloadWorker(launch, { idleMs = 30000, shutdownMs = 8000 } = {}) {
  let current;
  let closed = false;
  let nextId = 0;
  const sessions = new Set();

  function stop(session) {
    if (session.stopping) return;
    session.stopping = true;
    clearTimeout(session.idleTimer);
    if (current === session) current = null;
    // A shutdown can race the utility's initial spawn.
    if (session.child.kill() === false && !session.child.pid) {
      session.child.once('spawn', () => session.child.kill());
    }
  }

  function send(session, message) {
    try { session.child.postMessage(message); }
    catch { stop(session); }
  }

  function start() {
    const child = launch();
    const session = { child, jobs: new Map() };
    current = session;
    sessions.add(session);
    session.exited = new Promise((resolve) => {
      child.once('exit', async () => {
        session.stopping = true;
        clearTimeout(session.idleTimer);
        if (current === session) current = null;
        // The utility may crash with yt-dlp/FFmpeg still running. Only reap PIDs
        // reported by this utility that haven't subsequently reported an exit.
        await Promise.allSettled([...session.jobs.values()].map(async (job) => {
          try {
            if (job.pid) {
              const { terminateProcessTree } = require('./download-process');
              await terminateProcessTree({ pid: job.pid, kill: () => process.kill(job.pid) });
            }
          } finally { job.reject(new Error('下载工作进程已退出。')); }
        }));
        session.jobs.clear();
        sessions.delete(session);
        resolve();
      });
    });
    child.on('error', () => stop(session));
    child.on('message', ({ type, id, pid, percent, details, error, result }) => {
      const job = session.jobs.get(id);
      if (!job) return;
      if (type === 'child') job.pid = pid;
      else if (type === 'progress' && !job.cancelled) job.progress?.(percent, details);
      else if (type === 'result') {
        session.jobs.delete(id);
        if (error) job.reject(new Error(error));
        else job.resolve(result);
        if (!closed && !session.stopping && session.jobs.size === 0) {
          session.idleTimer = setTimeout(() => stop(session), idleMs);
          session.idleTimer.unref();
        }
      }
    });
    return session;
  }

  function request(type, params, { group, progress } = {}) {
    if (closed) return Promise.reject(new Error('应用正在退出。'));
    const session = current || start();
    clearTimeout(session.idleTimer);
    const id = ++nextId;
    const job = { group, progress };
    const promise = new Promise((resolve, reject) => {
      Object.assign(job, { resolve, reject });
      session.jobs.set(id, job);
      send(session, { type, id, params });
    });
    job.promise = promise;
    return promise;
  }

  function cancel(group) {
    const waiting = [];
    for (const session of sessions) {
      for (const [id, job] of session.jobs) {
        if (group !== undefined && job.group !== group) continue;
        if (!session.stopping && !job.cancelled) {
          job.cancelled = true;
          send(session, { type: 'cancel', id });
        }
        waiting.push(job.promise);
      }
    }
    return Promise.allSettled(waiting);
  }

  async function close() {
    closed = true;
    const active = [...sessions];
    if (!active.length) return;
    for (const session of active) clearTimeout(session.idleTimer);
    const stopAll = () => active.forEach(stop);
    const deadline = setTimeout(stopAll, shutdownMs);
    try {
      await cancel();
      stopAll();
      await Promise.all(active.map((session) => session.exited));
    } finally { clearTimeout(deadline); }
  }
  return { request, cancel, close };
}

module.exports = { createDownloadWorker };
