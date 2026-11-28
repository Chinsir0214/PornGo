(() => {
  'use strict';

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function createIcon(name, extraClass = '') {
    const ns = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(ns, 'svg');
    icon.setAttribute('class', ('ui-icon ui-icon--' + name + ' ' + extraClass).trim());
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#icon-' + name);
    icon.append(use);
    return icon;
  }

  function bindConfirmation(trigger, dialog, cancelButton, confirmAction, fallback) {
    trigger.addEventListener('click', () => {
      if (dialog.open) return;
      if (trigger.disabled) return;
      dialog.returnValue = '';
      dialog.showModal();
      cancelButton.focus();
    });
    dialog.addEventListener('close', async () => {
      if (dialog.returnValue === 'confirm') {
        dialog.returnValue = '';
        await confirmAction();
        if (trigger.hidden) {
          const target = typeof fallback === 'function' ? fallback() : fallback;
          if (target && !target.hidden && !target.disabled) target.focus();
        }
      }
    });
  }

  const helpers = { setText, createIcon, bindConfirmation };
  if (typeof window !== 'undefined') Object.assign(window.PornGoRenderer ||= {}, helpers);
  if (typeof module === 'object' && module.exports) module.exports = helpers;
})();
