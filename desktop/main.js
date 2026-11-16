import { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDesktopGateway } from './gateway.js';
import { createPreferences } from './preferences.js';
import { shutdownLogUrl } from './window-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
app.setPath('userData', path.resolve(process.env.QQ_DESKTOP_USER_DATA || path.join(app.getPath('appData'), 'QQ Agent Desktop')));
app.setAppUserModelId('cn.ksanadu.qq-agent.desktop');
app.disableHardwareAcceleration();
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
let window, gateway, tray, quitting = false, ready = false, leaving, appliedAutoStart;
const waiters = new Map();
const prefs = primary ? createPreferences(path.join(app.getPath('userData'), 'desktop-preferences.json'), {
  onChange: value => {
    const next = !!value.desktop.autoStart;
    if (appliedAutoStart === next) return;
    app.setLoginItemSettings({ openAtLogin: next, name: 'cn.ksanadu.qq-agent.desktop',
      path: process.execPath, args: app.isPackaged ? [] : [HERE] });
    appliedAutoStart = next;
  }
}) : null;
appliedAutoStart = !!prefs?.get().desktop.autoStart;
if (primary && process.env.QQ_DESKTOP_BACKEND_URL) prefs.update({ backendUrl: process.env.QQ_DESKTOP_BACKEND_URL });
const showWindow = () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); };
const ownFrame = event => window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
ipcMain.on('desktop:refocus', event => { if (ownFrame(event)) showWindow(); });
ipcMain.on('desktop:renderer-ready', event => { if (ownFrame(event)) ready = true; });
ipcMain.on('desktop:leave-ready', (event, value) => { if (ownFrame(event)) waiters.get(value.id)?.(value); });
ipcMain.on('desktop:quit', event => { if (ownFrame(event)) void quitDesktop(); });
ipcMain.handle('desktop:shutdown-log', async (event, job) => {
  if (!ownFrame(event)) throw new Error('请求来源不匹配');
  const url = shutdownLogUrl(job), origin = new URL(url).origin;
  const logWindow = new BrowserWindow({ parent: window, width: 920, height: 680,
    title: '停机日志', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  logWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const stayLocal = (e, target) => { if (new URL(target).origin !== origin) e.preventDefault(); };
  logWindow.webContents.on('will-navigate', stayLocal);
  logWindow.webContents.on('will-redirect', stayLocal);
  await logWindow.loadURL(url);
});

async function prepareLeave() {
  if (!ready || window?.isDestroyed()) return;
  const id = randomUUID();
  const answer = await new Promise(resolve => {
    const timer = setTimeout(() => { waiters.delete(id); resolve({ ok: false, error: '界面保存尚未确认，请稍后重试' }); }, 10000);
    waiters.set(id, value => { clearTimeout(timer); waiters.delete(id); resolve(value); });
    window.webContents.send('desktop:prepare-leave', id);
  });
  if (!answer.ok) throw new Error(answer.error);
}
async function quitDesktop() {
  if (leaving) return leaving;
  leaving = (async () => {
    try { await prepareLeave(); quitting = true; tray?.destroy(); await gateway?.stop(); app.quit(); }
    catch (error) { dialog.showErrorBox('暂未退出桌面', error.message); }
    finally { leaving = null; }
  })();
  return leaving;
}

if (primary) {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quitDesktop(); } });
  app.whenReady().then(async () => {
    const legacyUiDir = app.isPackaged ? path.join(HERE, 'legacy-ui') : path.resolve(HERE, '../ui');
    const metadata = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
    gateway = createDesktopGateway({ preferences: prefs, legacyUiDir, version: metadata.version });
    const origin = await gateway.start();
    const size = prefs.get().window;
    const icon = path.join(HERE, 'assets/icon.ico');
    window = new BrowserWindow({ width: size.width, height: size.height, minWidth: 960, minHeight: 640, icon,
      title: 'QQ Agent Desktop', autoHideMenuBar: true,
      webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    if (size.maximized) window.maximize();
    const saveSize = () => {
      const { width, height } = window.getNormalBounds();
      prefs.update({ window: { width, height, maximized: window.isMaximized() } });
    };
    for (const event of ['resized', 'maximize', 'unmaximize']) window.on(event, saveSize);
    window.webContents.on('did-start-loading', () => { ready = false; });
    window.webContents.on('render-process-gone', () => { ready = false; });
    window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
    window.on('close', event => {
      if (!quitting) { event.preventDefault(); if (prefs.get().desktop.closeToTray) window.hide(); else void quitDesktop(); }
    });
    tray = new Tray(icon);
    tray.setToolTip('QQ Agent Desktop');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开桌面', click: showWindow },
      { type: 'separator' }, { label: '退出桌面', click: () => void quitDesktop() }
    ]));
    tray.on('double-click', showWindow);
    await window.loadURL(origin + '/desktop/index.html');
    if (process.env.QQ_DESKTOP_READY_FILE) fs.writeFileSync(process.env.QQ_DESKTOP_READY_FILE,
      JSON.stringify({ pid: process.pid, origin, backendUrl: prefs.get().backendUrl, ownsBackend: false }));
  }).catch(error => { dialog.showErrorBox('桌面启动失败', error.message); quitting = true; app.quit(); });
}
