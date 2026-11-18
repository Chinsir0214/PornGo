'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('需要事件回调函数。');
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('porngo', Object.freeze({
  windowState: () => ipcRenderer.invoke('window:state'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onWindowState: (listener) => subscribe('window:state', listener),
  openLogin: () => ipcRenderer.invoke('auth:open'),
  onLoginWindowChanged: (listener) => subscribe('auth:window-changed', listener),
  onLoginClosed: (listener) => subscribe('auth:closed', listener),
  onSessionStatusChanged: (listener) => subscribe('auth:status-changed', listener),
  sessionStatus: () => ipcRenderer.invoke('auth:status'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  credentialsStatus: () => ipcRenderer.invoke('auth:credentials-status'),
  saveCredentials: () => ipcRenderer.invoke('auth:credentials-save'),
  fillCredentials: () => ipcRenderer.invoke('auth:credentials-fill'),
  deleteCredentials: () => ipcRenderer.invoke('auth:credentials-delete'),
  onCredentialsChanged: (listener) => subscribe('auth:credentials-changed', listener),
  parse: (url) => ipcRenderer.invoke('video:parse', url),
  getDirectory: () => ipcRenderer.invoke('directory:get'),
  selectDirectory: () => ipcRenderer.invoke('directory:select'),
  download: (request) => ipcRenderer.invoke('video:download', request),
  retryDownload: (request) => ipcRenderer.invoke('video:retry', request),
  concurrencyOptions: () => ipcRenderer.invoke('download:concurrency-options'),
  cancel: (taskId) => ipcRenderer.invoke('video:cancel', taskId),
  removeQueued: (taskId) => ipcRenderer.invoke('video:remove-queued', taskId),
  onDownloadEvent: (listener) => subscribe('download:event', listener),
}));
