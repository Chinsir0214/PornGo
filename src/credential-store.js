'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CREDENTIAL_ORIGINS = new Set(['https://www.pornhub.com', 'https://pornhub.com']);

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
  let pending = Promise.resolve();
  let revision = 0;
  const available = () => {
    try { return safeStorage.isEncryptionAvailable() === true; } catch { return false; }
  };
  const requireEncryption = () => {
    if (!available()) throw new Error('系统加密不可用，无法保存或读取账号密码。');
  };
  async function read() {
    let data;
    try { data = await fs.readFile(filePath); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('无法读取保存的账号密码。');
    }
    requireEncryption();
    try {
      if (data.length > 32 * 1024) throw new Error();
      const envelope = JSON.parse(data.toString('utf8'));
      if (envelope.version !== 1 || typeof envelope.encrypted !== 'string'
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.encrypted)) throw new Error();
      const record = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64')));
      if (!validCredential(record)) throw new Error();
      return record;
    } catch {
      throw new Error('保存的账号密码无法解密，请删除后重新保存。');
    }
  }
  function serialize(action) {
    const next = pending.then(action, action);
    pending = next.catch(() => {});
    return next;
  }
  async function readStatus() {
    let exists;
    try { exists = (await fs.stat(filePath)).isFile(); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取保存的账号密码。');
      exists = false;
    }
    const result = { available: available(), saved: exists };
    if (exists && result.available) {
      try {
        await read();
      } catch { result.error = '保存的账号密码无法读取，请删除后重新保存。'; }
    }
    return result;
  }
  return {
    status: () => serialize(readStatus),
    revision: () => revision,
    async get(origin) {
      if (!isCredentialOrigin(origin)) throw new Error('不允许在此网站使用保存的账号密码。');
      await pending;
      const record = await read();
      return record && record.origin === origin ? record : null;
    },
    save(record) {
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
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, filePath);
        } catch (cause) {
          throw new Error('无法将已加密的账号密码保存到本机。', { cause });
        } finally {
          await fs.unlink(temporary).catch(() => {});
        }
      });
    },
    remove() {
      revision++;
      return serialize(async () => {
        try { await fs.unlink(filePath); } catch (error) {
          if (error.code !== 'ENOENT') throw new Error('无法删除保存的账号密码。');
        }
      });
    },
  };
}

module.exports = { createCredentialStore, isCredentialOrigin };
