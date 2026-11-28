// @ts-check
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** @returns {<T>(action: () => T | PromiseLike<T>) => Promise<T>} */
function createAsyncQueue() {
  /** @type {Promise<unknown>} */
  let pending = Promise.resolve();
  return (action) => {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  };
}

/**
 * @param {string} filePath
 * @param {Parameters<import("node:fs/promises").FileHandle["writeFile"]>[0]} data
 * @param {{mode?: import("node:fs").Mode}} [options]
 */
async function atomicWriteFile(filePath, data, { mode } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', mode);
  try {
    try { await handle.writeFile(data); } finally { await handle.close(); }
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

module.exports = { createAsyncQueue, atomicWriteFile };
