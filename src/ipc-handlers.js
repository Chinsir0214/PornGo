'use strict';

const { FRAGMENT_CONCURRENCY, VIDEO_CONCURRENCY } = require('./download-queue');
const { loadDownloadDirectory, saveDownloadDirectory } = require('./download-directory');

function assertMainFrame(event, mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('不允许从此页面调用应用功能。');
  }
}

function registerIpc({ ipcMain, app, dialog, getMainWindow, auth, resourceParser, downloadTasks, quitSignal }) {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    assertMainFrame(event, getMainWindow());
    return fn(...args);
  });
  handle('auth:open', auth.openLogin);
  handle('auth:status', auth.sessionStatus);
  handle('auth:logout', auth.logout);
  handle('auth:credentials-status', auth.credentialsStatus);
  handle('auth:credentials-save', auth.saveLoginCredentials);
  handle('auth:credentials-fill', auth.fillLoginCredentials);
  handle('auth:credentials-delete', auth.deleteLoginCredentials);
  handle('video:parse', (url) => resourceParser.parse(url, { signal: quitSignal }));
  handle('download:concurrency-options', () => ({ fragment: FRAGMENT_CONCURRENCY, video: VIDEO_CONCURRENCY }));
  const getDownloadDirectory = () => loadDownloadDirectory(app.getPath('userData'), app.getPath('downloads'));
  handle('directory:get', getDownloadDirectory);
  handle('directory:select', async () => {
    const mainWindow = getMainWindow();
    const defaultPath = await getDownloadDirectory();
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载保存目录',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || mainWindow.isDestroyed()) return null;
    return saveDownloadDirectory(app.getPath('userData'), result.filePaths[0]);
  });
  handle('video:download', downloadTasks.startDownload);
  handle('video:retry', downloadTasks.retryDownload);
  handle('video:cancel', downloadTasks.cancelDownload);
  handle('video:remove-queued', downloadTasks.removeQueuedDownload);
  handle('window:state', () => ({ maximized: getMainWindow().isMaximized() }));
  handle('window:minimize', () => getMainWindow().minimize());
  handle('window:toggle-maximize', () => {
    const mainWindow = getMainWindow();
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });
  handle('window:close', () => getMainWindow().close());
}

module.exports = { registerIpc, assertMainFrame };
