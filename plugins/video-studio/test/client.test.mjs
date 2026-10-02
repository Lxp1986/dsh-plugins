/**
 * Client-module contract test.
 *
 * It does not render React or touch the DOM: it verifies the module the browser
 * loader will execute — the module-loader envelope, the returned plugin shape,
 * and that `apply` registers the sidebar icon and the main panel without
 * throwing. A failure here is exactly what blanks a slot entry in the page.
 *
 * Usage: node test/client.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const registrations = [];
const slotInjections = [];
const effects = [];
let loaded = null;

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
    },
  },
};
const warn = console.warn;
console.warn = () => {};

await import(pathToFileURL(path.join(import.meta.dirname, '..', 'client.js')).href);

assert.ok(loaded, 'client.js must register itself with the module loader');
assert.equal(loaded.id, '@local/dsh-video-studio');
assert.equal(typeof loaded.factory, 'function');

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};
const plugin = loaded.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected module request: ${name}`);
});

assert.deepEqual(plugin.inject, ['slots']);
assert.equal(typeof plugin.apply, 'function');

const fakeCtx = {
  effect(callback) {
    effects.push(callback());
    return () => {};
  },
  slots: {
    inject(key, callback) {
      slotInjections.push(key);
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

plugin.apply(fakeCtx);
console.warn = warn;

assert.deepEqual(slotInjections.sort(), ['main', 'sidebar.panellist']);
const icon = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
const panel = registrations.find((entry) => entry.options.name === 'main');
assert.ok(icon, 'sidebar.panellist must be registered');
assert.ok(panel, 'main must be registered');
assert.equal(icon.options.id, 'video-studio');
assert.equal(icon.options.order, 20);
assert.equal(typeof icon.component, 'function');
assert.equal(typeof icon.options.label, 'function');
assert.equal(typeof icon.options.label(), 'string');
assert.ok(icon.options.label().length > 0);
assert.equal(panel.options.key, 'video-studio');
assert.equal(typeof panel.component, 'function');
assert.equal(panel.component.name, 'Panel');

console.log('  ✓ 客户端模块封装、插件形态与两个槽位注册均正常');
console.log('\n客户端契约测试通过');
