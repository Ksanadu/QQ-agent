import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createPreferences } from '../desktop/preferences.js';
import { shutdownLogUrl } from '../desktop/window-policy.js';

// Exercise Electron lifecycle contracts with native effects mocked, especially
// autostart: these checks never change the user's Windows startup settings.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-desktop-lifecycle-'));
const source = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('fileURLToPath(import.meta.url)', 'MAIN_FILE');
function fixture(primary, label) {
  const events = [], windows = [], paths = { appData: root, userData: path.join(root, label) };
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; },
    setAppUserModelId: value => events.push(['appId', value]), disableHardwareAcceleration() {},
    requestSingleInstanceLock: () => primary, whenReady: () => Promise.resolve(),
    setLoginItemSettings: value => events.push(['login', value]),
    quit: () => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; app.emit('before-quit', e); if (!e.prevented) events.push(['quit']); } });
  const ipcMain = new EventEmitter(), handlers = {};
  ipcMain.handle = (key, callback) => { handlers[key] = callback; };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = true; this.minimized = false; this.maximized = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = callback => { this.openHandler = callback; };
      this.webContents.send = (_channel, id) => {
        events.push(['flush']);
        setTimeout(() => ipcMain.emit('desktop:leave-ready', this.frame(), { id, ok: true }), 5);
      };
      windows.push(this);
    }
    frame() { return { sender: this.webContents, senderFrame: this.webContents.mainFrame }; }
    async loadURL(value) { this.url = value; this.webContents.emit('did-start-loading'); events.push(['load', value]); }
    getNormalBounds() { return { width: this.options.width, height: this.options.height }; }
    maximize() { this.maximized = true; } isMaximized() { return this.maximized; }
    isMinimized() { return this.minimized; } restore() { this.minimized = false; }
    isDestroyed() { return false; } show() { this.visible = true; } hide() { this.visible = false; } focus() {}
  }
  class Tray {
    setToolTip() {} setContextMenu(menu) { this.menu = menu; } on() {}
    destroy() { events.push(['tray-stop']); }
  }
  const gateway = { async start() { events.push(['gateway-start']); return 'http://127.0.0.1:1234'; }, async stop() { events.push(['gateway-stop']); } };
  let preferences;
  const process = { env: { QQ_DESKTOP_USER_DATA: paths.userData }, execPath: 'C:/QA/QQ Agent Desktop.exe' };
  vm.runInNewContext(source, { MAIN_FILE: path.join(root, 'main.js'), app, BrowserWindow: Window, Tray,
    Menu: { buildFromTemplate: value => value }, ipcMain, shell: { openExternal() {} },
    dialog: { showErrorBox: (...args) => events.push(['error', ...args]) }, path, randomUUID: () => 'qa-leave-id',
    process, fs: { readFileSync: () => '{"version":"0.4.3"}' }, setTimeout, clearTimeout, URL,
    createPreferences: (...args) => { preferences = createPreferences(...args); return preferences; },
    createDesktopGateway: () => gateway, shutdownLogUrl });
  return { app, events, windows, ipcMain, handlers, get preferences() { return preferences; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
try {
  const second = fixture(false, 'secondary'); await tick();
  assert.equal(second.windows.length, 0); assert.equal(second.preferences, undefined);
  assert.deepEqual(second.events.filter(([e]) => /gateway|login/.test(e)), []);
  const main = fixture(true, 'primary'); await tick();
  const window = main.windows[0];
  assert.equal(main.windows.length, 1);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(main.events.filter(([e]) => e === 'login').length, 0);
  main.preferences.update({ ui: { theme: 'light' } });
  assert.equal(main.events.filter(([e]) => e === 'login').length, 0);
  main.preferences.update({ desktop: { autoStart: true } });
  assert.equal(main.events.filter(([e]) => e === 'login').length, 1);
  main.preferences.update({ ui: { theme: 'dark' } });
  assert.equal(main.events.filter(([e]) => e === 'login').length, 1);
  main.preferences.update({ desktop: { autoStart: false } });
  assert.equal(main.events.filter(([e]) => e === 'login').length, 2);
  const close = { preventDefault() { this.prevented = true; } };
  window.emit('close', close);
  assert.equal(close.prevented, true); assert.equal(window.visible, false);
  assert.equal(main.events.filter(([e]) => e === 'gateway-stop').length, 0);
  window.minimized = true; main.app.emit('second-instance');
  assert.equal(window.visible, true); assert.equal(window.minimized, false);
  await assert.rejects(() => main.handlers['desktop:shutdown-log']({}, {}), /来源/);
  await main.handlers['desktop:shutdown-log'](window.frame(), { url: 'http://127.0.0.1:4321', token: 'a'.repeat(64) });
  const log = main.windows[1];
  assert.equal(log.options.webPreferences.preload, undefined);
  assert.equal(log.options.webPreferences.sandbox, true);
  const nav = { preventDefault() { this.prevented = true; } };
  log.webContents.emit('will-navigate', nav, 'https://example.com'); assert.equal(nav.prevented, true);
  main.ipcMain.emit('desktop:renderer-ready', window.frame());
  main.ipcMain.emit('desktop:quit', {}); await tick();
  assert.equal(main.events.filter(([e]) => e === 'quit').length, 0);
  main.ipcMain.emit('desktop:quit', window.frame());
  main.ipcMain.emit('desktop:quit', window.frame()); await tick();
  assert.deepEqual(main.events.filter(([e]) => ['flush','gateway-stop','tray-stop','quit'].includes(e)).map(([e]) => e),
    ['flush','tray-stop','gateway-stop','quit']);
  assert.equal(main.events.filter(([e]) => e === 'error').length, 0);
  console.log('PASS native single-instance, restore/tray, isolated autostart, shutdown log sandbox and save-before-quit lifecycle');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
