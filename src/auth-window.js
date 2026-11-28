'use strict';

const { inspectSiteLoginState, createRevisionGate, startStatusPolling, resolveObservedLogin } = require('./auth-status');
const { credentialPageOrigin, readWindowCredentials, fillWindowCredentials } = require('./login-credentials');
const { isAllowedAuthUrl } = require('./site-client');

function createAuthController({ BrowserWindow, Menu, dialog, iconPath, setWindowAppDetails,
  authSession, siteCookies, credentialStore, getMainWindow, isQuitting, isDownloadActive }) {
  let loginWindow = null;
  let loginWindowRevision = 0;
  let clearingSession = null;
  const authRevision = createRevisionGate();
  let stopAuthPolling = null;
  let recentlyVerifiedLogin = false;
  let loginClosePending = false;
  let loginCloseApproved = false;
  let closeTimer = null;
  let stopCredentialFill = null;
  let credentialMenu = null;
  let credentialState = {};

  function publish(channel, value) {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(channel, value);
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

      } catch {
        // The page may be navigating. Its cookies can still be used.
      }
    }
    if (!authRevision.isCurrent(revision) || loginWindow !== observingWindow
        || observingWindow?.isDestroyed()) return { cookieCount, loginState: 'unknown' };
    const resolved = resolveObservedLogin(observed, recentlyVerifiedLogin);
    recentlyVerifiedLogin = resolved.recentlyVerified;
    return { cookieCount, loginState: resolved.loginState };
  }

  async function sessionStatus() {
    const revision = authRevision.current();
    return { ...await readSessionStatus(revision), revision };
  }

  let authStatusTimer = null;
  let pendingCheck = null;

  function checkLoginStatus() {
    if (!loginWindow || loginClosePending || clearingSession || isQuitting()) return;
    const revision = authRevision.current();
    if (pendingCheck?.revision === revision) return pendingCheck.promise;
    const win = loginWindow;
    const promise = readSessionStatus(revision, { revealAccountMenu: true })
      .catch(() => ({ cookieCount: null, loginState: 'error' }))
      .then((result) => {
        if (!authRevision.isCurrent(revision) || loginWindow !== win || win.isDestroyed()
            || clearingSession || loginClosePending || isQuitting()) return;
        publish('auth:status-changed', { ...result, revision });
        if (result.loginState === 'verified') {
          loginCloseApproved = true;
          win.close();
        }
      }).finally(() => {
        if (pendingCheck?.promise === promise) pendingCheck = null;
      });
    pendingCheck = { revision, promise };
    return promise;
  }

  function scheduleSessionStatusUpdate() {
    if (loginClosePending || clearingSession || isQuitting()) return;
    authRevision.begin();
    clearTimeout(authStatusTimer);
    authStatusTimer = setTimeout(() => {
      authStatusTimer = null;
      checkLoginStatus();
    }, 500);
  }

  function stopLoginObservation() {
    authRevision.begin();
    stopAuthPolling?.();
    stopAuthPolling = null;
    clearTimeout(authStatusTimer);
    clearTimeout(closeTimer);
    authStatusTimer = closeTimer = null;
    stopCredentialFill?.();
  }

  function loginWindowStatus() {
    return { windowOpen: Boolean(loginWindow && !loginWindow.isDestroyed()), revision: loginWindowRevision };
  }

  function publishLoginWindowStatus() {
    loginWindowRevision++;
    const status = loginWindowStatus();
    publish('auth:window-changed', status);
    return status;
  }

  function openLogin() {
    if (clearingSession || isQuitting()) throw new Error('登录会话正在关闭，请稍后重试。');
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
      icon: iconPath,
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
    const guardNavigation = (event, details) => {
      if (!isAllowedAuthUrl(event.url ?? details?.url ?? details)) event.preventDefault();
    };
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      loginWindow.webContents.on(name, guardNavigation);
    }

    loginWindow.webContents.on('did-finish-load', scheduleSessionStatusUpdate);
    loginWindow.webContents.on('did-navigate-in-page', scheduleSessionStatusUpdate);
    loginWindow.webContents.on('did-navigate', scheduleSessionStatusUpdate);
    stopAuthPolling = startStatusPolling(checkLoginStatus);

    loginWindow.on('page-title-updated', (event) => event.preventDefault());
    loginWindow.on('close', (event) => {
      if (isQuitting()) return;
      if (clearingSession || loginCloseApproved) return;
      event.preventDefault();
      if (loginClosePending) return;
      loginClosePending = true;
      stopLoginObservation();
      const closingWindow = loginWindow;
      const revision = authRevision.begin();
      Promise.race([
        readSessionStatus(revision),
        new Promise((resolve) => { closeTimer = setTimeout(resolve, 1200); }),
      ]).catch(() => {}).finally(() => {
        if (loginWindow !== closingWindow) return;
        clearTimeout(closeTimer);
        closeTimer = null;
        if (!closingWindow.isDestroyed()) {
          loginClosePending = false;
          loginCloseApproved = true;
          closingWindow.close();
        }
      });
    });
    loginWindow.on('closed', async () => {
      loginWindow = null;
      loginClosePending = false;
      loginCloseApproved = false;
      stopLoginObservation();
      stopCredentialFill = credentialMenu = null;
      const revision = authRevision.current();
      publishLoginWindowStatus();
      if (clearingSession || isQuitting()) return;
      const result = await sessionStatus().catch(() => ({ cookieCount: null, loginState: 'error' }));
      if (authRevision.isCurrent(revision) && !isQuitting()) {
        publish('auth:closed', { ...result, revision });
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

  function closeLoginWindow() {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginCloseApproved = true;
      loginWindow.close();
    }
  }

  function logout() {
    if (clearingSession) return clearingSession;
    authRevision.begin();
    clearingSession = Promise.resolve().then(async () => {
      closeLoginWindow();
      await authSession().clearStorageData();
      recentlyVerifiedLogin = false;
      return sessionStatus();
    }).finally(() => { clearingSession = null; syncCredentialMenu(); });
    syncCredentialMenu();
    return clearingSession;
  }

  function syncCredentialMenu() {
    if (!credentialMenu) return;
    const enabled = !clearingSession && !isQuitting() && !isDownloadActive();
    credentialMenu.getMenuItemById('save').enabled = Boolean(enabled && credentialState.available);
    credentialMenu.getMenuItemById('fill').enabled = Boolean(enabled && credentialState.available
      && credentialState.saved && !credentialState.error);
    credentialMenu.getMenuItemById('delete').enabled = Boolean(enabled && credentialState.saved);
  }

  async function credentialsStatus() {
    credentialState = await credentialStore.status();
    syncCredentialMenu();
    return credentialState;
  }

  async function publishCredentialsStatus() {
    const result = await credentialsStatus();
    publish('auth:credentials-changed', result);
    return result;
  }

  async function saveLoginCredentials() {
    const win = loginWindow;
    if (!win || win.isDestroyed()) throw new Error('请先打开网页登录窗口。');
    const baseRevision = credentialStore.revision();
    const record = await readWindowCredentials(win);
    if (loginWindow !== win) throw new Error('网页登录窗口已关闭，请重新保存。');
    await credentialStore.save(record, { expectedRevision: baseRevision });
    return publishCredentialsStatus();
  }

  async function fillLoginCredentials() {
    const win = loginWindow;
    if (!win || win.isDestroyed()) throw new Error('请先打开网页登录窗口。');
    const result = await fillWindowCredentials(win, credentialStore);
    if (!result.filled) {
      const messages = {
        wrong_origin: '请先打开可信的网页登录页面。',
        no_credentials: '当前网站还没有保存账号密码。',
        not_found: '未找到登录表单，请等待页面加载后重试。',
      };
      throw new Error(messages[result.status] || '网页或保存的账号密码已变化，请重新填入。');
    }
    return result;
  }

  async function deleteLoginCredentials() {
    await credentialStore.remove();
    return publishCredentialsStatus();
  }

  function setupLoginCredentials(win) {
    let fillTimer = null;
    let generation = 0;
    const stopFill = () => {
      generation++;
      clearInterval(fillTimer);
      fillTimer = null;
    };
    stopCredentialFill = stopFill;
    win.webContents.on('did-finish-load', () => {
      stopFill();
      if (isQuitting() || win.isDestroyed() || !credentialPageOrigin(win.webContents.getURL())) return;
      const page = generation;
      let attempts = 0;
      let busy = false;
      const attemptFill = async () => {
        if (busy || page !== generation) return;
        if (win.isDestroyed() || loginWindow !== win || ++attempts > 20) { stopFill(); return; }
        busy = true;
        try {
          const result = await fillWindowCredentials(win, credentialStore, { automatic: true });
          if (page === generation && !result.retryable) stopFill();
        } catch {
          if (page === generation) stopFill();
        } finally { busy = false; }
      };
      fillTimer = setInterval(attemptFill, 500);
      attemptFill();
    });
    win.webContents.on('did-start-navigation', (event, details, _inPlace, isMainFrame) => {
      if (event.isMainFrame ?? details?.isMainFrame ?? isMainFrame) stopFill();
    });
    win.on('closed', stopFill);
    const menuAction = (action, message) => async () => {
      try {
        await action();
        if (!win.isDestroyed()) await dialog.showMessageBox(win, { type: 'info', message });
      } catch (error) {
        if (!win.isDestroyed()) await dialog.showMessageBox(win, { type: 'error', message: error.message });
      }
    };
    credentialMenu = Menu.buildFromTemplate([{
      label: '账号密码', submenu: [
        { id: 'save', enabled: false, label: '保存当前填写的账号密码', accelerator: 'CommandOrControl+Shift+S',
          click: menuAction(saveLoginCredentials, '账号密码已加密保存在本机。') },
        { id: 'fill', enabled: false, label: '填入已保存的账号密码', accelerator: 'CommandOrControl+Shift+F',
          click: menuAction(fillLoginCredentials, '已填入账号密码，请自行完成登录。') },
        { id: 'delete', enabled: false, label: '删除保存的账号密码', click: async () => {
          if (win.isDestroyed()) return;
          const result = await dialog.showMessageBox(win, { type: 'question',
            message: '删除保存的账号密码？', detail: '删除后不会再自动填充。当前网站登录会话仍会保留。',
            buttons: ['取消', '删除'], defaultId: 0, cancelId: 0 });
          if (result.response === 1 && !win.isDestroyed() && !isDownloadActive()) await menuAction(deleteLoginCredentials, '保存的账号密码已删除。')();
        } },
      ],
    }]);
    win.setMenu(credentialMenu);
    credentialsStatus().catch(() => { credentialState = {}; syncCredentialMenu(); });
    win.setAutoHideMenuBar(false);
    win.setMenuBarVisibility(true);
  }

  return {
    openLogin, sessionStatus, logout, credentialsStatus, saveLoginCredentials, fillLoginCredentials,
    deleteLoginCredentials, closeLoginWindow, stopLoginObservation, syncCredentialMenu,
  };
}

module.exports = { createAuthController, isAllowedAuthUrl };
