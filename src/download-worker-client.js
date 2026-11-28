'use strict';

function createDownloadWorker(launch, { idleMs = 30000, shutdownMs = 8000 } = {}) {
  let current;
  let closed = false;
  let nextId = 0;
  const sessions = new Set();

  function finalizeSession(session, reason) {
    if (session.finalized) return session.exited;
    session.finalized = true;
    session.stopping = true;
    clearTimeout(session.idleTimer);
    if (current === session) current = null;
    const jobs = [...session.jobs.values()];
    session.jobs.clear();
    const cleanup = jobs.map(async (job) => {
      try {
        const pid = job.pid;
        if (pid) {
          const { terminateProcessTree } = require('./download-process');
          await terminateProcessTree({ pid, kill: () => process.kill(pid) });
        }
      } finally { job.reject(reason); }
    });
    Promise.allSettled(cleanup).then(() => {
      sessions.delete(session);
      session.resolveExit();
    });
    return session.exited;
  }

  function stop(session) {
    if (session.stopping) return;
    session.stopping = true;
    clearTimeout(session.idleTimer);
    if (current === session) current = null;
    // A shutdown can race the utility's initial spawn.
    try {
      if (session.child.kill() === false && !session.child.pid) {
        session.child.once('spawn', () => {
          try { session.child.kill(); } catch (error) { finalizeSession(session, error); }
        });
      }
    } catch (error) { finalizeSession(session, error); }
  }

  function send(session, message) {
    try { session.child.postMessage(message); }
    catch (cause) { stop(session); finalizeSession(session, new Error('下载工作进程已退出。', { cause })); }
  }

  function start() {
    const child = launch();
    const session = { child, jobs: new Map() };
    current = session;
    sessions.add(session);
    session.exited = new Promise((resolve) => { session.resolveExit = resolve; });
    child.once('exit', () => finalizeSession(session, new Error('下载工作进程已退出。')));
    child.on('error', (error) => { stop(session); finalizeSession(session, error); });
    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      const { type, id, pid, percent, details, error, result } = message;
      const job = session.jobs.get(id);
      if (!job) return;
      if (type === 'child') {
        if (pid == null || (Number.isSafeInteger(pid) && pid > 0)) job.pid = pid;
      } else if (type === 'progress' && !job.cancelled) job.progress?.(percent, details);
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
    let session;
    try { session = current || start(); } catch (error) { return Promise.reject(error); }
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
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        stopAll();
        for (const session of active) finalizeSession(session, new Error('下载工作进程关闭超时。'));
        resolve();
      }, shutdownMs);
    });
    const graceful = async () => {
      await cancel();
      stopAll();
      await Promise.all(active.map((session) => session.exited));
    };
    try { await Promise.race([graceful(), deadline]); }
    finally { clearTimeout(timer); }
  }
  return { request, cancel, close };
}

module.exports = { createDownloadWorker };
