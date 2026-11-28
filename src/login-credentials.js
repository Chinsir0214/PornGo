'use strict';

const { isCredentialOrigin } = require('./credential-store');

function credentialPageOrigin(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return isCredentialOrigin(url.origin) && !url.username && !url.password
      && /^\/login\/?$/.test(url.pathname) ? url.origin : null;
  } catch { return null; }
}

// Runs only in the trusted site's top-level /login document. No IPC is exposed there.
function accessLoginFields({ origin, action, username = '', password = '', onlyEmpty = true }) {
  if (window !== window.top || location.origin !== origin || !/^\/login\/?$/.test(location.pathname)) return null;
  const visible = (node) => node && !node.disabled && !node.readOnly
    && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'
    && !node.closest('[hidden], [inert], [aria-hidden="true"]');
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  if (passwords.length !== 1) return null;
  const passwordField = passwords[0];
  const form = passwordField.form;
  if (!form || /new-password/i.test(passwordField.autocomplete)
      || /(?:confirm|repeat|new[_-]?password)/i.test(`${passwordField.name} ${passwordField.id}`)) return null;
  const formAction = Element.prototype.getAttribute.call(form, 'action') || location.href;
  if (new URL(formAction, document.baseURI || location.href).origin !== origin
      || /(?:register|signup|reset|change.?password)/i.test(formAction)) return null;
  const usernames = [...form.querySelectorAll('input')].filter((node) => visible(node)
    && /^(?:text|email|tel)$/.test(node.type)
    && (node.autocomplete === 'username' || /^(?:username|email|login|identifier)$/i.test(node.name)
      || /^(?:username|email|login|identifier)$/i.test(node.id)));
  if (usernames.length !== 1) return null;
  const usernameField = usernames[0];
  if (action === 'read') return { origin, username: usernameField.value, password: passwordField.value };
  if (action !== 'fill') return null;
  if (onlyEmpty && (usernameField.value || passwordField.value)) return { status: 'already_populated' };
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const [field, value] of [[usernameField, username], [passwordField, password]]) {
    setValue.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { filled: true };
}

function executeLoginScript(frame, options) {
  const code = `(${accessLoginFields.toString()})(${JSON.stringify(options)})`;
  if (typeof frame.executeJavaScriptInIsolatedWorld === 'function') {
    return frame.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
  }
  return frame.executeJavaScript(code);
}

async function readWindowCredentials(win) {
  const frame = win.webContents.mainFrame;
  const origin = credentialPageOrigin(win.webContents.getURL());
  if (!origin) throw new Error('请先打开可信的网页登录页面。');
  let result;
  try {
    result = await executeLoginScript(frame, { origin, action: 'read' });
  } catch { throw new Error('无法读取网页登录表单，请等待页面加载后重试。'); }
  if (win.isDestroyed() || win.webContents.mainFrame !== frame
      || credentialPageOrigin(win.webContents.getURL()) !== origin) {
    throw new Error('网页已切换，请重新保存。');
  }
  if (!result || result.origin !== origin || !result.username || !result.password) {
    throw new Error('请在网页登录窗口输入账号和密码，提交登录前点击保存。');
  }
  return result;
}

async function fillWindowCredentials(win, store, { automatic = false } = {}) {
  function outcome(status) {
    return { filled: status === 'filled', status, retryable: status === 'not_found' || status === 'stale' };
  }
  if (win.isDestroyed()) return outcome('stale');
  const frame = win.webContents.mainFrame;
  const revision = store.revision();
  const origin = credentialPageOrigin(win.webContents.getURL());
  if (!origin) return outcome('wrong_origin');
  const stale = () => win.isDestroyed() || store.revision() !== revision || win.webContents.mainFrame !== frame
    || credentialPageOrigin(win.webContents.getURL()) !== origin;
  const record = await store.get(origin);
  if (stale()) return outcome('stale');
  if (!record) return outcome('no_credentials');
  let result;
  try {
    result = await executeLoginScript(frame, { ...record, origin, action: 'fill', onlyEmpty: automatic });
  } catch {
    return outcome(stale() ? 'stale' : 'not_found');
  }
  if (stale()) return outcome('stale');
  if (result?.filled === true) return outcome('filled');
  return outcome(result?.status === 'already_populated' ? 'already_populated' : 'not_found');
}

module.exports = { credentialPageOrigin, accessLoginFields, readWindowCredentials, fillWindowCredentials };
