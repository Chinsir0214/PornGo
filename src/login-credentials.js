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
  if (new URL(form.action || location.href, location.href).origin !== origin
      || /(?:register|signup|reset|change.?password)/i.test(form.action)) return null;
  const usernames = [...form.querySelectorAll('input')].filter((node) => visible(node)
    && /^(?:text|email|tel)$/.test(node.type)
    && (node.autocomplete === 'username' || /^(?:username|email|login|identifier)$/i.test(node.name)
      || /^(?:username|email|login|identifier)$/i.test(node.id)));
  if (usernames.length !== 1) return null;
  const usernameField = usernames[0];
  if (action === 'read') return { origin, username: usernameField.value, password: passwordField.value };
  if (action !== 'fill' || (onlyEmpty && (usernameField.value || passwordField.value))) return null;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const [field, value] of [[usernameField, username], [passwordField, password]]) {
    setValue.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { filled: true };
}

async function readWindowCredentials(win) {
  const frame = win.webContents.mainFrame;
  const origin = credentialPageOrigin(win.webContents.getURL());
  if (!origin) throw new Error('请先打开可信的网页登录页面。');
  let result;
  try {
    result = await frame.executeJavaScript(
      `(${accessLoginFields.toString()})(${JSON.stringify({ origin, action: 'read' })})`);
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
  if (win.isDestroyed()) return { filled: false };
  const frame = win.webContents.mainFrame;
  const revision = store.revision();
  const origin = credentialPageOrigin(win.webContents.getURL());
  if (!origin) {
    if (automatic) return { filled: false };
    throw new Error('请先打开可信的网页登录页面。');
  }
  const record = await store.get(origin);
  if (!record) {
    if (automatic) return { filled: false };
    throw new Error('当前网站还没有保存账号密码。');
  }
  if (win.isDestroyed() || store.revision() !== revision || win.webContents.mainFrame !== frame
      || credentialPageOrigin(win.webContents.getURL()) !== origin) return { filled: false };
  let result;
  try {
    result = await frame.executeJavaScript(
      `(${accessLoginFields.toString()})(${JSON.stringify({ ...record, action: 'fill', onlyEmpty: automatic })})`);
  } catch { throw new Error('无法填入网页登录表单，请等待页面加载后重试。'); }
  if (!result && !automatic) throw new Error('未找到登录表单，请等待页面加载后重试。');
  return { filled: Boolean(result && result.filled) };
}

module.exports = { credentialPageOrigin, accessLoginFields, readWindowCredentials, fillWindowCredentials };
