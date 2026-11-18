'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createCredentialStore } = require('../src/credential-store');
const { credentialPageOrigin, fillWindowCredentials, readWindowCredentials } = require('../src/login-credentials');

async function storeHarness(t, enabled = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'porngo-credential-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'credentials.json');
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => enabled,
    encryptString(text) {
      assert.equal(enabled, true);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(data) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
  return { filePath, store: createCredentialStore({ filePath, safeStorage }), safeStorage };
}

const record = { origin: 'https://www.pornhub.com', username: 'synthetic-user', password: 'synthetic-password' };

test('encrypted credentials survive reopening, can be replaced and deleted, and stay scoped to their origin', async (t) => {
  const { store, filePath, safeStorage } = await storeHarness(t);
  await store.save(record);
  const raw = await fs.readFile(filePath, 'utf8');
  for (const value of Object.values(record)) assert.equal(raw.includes(value), false);
  assert.deepEqual(await store.status(), { available: true, saved: true });
  const reopened = createCredentialStore({ filePath, safeStorage });
  assert.deepEqual(await reopened.get(record.origin), record);
  assert.equal(await reopened.get('https://pornhub.com'), null);
  await assert.rejects(reopened.get('https://www.pornhub.com.evil.test'), /不允许/);
  const version = reopened.revision();
  const replacement = { ...record, username: 'new-synthetic-user' };
  await reopened.save(replacement);
  assert.ok(reopened.revision() > version);
  assert.deepEqual(await reopened.get(record.origin), replacement);
  await assert.rejects(reopened.save({ ...record, origin: 'http://www.pornhub.com' }), /有效/);
  await reopened.remove();
  assert.equal((await reopened.status()).saved, false);
  assert.equal(await store.get(record.origin), null);
});

test('unavailable encryption never falls back to plaintext storage', async (t) => {
  const { store, filePath } = await storeHarness(t, false);
  await assert.rejects(store.save(record), /系统加密不可用/);
  await assert.rejects(fs.readFile(filePath), { code: 'ENOENT' });
  assert.deepEqual(await store.status(), { available: false, saved: false });
});

test('corrupt encrypted credentials can be deleted without decrypting or exposing plaintext', async (t) => {
  const { store, filePath } = await storeHarness(t);
  await fs.writeFile(filePath, JSON.stringify({ version: 1, encrypted: 'YWJjZA==' }));
  await assert.rejects(store.get(record.origin), /无法解密/);
  assert.deepEqual(await store.status(), {
    available: true, saved: true, error: '保存的账号密码无法读取，请删除后重新保存。',
  });
  await store.remove();
  assert.equal((await store.status()).saved, false);
});

test('credential save distinguishes encryption and persistence errors and preserves the previous record', async (t) => {
  const { store, filePath, safeStorage } = await storeHarness(t);
  await store.save(record);
  const previous = await fs.readFile(filePath);
  const encryptionError = new Error('mock encryption failure');
  const encrypt = t.mock.method(safeStorage, 'encryptString', () => { throw encryptionError; });
  await assert.rejects(store.save(record), (error) => {
    assert.equal(error.message, '无法加密账号密码。');
    assert.equal(error.cause, encryptionError);
    return true;
  });
  encrypt.mock.restore();

  const writeError = new Error('mock rename failure');
  const rename = t.mock.method(fs, 'rename', async () => { throw writeError; });
  await assert.rejects(store.save(record), (error) => {
    assert.equal(error.message, '无法将已加密的账号密码保存到本机。');
    assert.equal(error.cause, writeError);
    return true;
  });
  rename.mock.restore();
  assert.deepEqual(await fs.readFile(filePath), previous);
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), [path.basename(filePath)]);
});

test('credential status samples cannot arrive out of order around deletion', async (t) => {
  const { store, filePath } = await storeHarness(t);
  await store.save(record);
  const encrypted = await fs.readFile(filePath);
  const missing = Object.assign(new Error('mock file was deleted'), { code: 'ENOENT' });
  let notifyReadStarted;
  let resumeRead;
  const readStarted = new Promise((resolve) => { notifyReadStarted = resolve; });
  const readMayResume = new Promise((resolve) => { resumeRead = resolve; });
  let deleted = false;
  t.mock.method(fs, 'stat', async () => {
    if (deleted) throw missing;
    return { isFile: () => true };
  });
  t.mock.method(fs, 'readFile', async () => {
    notifyReadStarted();
    await readMayResume;
    if (deleted) throw missing;
    return encrypted;
  });
  t.mock.method(fs, 'unlink', async () => { deleted = true; });

  const statuses = [];
  const older = store.status().then((status) => statuses.push(status.saved));
  await readStarted;
  const newer = store.remove().then(() => store.status()).then((status) => statuses.push(status.saved));
  await new Promise(setImmediate);
  resumeRead();
  await Promise.all([older, newer]);
  assert.deepEqual(statuses, [true, false]);
});

test('credential pages require exact HTTPS origin and login path', () => {
  for (const url of ['http://www.pornhub.com/login', 'https://www.pornhub.com.evil.test/login',
    'https://www.pornhub.com/register', 'https://www.pornhub.com/login/reset',
    'https://user:secret@www.pornhub.com/login', 'https://www.pornhub.com:444/login']) {
    assert.equal(credentialPageOrigin(url), null);
  }
  assert.equal(credentialPageOrigin('https://www.pornhub.com/login?redirect=home'), record.origin);
  assert.equal(credentialPageOrigin('https://pornhub.com/login/'), 'https://pornhub.com');
});

function fakeWindow() {
  let url = `${record.origin}/login`;
  const calls = [];
  const frame = { executeJavaScript: async (script) => { calls.push(script); return { filled: true }; } };
  const win = { isDestroyed: () => false, webContents: { mainFrame: frame, getURL: () => url } };
  return { win, calls, navigate: (next) => { url = next; } };
}

test('fill cancels after navigation, frame replacement or credential deletion during decryption', async () => {
  for (const mutate of [
    (fixture) => fixture.navigate('https://evil.test/login'),
    (fixture) => { fixture.win.webContents.mainFrame = {}; },
    (_fixture, state) => { state.revision++; },
  ]) {
    const fixture = fakeWindow();
    const state = { revision: 0 };
    const store = { revision: () => state.revision, get: async () => { mutate(fixture, state); return record; } };
    assert.deepEqual(await fillWindowCredentials(fixture.win, store), { filled: false });
    assert.equal(fixture.calls.length, 0);
  }
});

test('credential capture rejects a switched frame instead of saving returned fields', async () => {
  const fixture = fakeWindow();
  fixture.win.webContents.mainFrame.executeJavaScript = async () => {
    fixture.win.webContents.mainFrame = {};
    return record;
  };
  await assert.rejects(readWindowCredentials(fixture.win), /网页已切换/);
});

test('manual fill turns a navigation race into an error instead of a success notice', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const start = source.indexOf('async function fillLoginCredentials(');
  const end = source.indexOf('async function deleteLoginCredentials(', start);
  const context = { loginWindow: { isDestroyed: () => false }, credentialStore: {},
    fillWindowCredentials: async () => ({ filled: false }) };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await assert.rejects(context.fillLoginCredentials(), /网页或保存的账号密码已变化/);
});

test('every credential IPC rejects the remote login page and main-window subframes before access', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const guardStart = source.indexOf('function assertMainFrame(');
  const guardEnd = source.indexOf('function isAllowedAuthUrl(', guardStart);
  const ipcStart = source.indexOf('function registerIpc(');
  const ipcEnd = source.indexOf('app.whenReady()', ipcStart);
  const handlers = new Map();
  const trustedContents = { mainFrame: {} };
  let calls = 0;
  const action = () => { calls++; return { saved: true }; };
  const context = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    mainWindow: { webContents: trustedContents },
    openLogin: action, sessionStatus: action, logout: action, credentialsStatus: action,
    saveLoginCredentials: action, fillLoginCredentials: action, deleteLoginCredentials: action,
    resourceParser: { parse: action },
    downloadTasks: { startDownload: action, retryDownload: action, cancelDownload: action, removeQueuedDownload: action } };
  vm.createContext(context);
  vm.runInContext(source.slice(guardStart, guardEnd) + source.slice(ipcStart, ipcEnd) + '\nregisterIpc();', context);
  for (const channel of ['auth:credentials-status', 'auth:credentials-save',
    'auth:credentials-fill', 'auth:credentials-delete']) {
    const handler = handlers.get(channel);
    assert.equal(typeof handler, 'function');
    assert.throws(() => handler({ sender: {}, senderFrame: {} }), /不允许/);
    assert.throws(() => handler({ sender: trustedContents, senderFrame: {} }), /不允许/);
    assert.equal(calls, 0);
  }
  handlers.get('auth:credentials-status')({ sender: trustedContents, senderFrame: trustedContents.mainFrame });
  assert.equal(calls, 1);
});
