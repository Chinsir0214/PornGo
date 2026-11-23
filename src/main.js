'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, session, safeStorage, utilityProcess } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FRAGMENT_CONCURRENCY, VIDEO_CONCURRENCY } = require('./download-queue');
const { createDownloadWorker } = require('./download-worker-client');
const { loadDownloadDirectory, saveDownloadDirectory } = require('./download-directory');
const { createResourceParser } = require('./resource-parser');
const { createDownloadTasks } = require('./download-tasks');
const { inspectSiteLoginState, createRevisionGate, startStatusPolling, resolveObservedLogin } = require('./auth-status');
const { createCredentialStore } = require('./credential-store');
const { readWindowCredentials, fillWindowCredentials } = require('./login-credentials');
const {
  isSiteHost, isSiteCookie, serializeCookies,
} = require('./pornhub');

const AUTH_PARTITION = 'persist:porngo-auth';
const APP_USER_MODEL_ID = 'com.porngo.app';
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'icon-0.9.2.ico')
  : path.join(__dirname, '..', 'assets', 'icon-0.9.2.ico');
let mainWindow = null;
let loginWindow = null;
let configuredAuthSession = null;
let loginWindowRevision = 0;
let clearingSession = false;
const authRevision = createRevisionGate();
let stopAuthPolling = null;
let recentlyVerifiedLogin = false;
let loginClosePending = false;
let loginCloseApproved = false;

app.setName('PornGo');
app.setPath('userData', path.join(app.getPath('appData'), 'PornGo'));
Menu.setApplicationMenu(null);
const credentialStore = createCredentialStore({
  filePath: path.join(app.getPath('userData'), 'login-credentials.json'), safeStorage,
});
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

function setWindowAppDetails(win) {
  if (process.platform !== 'win32') return;
  const executable = `"${process.execPath}"`;
  win.setAppDetails({
    appId: APP_USER_MODEL_ID,
    appIconPath: ICON_PATH,
    appIconIndex: 0,
    relaunchCommand: app.isPackaged ? executable : `${executable} "${app.getAppPath()}"`,
    relaunchDisplayName: 'PornGo',
  });
}

function authSession() {
  if (!configuredAuthSession) {
    const auth = session.fromPartition(AUTH_PARTITION);
    auth.setUserAgent(auth.getUserAgent().replace(/\sElectron\/[^\s]+/, ''));
    auth.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    auth.on('will-download', (event) => event.preventDefault());
    configuredAuthSession = auth;
  }
  return configuredAuthSession;
}

function assertMainFrame(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('不允许从此页面调用应用功能。');
  }
}

function isAllowedAuthUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && isSiteHost(url.hostname)
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: 'PornGo',
    icon: ICON_PATH,
    show: false,
    width: 1060,
    height: 780,
    minWidth: 980,
    minHeight: 780,
    frame: false,
    backgroundColor: '#18123c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  setWindowAppDetails(mainWindow);
  const currentWindow = mainWindow;
  currentWindow.once('ready-to-show', () => {
    if (!currentWindow.isDestroyed()) currentWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  const sendWindowState = () => {
    if (!currentWindow.isDestroyed()) {
      currentWindow.webContents.send('window:state', { maximized: currentWindow.isMaximized() });
    }
  };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.webContents.on('did-finish-load', sendWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

async function siteCookies() {
  const cookies = await authSession().cookies.get({});
  return cookies.filter(isSiteCookie);
}

async function readSessionStatus(revision = authRevision.current(), { revealAccountMenu = false } = {}) {
  const cookieCount = (await siteCookies()).length;
  if (!authRevision.isCurrent(revision)) return { cookieCount, loginState: 'unknown' };
  if (!cookieCount) {
    recentlyVerifiedLogin = false;
    return { cookieCount, loginState: 'empty' };
  }
  let observed = 'unknown';
  const observingWindow = loginWindow;
  if (observingWindow && !observingWindow.isDestroyed()
      && isAllowedAuthUrl(observingWindow.webContents.getURL())) {
    try {
      observed = await observingWindow.webContents.executeJavaScript(
        `(${inspectSiteLoginState.toString()})({revealAccountMenu:${Boolean(revealAccountMenu)}})`);
      if (!authRevision.isCurrent(revision) || loginWindow !== observingWindow
          || observingWindow.isDestroyed()) return { cookieCount, loginState: 'unknown' };
    } catch {
      // The page may be navigating. Its cookies can still be used.
    }
  }
  const resolved = resolveObservedLogin(observed, recentlyVerifiedLogin);
  recentlyVerifiedLogin = resolved.recentlyVerified;
  return { cookieCount, loginState: resolved.loginState };
}

async function sessionStatus() {
  const revision = authRevision.current();
  return { ...await readSessionStatus(revision), revision };
}

let authStatusTimer = null;
function scheduleSessionStatusUpdate() {
  if (loginClosePending || clearingSession) return;
  const revision = authRevision.begin();
  const observingWindow = loginWindow;
  if (authStatusTimer) clearTimeout(authStatusTimer);
  authStatusTimer = setTimeout(async () => {
    authStatusTimer = null;
    const result = await readSessionStatus(revision, { revealAccountMenu: true })
      .catch(() => ({ cookieCount: null, loginState: 'error' }));
    if (authRevision.isCurrent(revision) && mainWindow && !mainWindow.isDestroyed()
        && loginWindow === observingWindow && observingWindow && !observingWindow.isDestroyed()
        && !clearingSession && !loginClosePending) {
      mainWindow.webContents.send('auth:status-changed', { ...result, revision });
      if (result.loginState === 'verified') {
        // This close follows an observed authenticated menu, not cookie presence.
        loginCloseApproved = true;
        observingWindow.close();
      }
    }
  }, 500);
}

function stopLoginObservation() {
  stopAuthPolling?.();
  stopAuthPolling = null;
  if (authStatusTimer) clearTimeout(authStatusTimer);
  authStatusTimer = null;
}

function loginWindowStatus() {
  return { windowOpen: Boolean(loginWindow && !loginWindow.isDestroyed()), revision: loginWindowRevision };
}

function publishLoginWindowStatus() {
  loginWindowRevision++;
  const status = loginWindowStatus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:window-changed', status);
  return status;
}

function openLogin() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    if (loginWindow.isMinimized()) loginWindow.restore();
    loginWindow.show();
    loginWindow.focus();
    return loginWindowStatus();
  }
  authRevision.begin();
  loginClosePending = false;
  loginCloseApproved = false;
  loginWindow = new BrowserWindow({
    title: 'PornGo · 网页登录',
    icon: ICON_PATH,
    show: false,
    width: 980,
    height: 760,
    minWidth: 700,
    minHeight: 520,
    skipTaskbar: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: authSession(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  setWindowAppDetails(loginWindow);
  setupLoginCredentials(loginWindow);
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAuthUrl(url)) loginWindow.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  loginWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedAuthUrl(url)) event.preventDefault();
  });
  loginWindow.webContents.on('did-finish-load', scheduleSessionStatusUpdate);
  loginWindow.webContents.on('did-navigate-in-page', scheduleSessionStatusUpdate);
  loginWindow.webContents.on('did-navigate', scheduleSessionStatusUpdate);
  stopAuthPolling = startStatusPolling(() => {
    if (loginWindow && !loginWindow.isDestroyed() && !clearingSession) scheduleSessionStatusUpdate();
  });
  loginWindow.on('page-title-updated', (event) => event.preventDefault());
  loginWindow.on('close', (event) => {
    if (clearingSession || loginCloseApproved) return;
    event.preventDefault();
    if (loginClosePending) return;
    loginClosePending = true;
    stopLoginObservation();
    const closingWindow = loginWindow;
    const revision = authRevision.begin();
    Promise.race([
      readSessionStatus(revision),
      new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
    ]).catch(() => {}).finally(() => {
      if (loginWindow === closingWindow && !closingWindow.isDestroyed()) {
        loginClosePending = false;
        loginCloseApproved = true;
        closingWindow.close();
      }
    });
  });
  loginWindow.on('closed', async () => {
    const revision = authRevision.begin();
    loginWindow = null;
    loginClosePending = false;
    loginCloseApproved = false;
    stopLoginObservation();
    publishLoginWindowStatus();
    if (clearingSession) return;
    const result = await sessionStatus().catch(() => ({ cookieCount: null, loginState: 'error' }));
    if (authRevision.isCurrent(revision) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:closed', { ...result, revision });
    }
  });
  const win = loginWindow;
  const status = publishLoginWindowStatus();
  win.show();
  win.focus();
  win.loadURL('https://www.pornhub.com/login').catch((error) => {
    if (loginWindow !== win || win.isDestroyed()) return;
    dialog.showErrorBox('网页登录失败', String(error.message || error));
    win.close();
  });
  return status;
}

async function logout() {
  authRevision.begin();
  clearingSession = true;
  try {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    await authSession().clearStorageData();
    recentlyVerifiedLogin = false;
    return sessionStatus();
  } finally {
    clearingSession = false;
  }
}

function credentialsStatus() {
  return credentialStore.status();
}

async function publishCredentialsStatus() {
  const result = await credentialsStatus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:credentials-changed', result);
  return result;
}

async function saveLoginCredentials() {
  const win = loginWindow;
  if (!win || win.isDestroyed()) throw new Error('请先打开网页登录窗口。');
  const record = await readWindowCredentials(win);
  if (loginWindow !== win) throw new Error('网页登录窗口已关闭，请重新保存。');
  await credentialStore.save(record);
  return publishCredentialsStatus();
}

async function fillLoginCredentials() {
  const win = loginWindow;
  if (!win || win.isDestroyed()) throw new Error('请先打开网页登录窗口。');
  const result = await fillWindowCredentials(win, credentialStore);
  if (!result.filled) throw new Error('网页或保存的账号密码已变化，请重新填入。');
  return result;
}

async function deleteLoginCredentials() {
  await credentialStore.remove();
  return publishCredentialsStatus();
}

function setupLoginCredentials(win) {
  let fillTimer = null;
  let fillBusy = false;
  let attempts = 0;
  const stopFill = () => { if (fillTimer) clearInterval(fillTimer); fillTimer = null; };
  const attemptFill = async () => {
    if (fillBusy) return;
    if (win.isDestroyed() || loginWindow !== win || ++attempts > 20) { stopFill(); return; }
    fillBusy = true;
    try {
      const result = await fillWindowCredentials(win, credentialStore, { automatic: true });
      if (result.filled) stopFill();
    } catch { stopFill(); } finally { fillBusy = false; }
  };
  win.webContents.on('did-finish-load', () => {
    stopFill();
    attempts = 0;
    fillTimer = setInterval(attemptFill, 500);
    attemptFill();
  });
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) stopFill();
  });
  win.on('closed', stopFill);
  const menuAction = (action, message) => async () => {
    try {
      await action();
      await dialog.showMessageBox(win, { type: 'info', message });
    } catch (error) {
      if (!win.isDestroyed()) await dialog.showMessageBox(win, { type: 'error', message: error.message });
    }
  };
  win.setMenu(Menu.buildFromTemplate([{
    label: '账号密码', submenu: [
      { label: '保存当前填写的账号密码', accelerator: 'CommandOrControl+Shift+S',
        click: menuAction(saveLoginCredentials, '账号密码已加密保存在本机。') },
      { label: '填入已保存的账号密码', accelerator: 'CommandOrControl+Shift+F',
        click: menuAction(fillLoginCredentials, '已填入账号密码，请自行完成登录。') },
      { label: '删除保存的账号密码', click: async () => {
        const result = await dialog.showMessageBox(win, { type: 'question',
          message: '删除保存的账号密码？', detail: '删除后不会再自动填充。当前网站登录会话仍会保留。',
          buttons: ['取消', '删除'], defaultId: 0, cancelId: 0 });
        if (result.response === 1) await menuAction(deleteLoginCredentials, '保存的账号密码已删除。')();
      } },
    ],
  }]));
  win.setAutoHideMenuBar(false);
  win.setMenuBarVisibility(true);
}

function resolveTool(name) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    path.join(process.resourcesPath, 'tools', executable),
    path.join(app.getAppPath(), 'tools', executable),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || executable;
}

let toolPaths;
function toolSettings(cookieFile) {
  if (!toolPaths) {
    const ffmpeg = resolveTool('ffmpeg');
    toolPaths = { binary: resolveTool('yt-dlp'), ffmpegDir: fs.existsSync(ffmpeg) ? path.dirname(ffmpeg) : null };
  }
  const args = ['--no-check-formats', '--cookies', cookieFile, '--user-agent', authSession().getUserAgent()];
  if (toolPaths.ffmpegDir) args.push('--ffmpeg-location', toolPaths.ffmpegDir);
  return { binary: toolPaths.binary, baseArgs: args, packaged: app.isPackaged };
}

async function createCookieFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'porngo-'));
  const file = path.join(dir, 'cookies.txt');
  try {
    await fsp.writeFile(file, serializeCookies(await siteCookies()),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function fetchSitePage(url, { attempts = 3, timeoutMs = 30000, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const requestSignal = AbortSignal.timeout(timeoutMs);
      const response = await authSession().fetch(url, {
        signal: signal ? AbortSignal.any([requestSignal, signal]) : requestSignal,
      });
      if (!response.ok) throw new Error(`网站返回 HTTP ${response.status}。`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (signal?.aborted) break;
      if (/网站返回 HTTP 4\d\d/.test(String(error.message))) break;
    }
  }
  throw new Error(`内嵌网页无法读取页面：${lastError.message || lastError}`);
}

const downloadWorker = createDownloadWorker(() => utilityProcess.fork(
  path.join(__dirname, 'download-worker.js'), [], { serviceName: 'PornGo Downloads', stdio: 'ignore' },
));
const pendingMetadata = new Set();
let quitting = false;

function captureMetadata(resource, batch) {
  if (quitting) throw new Error('应用正在退出。');
  const operation = createCookieFile().then(async (cookieFile) => {
    try {
      return await downloadWorker.request('metadata', { ...toolSettings(cookieFile.file), url: resource.url, batch });
    } finally { await cookieFile.cleanup(); }
  });
  pendingMetadata.add(operation);
  return operation.finally(() => pendingMetadata.delete(operation));
}

const resourceParser = createResourceParser({ fetchSitePage, captureMetadata });

function emitDownload(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download:event', event);
  }
}

async function downloadOne(task, { video }, reportProgress) {
  const result = await downloadWorker.request('download', {
    ...toolSettings(task.cookieFile.file), video: { url: video.url, downloadTitle: video.downloadTitle },
    directory: task.directory, format: task.format, fragmentConcurrency: task.fragmentConcurrency,
  }, { group: task.taskId, progress: reportProgress });
  if (result.fileName) video.downloadFileName = result.fileName;
  return result.error;
}

const downloadTasks = createDownloadTasks({
  getSnapshot: resourceParser.getSnapshot, resolveVideoTitle: resourceParser.resolveVideoTitle,
  emitDownload, createCookieFile, downloadOne, cancelRunning: downloadWorker.cancel,
});

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    assertMainFrame(event);
    return fn(...args);
  });
  handle('auth:open', openLogin);
  handle('auth:status', sessionStatus);
  handle('auth:logout', logout);
  handle('auth:credentials-status', credentialsStatus);
  handle('auth:credentials-save', saveLoginCredentials);
  handle('auth:credentials-fill', fillLoginCredentials);
  handle('auth:credentials-delete', deleteLoginCredentials);
  handle('video:parse', resourceParser.parse);
  handle('download:concurrency-options', () => ({ fragment: FRAGMENT_CONCURRENCY, video: VIDEO_CONCURRENCY }));
  const getDownloadDirectory = () => loadDownloadDirectory(app.getPath('userData'), app.getPath('downloads'));
  handle('directory:get', getDownloadDirectory);
  handle('directory:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载保存目录',
      defaultPath: await getDownloadDirectory(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return null;
    return saveDownloadDirectory(app.getPath('userData'), result.filePaths[0]);
  });
  handle('video:download', downloadTasks.startDownload);
  handle('video:retry', downloadTasks.retryDownload);
  handle('video:cancel', downloadTasks.cancelDownload);
  handle('video:remove-queued', downloadTasks.removeQueuedDownload);
  handle('window:state', () => ({ maximized: mainWindow.isMaximized() }));
  handle('window:minimize', () => mainWindow.minimize());
  handle('window:toggle-maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });
  handle('window:close', () => mainWindow.close());
}

app.whenReady().then(() => {
  registerIpc();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let shutdownComplete = false;
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  Promise.allSettled([downloadTasks.close(), downloadWorker.close(), ...pendingMetadata]).then(() => {
    shutdownComplete = true;
    app.quit();
  });
});
