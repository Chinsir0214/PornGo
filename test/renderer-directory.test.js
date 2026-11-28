'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRendererHarness } = require('./helpers/renderer-harness');

test('folder picker remains disabled during unrelated control updates and opens only once', async () => {
  let choose;
  let pickerCalls = 0;
  const selected = new Promise((resolve) => { choose = resolve; });
  const { element } = createRendererHarness({
    selectDirectory: () => { pickerCalls++; return selected; },
  });
  await new Promise(setImmediate);

  const button = element('directory-button');
  assert.equal(button.disabled, false);
  const firstSelection = button.dispatch('click');
  assert.equal(button.disabled, true);
  element('format-select').dispatch('change');
  assert.equal(button.disabled, true);
  await button.dispatch('click');
  assert.equal(pickerCalls, 1);

  const custom = path.join(__dirname, '..', 'downtest', 'custom');
  choose(custom);
  await firstSelection;
  assert.equal(button.disabled, false);
  assert.equal(element('directory-label').textContent, custom);
  assert.equal(element('directory-label').title, custom);
});

test('clearing a saved session requires the app dialog confirmation', async () => {
  let logoutCalls = 0;
  const { element } = createRendererHarness({
    sessionStatus: async () => ({ cookieCount: 1 }),
    logout: async () => { logoutCalls++; return { cookieCount: 0 }; },
  });
  await new Promise(setImmediate);

  const logoutButton = element('logout-button');
  const dialog = element('clear-session-dialog');
  logoutButton.dispatch('click');
  assert.equal(dialog.open, true);
  assert.equal(logoutCalls, 0);
  dialog.returnValue = 'cancel';
  dialog.dispatch('close');
  assert.equal(logoutCalls, 0);

  logoutButton.dispatch('click');
  dialog.returnValue = 'confirm';
  dialog.dispatch('close');
  await new Promise(setImmediate);
  assert.equal(logoutCalls, 1);
  assert.equal(logoutButton.hidden, true);
});
