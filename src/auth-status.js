'use strict';

// This runs in the embedded site's page. Only a visible profile/logout pair
// confirms login; the site's anonymous header also includes an account menu.
function inspectSiteLoginState({ revealAccountMenu = false } = {}) {
  function visible(node) {
    if (!node.isConnected || node.closest('[aria-hidden="true"], [inert]')) return false;
    const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    let rect = [...node.getClientRects()].find((item) => item.width > 0 && item.height > 0
      && item.right > viewport.left && item.bottom > viewport.top
      && item.left < viewport.right && item.top < viewport.bottom);
    if (!rect) return false;
    let left = Math.max(rect.left, viewport.left);
    let right = Math.min(rect.right, viewport.right);
    let top = Math.max(rect.top, viewport.top);
    let bottom = Math.min(rect.bottom, viewport.bottom);
    let opacity = 1;
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      opacity *= Number(style.opacity);
      if (style.display === 'none' || style.visibility === 'hidden'
          || style.visibility === 'collapse' || style.contentVisibility === 'hidden'
          || !Number.isFinite(opacity) || opacity <= 0.02) return false;
      if (current === node) continue;
      const clipped = current.getBoundingClientRect();
      if (/(?:hidden|clip|scroll|auto)/.test(style.overflowX)) {
        left = Math.max(left, clipped.left);
        right = Math.min(right, clipped.right);
      }
      if (/(?:hidden|clip|scroll|auto)/.test(style.overflowY)) {
        top = Math.max(top, clipped.top);
        bottom = Math.min(bottom, clipped.bottom);
      }
      if (left >= right || top >= bottom) return false;
    }
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return Boolean(hit && (node.contains(hit) || hit === node.parentElement));
  }
  const selector = 'a[href], button, [role="menuitem"], span, p, div';
  function inspectControls(query) {
    const controls = [...document.querySelectorAll(query)]
      .filter((node) => node.matches('a[href], button, [role="menuitem"]') || node.childElementCount === 0)
      .filter(visible);
    const labels = controls.flatMap((node) => [
      node.getAttribute('aria-label') || '',
      typeof node.innerText === 'string' ? node.innerText : node.textContent || '',
    ].map((value) => value.trim()).filter(Boolean));
    const profile = labels.some((label) => /(?:查看您的个人资料|查看个人资料|查看您的個人資料|查看個人資料|view (?:your|my) profile)/i.test(label));
    const logout = labels.some((label) => /^(?:注销|退出登录|登出|log\s*out|sign\s*out)$/i.test(label));
    const signIn = labels.some((label) => /^(?:登录|登入|log\s*in|sign\s*in)$/i.test(label));
    return { profile, logout, signIn };
  }
  const headers = 'header, nav, [role="banner"], [role="navigation"], #header, #headerWrapper, #headerContainer';
  let { profile, logout, signIn } = inspectControls(`:is(${headers}) :is(${selector})`);
  if (!signIn && !(profile && logout)) {
    ({ profile, logout, signIn } = inspectControls(selector));
  }
  if (profile && logout && !signIn) return 'verified';
  if (signIn && !(profile && logout)) {
    // AJAX login can reuse the same header node. An observed anonymous menu
    // resets its probe so the newly authenticated, collapsed menu can open.
    const probes = window.__porngoAccountMenuProbes;
    if (probes instanceof WeakSet && typeof document.querySelector === 'function') {
      const trigger = document.querySelector('.subMenuTrigger.userMenuDropdownArrow');
      if (trigger) probes.delete(trigger);
    }
    return 'signed_out';
  }
  if (revealAccountMenu && !signIn && document.readyState === 'complete') {
    const trigger = document.querySelector('.subMenuTrigger.userMenuDropdownArrow');
    const header = trigger && trigger.closest('header, [role="banner"], #header, #headerWrapper, #headerContainer');
    const menu = header && header.querySelector('.scrollableContentUserMenu');
    // Never submit forms or follow links, and never toggle a menu already open.
    const href = trigger && trigger.getAttribute('href');
    if (trigger && header && menu && visible(trigger) && !visible(menu)
        && !trigger.closest('form') && trigger.getAttribute('aria-expanded') !== 'true'
        && (!href || href === '#' || /^javascript:\s*(?:void\s*\(\s*0\s*\)\s*;?|;?)$/i.test(href))
        && typeof trigger.click === 'function') {
      const key = '__porngoAccountMenuProbes';
      if (!(window[key] instanceof WeakSet)) window[key] = new WeakSet();
      if (!window[key].has(trigger)) {
        window[key].add(trigger);
        trigger.click();
      }
    }
  }
  return 'unknown';
}

function createRevisionGate() {
  let revision = 0;
  return {
    current: () => revision,
    begin: () => ++revision,
    isCurrent: (value) => value === revision,
  };
}

function startStatusPolling(onTick, timers = { setInterval, clearInterval }) {
  let pending = false;
  const timer = timers.setInterval(async () => {
    if (pending) return;
    pending = true;
    try {
      await onTick();
    } catch {
      // A navigation can invalidate the frame while polling.
    } finally {
      pending = false;
    }
  }, 2500);
  return () => timers.clearInterval(timer);
}

function resolveObservedLogin(observed, previouslyVerified) {
  if (observed === 'verified') return { loginState: 'verified', recentlyVerified: true };
  if (observed === 'signed_out') return { loginState: 'signed_out', recentlyVerified: false };
  return { loginState: previouslyVerified ? 'recently_verified' : 'unknown', recentlyVerified: previouslyVerified };
}

module.exports = { inspectSiteLoginState, createRevisionGate, startStatusPolling, resolveObservedLogin };
