'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = path.resolve(__dirname, '../../src');
const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');

class EventTargetStub {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, callback, options = {}) {
    const listeners = this.listeners.get(type) || [];
    if (!listeners.some((entry) => entry.callback === callback)) listeners.push({ callback, once: options.once });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((entry) => entry.callback !== callback));
  }

  dispatchEvent(event) {
    return this.dispatch(event.type, event);
  }

  dispatch(type, event = { type, target: this, preventDefault() {} }) {
    if (type === 'close' && this.tagName === 'dialog') this.open = false;
    if (event.target == null) Object.defineProperty(event, 'target', { configurable: true, value: this });
    Object.defineProperty(event, 'currentTarget', { configurable: true, value: this });
    const results = [];
    for (const { callback, once } of [...(this.listeners.get(type) || [])]) {
      if (once) this.removeEventListener(type, callback);
      results.push(callback.call(this, event));
    }
    if (event.bubbles && !event.cancelBubble && this.parentElement) {
      results.push(this.parentElement.dispatch(type, event));
    }
    return Promise.all(results);
  }
}

const dataKey = (name) => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class Element extends EventTargetStub {
  constructor(tagName, document) {
    super();
    this.tagName = tagName;
    this.ownerDocument = document;
    this.parentElement = null;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.classes = new Set();
    this.value = this.textContent = this.returnValue = '';
    this.hidden = this.disabled = this.open = this.checked = false;
    this.scrollTop = 0;
    this.classList = {
      contains: (name) => this.classes.has(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, force = !this.classes.has(name)) => {
        if (force) this.classes.add(name);
        else this.classes.delete(name);
        return Boolean(force);
      },
    };
  }

  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }

  setAttribute(name, value) {
    value = String(value);
    this.attributes[name] = value;
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = value;
  }

  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null;
    if (name === 'class') return this.className;
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'class') this.className = '';
    if (name.startsWith('data-')) delete this.dataset[dataKey(name)];
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1);
    const attribute = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
    if (attribute) return this.getAttribute(attribute[1]) === attribute[2];
    return this.tagName === selector;
  }

  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }

  remove() {
    if (!this.parentElement) return;
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  insertBefore(node, reference) {
    if (node === reference) return;
    if (node.tagName === '#fragment') {
      for (const child of [...node.children]) this.insertBefore(child, reference);
      return;
    }
    node.remove();
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    if (index < 0) throw new Error('Reference is not a child');
    this.children.splice(index, 0, node);
    node.parentElement = this;
    if (this.tagName === 'select' && this.children.length === 1) this.value = node.value;
  }

  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }

  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    if (this.tagName === 'select') this.value = '';
    this.append(...nodes);
  }
}

function createRendererHarness(api = {}, windowOverrides = {}) {
  const document = new Element('#document');
  const ids = new Map();
  document.activeElement = null;
  document.createElement = (name) => new Element(name, document);
  document.createElementNS = (_namespace, name) => document.createElement(name);
  document.createDocumentFragment = () => document.createElement('#fragment');
  document.getElementById = (id) => {
    if (!ids.has(id)) throw new Error('Unknown id in src/index.html: ' + id);
    return ids.get(id);
  };

  const stack = [document];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g)) {
    if (token.startsWith('<!')) continue;
    if (!token.startsWith('<')) {
      stack.at(-1).textContent += token;
      continue;
    }
    if (token.startsWith('</')) {
      stack.pop();
      continue;
    }
    const [, name, attrs] = /^<([\w-]+)([\s\S]*?)\/?>$/.exec(token);
    const node = document.createElement(name);
    for (const [, key, value = ''] of attrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      node.setAttribute(key, value);
      if (key === 'id') ids.set(value, node);
      if (['hidden', 'disabled', 'open', 'checked'].includes(key)) node[key] = true;
      if (key === 'value') node.value = value;
    }
    stack.at(-1).append(node);
    if (!voidTags.has(name) && !token.endsWith('/>')) stack.push(node);
  }

  const window = Object.assign(new EventTargetStub(), windowOverrides);
  window.porngo = {
    getDirectory: async () => path.resolve(src, '../downtest'),
    sessionStatus: async () => ({ cookieCount: 0 }),
    concurrencyOptions: async () => ({ fragment: [1, 4], video: [1, 2] }),
    onDownloadEvent() {},
    onLoginClosed() {},
    ...api,
  };
  const context = vm.createContext({ document, window, URL, Event, setTimeout, clearTimeout });
  for (const script of document.querySelectorAll('script')) {
    if (script.getAttribute('defer') === null || !script.getAttribute('src')) continue;
    const filename = path.resolve(src, script.getAttribute('src'));
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  return { element: document.getElementById, document, dispatchPagehide: () => window.dispatch('pagehide') };
}

module.exports = { createRendererHarness };
