import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { backendAddress } from './preferences.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let size = 0, text = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求内容过大');
    text += chunk;
  }
  return text ? JSON.parse(text) : {};
}

export async function probeBackend(address) {
  const base = backendAddress(address);
  const res = await fetch(base + '/api/status', { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!res.ok) throw new Error('后台未就绪：HTTP ' + res.status);
  const state = await res.json();
  if ((state.version && !/^0\.4\./.test(state.version)) || !state.onebot || !state.orchestrator || !state.dataDir) {
    throw new Error('此地址不是兼容的 QQ Agent 0.4 后台');
  }
  return { backendUrl: base, connected: !!state.onebot.connected, dataDir: state.dataDir };
}

// This server is a desktop asset/API adapter, never a second robot core.
// All QQ, model, memory and protocol operations remain with the selected backend.
export function createDesktopGateway({ preferences, legacyUiDir = path.resolve(HERE, '../ui'),
  desktopUiDir = path.join(HERE, 'ui'), desktopAssetsDir = path.join(HERE, 'assets'), port = 0,
  version = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version }) {
  const sockets = new Set(), upstreams = new Set();
  let origin;
  const prefsConfig = cfg => ({ ...cfg, ui: { ...cfg.ui, ...preferences.get().ui },
    server: { ...cfg.server, ...preferences.get().desktop } });
  async function configRequest(req, res, base) {
    let patch;
    if (req.method === 'POST') {
      patch = await body(req);
      const local = {};
      if (patch.ui) { local.ui = patch.ui; delete patch.ui; }
      if (patch.server) {
        local.desktop = {};
        for (const key of ['autoStart', 'closeToTray']) {
          if (Object.hasOwn(patch.server, key)) { local.desktop[key] = patch.server[key]; delete patch.server[key]; }
        }
        if (!Object.keys(patch.server).length) delete patch.server;
      }
      if (Object.keys(local).length) preferences.update(local);
    }
    const write = patch && Object.keys(patch).length;
    const response = await fetch(base + '/api/config', { method: write ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-console-token': 'qq-agent-console', origin: base },
      ...(write ? { body: JSON.stringify(patch) } : {}), signal: AbortSignal.timeout(15000), redirect: 'error' });
    const data = await response.json();
    if (!response.ok) return json(res, response.status, data);
    json(res, 200, req.method === 'POST'
      ? { ...(!write ? { ok: true } : data), config: prefsConfig(write ? data.config : data) }
      : prefsConfig(data));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: '请求来源不匹配' });
      const route = new URL(req.url, origin).pathname;
      if (route === '/desktop/api/preferences') {
        if (req.method === 'GET') return json(res, 200, preferences.get());
        if (req.method !== 'POST') return json(res, 405, { error: '不支持的请求' });
        const patch = await body(req);
        if (patch.backendUrl) await probeBackend(patch.backendUrl);
        return json(res, 200, preferences.update(patch));
      }
      if (route === '/desktop/api/runtime') {
        const connection = await probeBackend(preferences.get().backendUrl);
        return json(res, 200, { ...connection, version, mode: 'attached', ownsBackend: false });
      }
      if (route === '/api/config' && ['GET', 'POST'].includes(req.method)) {
        return await configRequest(req, res, preferences.get().backendUrl);
      }
      if (route.startsWith('/api/')) {
        const target = new URL(req.url, preferences.get().backendUrl);
        const headers = { ...req.headers, host: target.host, origin: target.origin,
          'x-console-token': 'qq-agent-console' };
        delete headers.connection;
        const upstream = http.request(target, { method: req.method, headers }, response => {
          res.writeHead(response.statusCode, response.headers);
          pipeline(response, res, () => {});
        });
        upstreams.add(upstream);
        upstream.on('close', () => upstreams.delete(upstream));
        upstream.on('error', () => {
          if (!res.headersSent) json(res, 502, { error: '无法连接机器人后台，请检查桌面连接地址' });
          else res.destroy();
        });
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持的请求' });
      if (route === '/') { res.writeHead(302, { location: '/desktop/index.html' }); return res.end(); }
      const desktop = route.startsWith('/desktop/');
      const asset = route.startsWith('/desktop/assets/');
      const root = asset ? desktopAssetsDir : desktop ? desktopUiDir : legacyUiDir;
      const relative = decodeURIComponent(asset ? route.slice('/desktop/assets/'.length) : desktop ? route.slice('/desktop/'.length) : route.slice(1));
      const file = path.resolve(root, relative);
      if (file === path.resolve(root) || !file.startsWith(path.resolve(root) + path.sep)) return json(res, 403, { error: '路径越界' });
      if (!MIME[path.extname(file)] || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: '文件不存在' });
      const realRoot = fs.realpathSync(root), real = fs.realpathSync(file);
      if (!real.startsWith(realRoot + path.sep)) return json(res, 403, { error: '路径越界' });
      let contents = fs.readFileSync(file);
      if (file === path.join(desktopUiDir, 'index.html')) {
        const legacy = fs.readFileSync(path.join(legacyUiDir, 'index.html'), 'utf8');
        const views = legacy.match(/<main id="layout">[\s\S]*?<\/main>/)?.[0];
        if (!views) throw new Error('现有 Web 页面结构与桌面适配器不兼容');
        contents = Buffer.from(contents.toString().replace('<!--desktop:views-->', views));
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)], 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (!res.headersSent) json(res, 502, { error: error.message }); else res.destroy();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return {
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      origin = 'http://127.0.0.1:' + server.address().port;
      return origin;
    },
    async stop() {
      for (const request of upstreams) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
