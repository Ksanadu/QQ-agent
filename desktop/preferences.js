import fs from 'node:fs';
import path from 'node:path';

export function backendAddress(value = 'http://127.0.0.1:3210') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('后台地址须为本机 HTTP 地址，例如 http://127.0.0.1:3210');
  }
  return url.origin;
}

const defaults = () => ({ backendUrl: 'http://127.0.0.1:3210',
  ui: { theme: 'dark', showVision: true, refreshMs: 15000 },
  desktop: { autoStart: false, closeToTray: true }, railCollapsed: false,
  window: { width: 1360, height: 860, maximized: false } });

function windowSize(saved = {}) {
  const size = (v, fallback, min) => Number.isFinite(Number(v)) ? Math.min(8192, Math.max(min, Math.round(Number(v)))) : fallback;
  return { width: size(saved.width, 1360, 960), height: size(saved.height, 860, 640), maximized: saved.maximized === true };
}

export function createPreferences(file, { onChange = () => {} } = {}) {
  let value = defaults();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    value = { ...value, ...saved, railCollapsed: saved.railCollapsed === true, backendUrl: backendAddress(saved.backendUrl),
      ui: { ...value.ui, ...saved.ui }, desktop: { ...value.desktop, ...saved.desktop }, window: windowSize(saved.window) };
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('桌面偏好文件无法读取，请保留原文件后检查：' + file); }
  return {
    get: () => structuredClone(value),
    update(patch) {
      const next = { ...value, ...patch, ui: { ...value.ui, ...patch.ui }, desktop: { ...value.desktop, ...patch.desktop },
        window: windowSize({ ...value.window, ...patch.window }) };
      next.backendUrl = backendAddress(next.backendUrl);
      if (typeof next.railCollapsed !== 'boolean') throw new Error('侧栏状态须为布尔值');
      if (!['light', 'dark'].includes(next.ui.theme)) throw new Error('不支持的桌面主题');
      next.ui.refreshMs = Math.max(1000, Number(next.ui.refreshMs) || 15000);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
      fs.renameSync(file + '.tmp', file);
      value = next;
      onChange(this.get());
      return this.get();
    }
  };
}
