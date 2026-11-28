'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, session, safeStorage, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createDownloadWorker } = require('./download-worker-client');
const { createResourceParser } = require('./resource-parser');
const { createDownloadTasks } = require('./download-tasks');
const { createCredentialStore } = require('./credential-store');
const { createSiteClient } = require('./site-client');
const { createAuthController } = require('./auth-window');
const { registerIpc } = require('./ipc-handlers');

const AUTH_PARTITION = 'persist:porngo-auth';
const APP_USER_MODEL_ID = 'com.porngo.app';
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'icon-0.9.2.ico')
  : path.join(__dirname, '..', 'assets', 'icon-0.9.2.ico');
let mainWindow = null;
let configuredAuthSession;
let quitting = false;
const quitController = new AbortController();

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

function restrictSession(ses) {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
}

function authSession() {
  if (!configuredAuthSession) {
    const auth = session.fromPartition(AUTH_PARTITION);
    auth.setUserAgent(auth.getUserAgent().replace(/\sElectron\/[^\s]+/, ''));
    restrictSession(auth);
    configuredAuthSession = auth;
  }
  return configuredAuthSession;
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
  mainWindow.on('closed', () => {
    mainWindow = null;
    auth.closeLoginWindow();
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function resolveTool(name) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = path.join(process.resourcesPath, 'tools', executable);
  if (fs.existsSync(bundled)) return bundled;
  if (app.isPackaged) throw new Error(`安装包缺少下载工具 ${executable}，请重新安装完整版本。`);
  const local = path.join(app.getAppPath(), 'tools', executable);
  return fs.existsSync(local) ? local : executable;
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

const downloadWorker = createDownloadWorker(() => utilityProcess.fork(
  path.join(__dirname, 'download-worker.js'), [], { serviceName: 'PornGo Downloads', stdio: 'ignore' },
));
const pendingMetadata = new Set();
const site = createSiteClient({ authSession, quitSignal: quitController.signal });

function captureMetadata(resource, batch) {
  if (quitting) throw new Error('应用正在退出。');
  const operation = site.createCookieFile().then(async (cookieFile) => {
    try {
      return await downloadWorker.request('metadata', { ...toolSettings(cookieFile.file), url: resource.url, batch });
    } finally { await cookieFile.cleanup().catch(() => {}); }
  });
  pendingMetadata.add(operation);
  return operation.finally(() => pendingMetadata.delete(operation));
}

const resourceParser = createResourceParser({ fetchSitePage: site.fetchSitePage, captureMetadata });

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
  emitDownload, createCookieFile: site.createCookieFile, onBusyChange: () => auth.syncCredentialMenu(),
  downloadOne, cancelRunning: downloadWorker.cancel,
});

const auth = createAuthController({
  BrowserWindow, Menu, dialog, iconPath: ICON_PATH, setWindowAppDetails,
  authSession, siteCookies: site.siteCookies, credentialStore,
  getMainWindow: () => mainWindow, isQuitting: () => quitting, isDownloadActive: downloadTasks.isBusy,
});

app.whenReady().then(() => {
  restrictSession(session.defaultSession);
  authSession();
  site.sweepOrphans().catch(() => {});
  registerIpc({ ipcMain, app, dialog, getMainWindow: () => mainWindow, auth, resourceParser,
    downloadTasks, quitSignal: quitController.signal });
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
  quitController.abort();
  auth.stopLoginObservation();
  let timer;
  const cleanup = async () => {
    await Promise.allSettled([downloadTasks.close(), downloadWorker.close(), ...pendingMetadata]);
    await site.cleanupCookieDirs();
  };
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      site.cleanupCookieDirs().catch(() => {});
      resolve();
    }, 10000);
  });
  Promise.race([cleanup(), deadline]).catch(() => {}).finally(() => {
    clearTimeout(timer);
    shutdownComplete = true;
    app.quit();
  });
});
