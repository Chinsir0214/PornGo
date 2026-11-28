'use strict';

const fs = require('node:fs/promises');
const { createAsyncQueue, atomicWriteFile } = require('./atomic-file');

const CREDENTIAL_ORIGINS = new Set(['https://www.pornhub.com', 'https://pornhub.com', 'https://cn.pornhub.com']);

function isCredentialOrigin(origin) {
  return typeof origin === 'string' && CREDENTIAL_ORIGINS.has(origin);
}

function validCredential(value) {
  return value && isCredentialOrigin(value.origin)
    && typeof value.username === 'string' && value.username.trim().length > 0
    && value.username.length <= 1024 && typeof value.password === 'string'
    && value.password.length > 0 && value.password.length <= 4096;
}

function createCredentialStore({ filePath, safeStorage }) {
  const serialize = createAsyncQueue();
  let revision = 0;
  const available = () => {
    try {
      return safeStorage.isEncryptionAvailable() === true
        && !(process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
          && safeStorage.getSelectedStorageBackend() === 'basic_text');
    } catch { return false; }
  };
  const requireEncryption = () => {
    if (!available()) throw new Error('系统加密不可用，无法保存或读取账号密码。');
  };
  async function readFile() {
    let data;
    try { data = await fs.readFile(filePath); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('无法读取保存的账号密码。', { cause: error });
    }
    return data;
  }
  function decrypt(data) {
    requireEncryption();
    try {
      if (data.length > 32 * 1024) throw new Error();
      const envelope = JSON.parse(data.toString('utf8'));
      if (envelope.version !== 1 || typeof envelope.encrypted !== 'string'
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.encrypted)) throw new Error();
      const record = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64')));
      if (!validCredential(record)) throw new Error();
      return record;
    } catch (cause) {
      throw new Error('保存的账号密码无法解密，请删除后重新保存。', { cause });
    }
  }
  async function readStatus() {
    const data = await readFile();
    const result = { available: available(), saved: data !== null };
    if (result.saved && result.available) {
      try { decrypt(data); } catch { result.error = '保存的账号密码无法读取，请删除后重新保存。'; }
    }
    return result;
  }
  return {
    status: () => serialize(readStatus),
    revision: () => revision,
    async get(origin) {
      if (!isCredentialOrigin(origin)) throw new Error('不允许在此网站使用保存的账号密码。');
      return serialize(async () => {
        const data = await readFile();
        return data === null ? null : { ...decrypt(data), origin };
      });
    },
    save(record, { expectedRevision } = {}) {
      if (Number.isInteger(expectedRevision) && expectedRevision !== revision) {
        return Promise.reject(new Error('保存已被删除或覆盖，请重新读取表单后再试。'));
      }
      if (!validCredential(record)) return Promise.reject(new Error('请输入有效的账号和密码。'));
      revision++;
      return serialize(async () => {
        requireEncryption();
        let encrypted;
        try {
          encrypted = safeStorage.encryptString(JSON.stringify({
            origin: record.origin, username: record.username, password: record.password,
          })).toString('base64');
        } catch (cause) {
          throw new Error('无法加密账号密码。', { cause });
        }
        const data = JSON.stringify({ version: 1, encrypted });
        try {
          await atomicWriteFile(filePath, data, { mode: 0o600 });
        } catch (cause) {
          throw new Error('无法将已加密的账号密码保存到本机。', { cause });
        }
      });
    },
    remove() {
      revision++;
      return serialize(async () => {
        try { await fs.unlink(filePath); } catch (error) {
          if (error.code !== 'ENOENT') throw new Error('无法删除保存的账号密码。', { cause: error });
        }
      });
    },
  };
}

module.exports = { createCredentialStore, isCredentialOrigin };
