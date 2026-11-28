'use strict';

const { EventEmitter } = require('node:events');

function authOptions(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const windows = [];
  const events = [];
  let cookies = 3;
  let observation = async () => 'unknown';
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.closeCalls = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, getURL: () => this.url, setWindowOpenHandler() {},
        executeJavaScript: () => observation(),
      });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    setMenu() {}
    setAutoHideMenuBar() {}
    setMenuBarVisibility() {}
    async loadURL(url) { this.url = url; }
    close() {
      this.closeCalls++;
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit('closed'); }
    }
  }
  const options = {
    BrowserWindow: FakeWindow, Menu: { buildFromTemplate: () => ({ getMenuItemById: () => ({}) }) },
    setWindowAppDetails() {}, isQuitting: () => false, isDownloadActive: () => false,
    credentialStore: { status: async () => ({}), revision: () => 0, get: async () => null },
    siteCookies: async () => Array(cookies).fill({}),
    authSession: () => ({ clearStorageData: async () => { cookies = 0; } }),
    getMainWindow: () => ({ isDestroyed: () => false,
      webContents: { send: (type, result) => events.push({ type, result }) } }),
    ...overrides,
  };
  return { options, windows, events, observe: (fn) => { observation = fn; } };
}

module.exports = { authOptions };
