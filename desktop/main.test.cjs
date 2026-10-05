'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const area = { x: 0, y: 0, width: 1920, height: 1080 };
const full = { x: 100, y: 80, width: 1280, height: 900 };

function desktop() {
  const handlers = new Map();
  const notifications = [];
  const writes = new Map();
  const nativeWindow = {
    rectangle: { ...full }, normal: { ...full }, maximized: false, pinned: false,
    minimum: [], webContents: { mainFrame: { url: 'http://127.0.0.1:43210/' }, send: (...args) => notifications.push(args) },
    isDestroyed: () => false, isMinimized: () => false,
    isMaximized() { return this.maximized; },
    getBounds() { return { ...this.rectangle }; },
    getNormalBounds() { return { ...this.normal }; },
    setBounds(value) { this.rectangle = { ...value }; this.normal = { ...value }; },
    setMinimumSize(...value) { this.minimum = value; },
    setAlwaysOnTop(value) { this.pinned = value; },
    maximize() { this.normal = { ...this.rectangle }; this.rectangle = { ...area }; this.maximized = true; },
    unmaximize() { this.rectangle = { ...this.normal }; this.maximized = false; },
  };
  const electron = {
    app: { setName() {}, setPath() {}, getPath: () => 'C:/CodeWatch-test', setAppUserModelId() {},
      requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (name, listener) => handlers.set(name, listener) },
    screen: { getAllDisplays: () => [{ workArea: area }], getDisplayMatching: () => ({ workArea: area }),
      getPrimaryDisplay: () => ({ workArea: area }) },
  };
  const fakeFs = { writeFileSync: (name, body) => writes.set(name, body), renameSync: (from, to) => {
    writes.set(to, writes.get(from)); writes.delete(from);
  }, mkdirSync() {}, existsSync: () => false, appendFileSync() {} };
  const context = { require: name => name === 'electron' ? electron : name === 'node:fs' ? fakeFs : require(name),
    __dirname, process: { argv: [], env: {} }, module: { exports: {} }, URL, Buffer, setTimeout, clearTimeout, fetch };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8') + `
    module.exports = { preferences, setPreferences, rememberBounds, registerIPC, bounds,
      getSettings: () => settings, setWindow: value => { window = value; },
      setEndpoint: value => { endpoint = value; }, setSettings: value => { settings = value; } };
  `, context);
  const main = context.module.exports;
  main.setWindow(nativeWindow);
  main.setEndpoint('http://127.0.0.1:43210');
  return { main, nativeWindow, notifications, handlers, writes };
}

test('pinning opens the compact companion and retains the full window bounds', () => {
  const { main, nativeWindow, notifications, writes } = desktop();
  const result = main.setPreferences({ alwaysOnTop: true });
  assert.equal(result.compact, true);
  assert.equal(nativeWindow.pinned, true);
  assert.deepEqual(main.getSettings().bounds, full);
  assert.equal(nativeWindow.rectangle.width, 540);
  assert.equal(nativeWindow.rectangle.height, 720);
  assert.deepEqual(nativeWindow.minimum, [440, 500]);
  assert.equal(notifications.at(-1)[0], 'codewatch:preferences-changed');
  assert.equal(notifications.at(-1)[1].compact, true);
  assert.ok([...writes.values()].some(value => JSON.parse(value).compact));
});

test('opening the full app keeps the pin and restores its bounds after resizing the companion', () => {
  const { main, nativeWindow } = desktop();
  main.setPreferences({ alwaysOnTop: true });
  const companion = { x: 1300, y: 80, width: 480, height: 640 };
  nativeWindow.setBounds(companion);
  main.rememberBounds();
  main.setPreferences({ compact: false });
  assert.equal(nativeWindow.pinned, true);
  assert.deepEqual(nativeWindow.rectangle, full);
  assert.deepEqual(main.getSettings().compactBounds, companion);
  main.setPreferences({ compact: true });
  assert.deepEqual(nativeWindow.rectangle, companion);
  main.setPreferences({ alwaysOnTop: false });
  assert.equal(main.preferences().compact, false);
  assert.equal(nativeWindow.pinned, false);
  assert.deepEqual(nativeWindow.rectangle, full);
});

test('pinning a maximized dashboard restores maximization when returning to the full app', () => {
  const { main, nativeWindow } = desktop();
  nativeWindow.maximize();
  main.setPreferences({ alwaysOnTop: true });
  assert.equal(nativeWindow.maximized, false);
  assert.deepEqual(main.getSettings().bounds, full);
  main.setPreferences({ compact: false });
  assert.equal(nativeWindow.maximized, true);
  assert.deepEqual(nativeWindow.normal, full);
  assert.deepEqual(main.getSettings().bounds, full);
});

test('saved companion bounds are clamped to the current display without altering full bounds', () => {
  const { main } = desktop();
  main.setSettings({ alwaysOnTop: true, closeToTray: false, compact: true, bounds: full,
    compactBounds: { x: 1800, y: 1000, width: 220, height: 300 } });
  const restored = main.bounds(true);
  assert.equal(restored.width, 440);
  assert.equal(restored.height, 500);
  assert.equal(restored.x, 1480);
  assert.equal(restored.y, 580);
  assert.deepEqual(main.getSettings().bounds, full);
});

test('preference IPC accepts only boolean known preferences from the main local renderer', () => {
  const { main, nativeWindow, handlers } = desktop();
  main.registerIPC();
  const set = handlers.get('codewatch:set-preferences');
  const event = { sender: nativeWindow.webContents, senderFrame: nativeWindow.webContents.mainFrame };
  for (const patch of [null, [], { compact: 'yes' }, { command: 'anything' }]) {
    assert.throws(() => set(event, patch), /Invalid preferences/);
  }
  assert.throws(() => set({ ...event, senderFrame: { url: event.senderFrame.url } }, { compact: true }), /Untrusted/);
  nativeWindow.webContents.mainFrame.url = 'https://attacker.example';
  assert.throws(() => set(event, { compact: true }), /Untrusted/);
  assert.equal(main.preferences().compact, false);
  nativeWindow.webContents.mainFrame.url = 'http://127.0.0.1:43210/';
  assert.equal(set(event, { compact: true }).compact, true);
});

test('preload preference subscription hides IPC events and removes its listener', () => {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = (...args) => Promise.resolve(args);
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }),
  });
  assert.equal(Object.isFrozen(bridge), true);
  assert.throws(() => bridge.onPreferencesChanged(null), /listener/);
  const values = [];
  const remove = bridge.onPreferencesChanged(value => values.push(value));
  const preferences = { compact: true, alwaysOnTop: true, closeToTray: false };
  ipcRenderer.emit('codewatch:preferences-changed', { sender: 'privileged' }, preferences);
  assert.deepEqual(values, [preferences]);
  remove();
  assert.equal(ipcRenderer.listenerCount('codewatch:preferences-changed'), 0);
  ipcRenderer.emit('codewatch:preferences-changed', {}, { compact: false });
  assert.equal(values.length, 1);
});
