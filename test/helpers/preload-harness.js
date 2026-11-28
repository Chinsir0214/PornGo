'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPreloadHarness(invoke = () => {}) {
  const listeners = new Map();
  const calls = [];
  let api;
  const ipcRenderer = {
    async invoke(...args) {
      calls.push(args);
      return invoke(...args);
    },
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener(channel, listener) { listeners.get(channel)?.delete(listener); },
  };
  const filename = path.resolve(__dirname, '../../src/preload.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: {
        exposeInMainWorld(name, exposed) {
          assert.equal(name, 'porngo');
          api = exposed;
        },
      } };
    },
  }, { filename });
  function emit(channel, payload) {
    for (const handler of listeners.get(channel) || []) handler(null, payload);
  }
  return { api, calls, listeners, emit };
}

module.exports = { createPreloadHarness };
