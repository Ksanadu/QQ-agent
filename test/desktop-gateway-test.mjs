import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createDesktopGateway } from '../desktop/gateway.js';
import { createPreferences, backendAddress } from '../desktop/preferences.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-desktop-gateway-'));
const prefsFile = path.join(temp, 'prefs.json');
const preferences = createPreferences(prefsFile);
let cfg = { api: { model: 'test' }, ui: { theme: 'dark', refreshMs: 25000 }, server: { autoStart: true, closeToTray: false } };
let writes = [], streamClosed = false, backendVersion;
const backend = http.createServer(async (req, res) => {
  if (req.url === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: hello\ndata: {"ok":true}\n\n');
    res.on('close', () => { streamClosed = true; });
    return;
  }
  if (req.url === '/api/status') return res.end(JSON.stringify({ version: backendVersion, onebot: { connected: true }, orchestrator: {}, dataDir: 'synthetic-data' }));
  if (req.url !== '/api/config') { res.writeHead(404); return res.end(); }
  if (req.method === 'POST') {
    let text = ''; for await (const chunk of req) text += chunk;
    const patch = JSON.parse(text); writes.push(patch);
    cfg = { ...cfg, ...patch };
    return res.end(JSON.stringify({ ok: true, config: cfg }));
  }
  res.end(JSON.stringify(cfg));
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
preferences.update({ backendUrl: 'http://127.0.0.1:' + backend.address().port });
const gateway = createDesktopGateway({ preferences });
const base = await gateway.start();
const request = async (route, patch) => {
  const response = await fetch(base + route, patch ? { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(patch) } : {});
  return { status: response.status, data: await response.json() };
};
try {
  const html = await fetch(base + '/desktop/index.html').then(r => r.text());
  assert.match(html, /desktop-shell/);
  for (const id of ['view-sessions','view-memory','view-usage','view-skills','view-settings','view-snowluma']) assert.ok(html.includes(`id="${id}"`));
  assert.match(await fetch(base + '/app/00-core.js').then(r => r.text()), /function api/);
  assert.equal((await fetch(base + '/group-qrcode.jpg')).headers.get('content-type'), 'image/jpeg');
  const icon = await fetch(base + '/desktop/assets/icon.svg');
  assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.match(await icon.text(), /id="icon-arrow"/);
  await request('/desktop/api/preferences', { railCollapsed: true });
  assert.equal(writes.length, 0);
  assert.equal(newPreferences().get().railCollapsed, true);
  assert.throws(() => preferences.update({ railCollapsed: 'false' }), /布尔/);
  assert.equal((await request('/desktop/api/runtime')).data.ownsBackend, false);
  assert.equal((await request('/api/config')).data.ui.theme, 'dark');
  await request('/api/config', { ui: { theme: 'light' }, server: { autoStart: false, closeToTray: true } });
  assert.equal(writes.length, 0, 'desktop preferences never become backend config writes');
  assert.deepEqual(cfg.ui, { theme: 'dark', refreshMs: 25000 });
  assert.equal(cfg.server.autoStart, true);
  assert.equal((await request('/api/config')).data.ui.theme, 'light');
  const changed = await request('/api/config', { ui: { theme: 'dark' }, api: { model: 'next-model' } });
  assert.deepEqual(writes, [{ api: { model: 'next-model' } }]);
  assert.equal(changed.data.config.api.model, 'next-model');
  assert.equal(changed.data.config.ui.theme, 'dark');
  assert.equal(newPreferences().get().ui.theme, 'dark');
  preferences.update({ window: { width: 1000, height: 700, maximized: true } });
  assert.deepEqual(newPreferences().get().window, { width: 1000, height: 700, maximized: true });
  preferences.update({ window: { width: 10, height: 20, maximized: false } });
  assert.deepEqual(preferences.get().window, { width: 960, height: 640, maximized: false });
  assert.throws(() => backendAddress('https://example.com'), /本机/);
  assert.throws(() => backendAddress('http://user:secret@127.0.0.1:3210'), /本机/);
  backendVersion = '0.5.1';
  const unsupported = await request('/desktop/api/preferences', { backendUrl: preferences.get().backendUrl });
  assert.equal(unsupported.status, 502); assert.match(unsupported.data.error, /兼容/);
  backendVersion = undefined;
  assert.equal((await fetch(base + '/api/config', { method: 'POST', headers: { origin: 'https://example.com' }, body: '{}' })).status, 403);
  const response = await fetch(base + '/api/events');
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: hello/);
  await reader.cancel();
  await gateway.stop();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(streamClosed, true);
  assert.equal((await fetch(preferences.get().backendUrl + '/api/status')).status, 200, 'exiting desktop keeps the backend alive');
  console.log('PASS desktop asset reuse, API/SSE forwarding, visual preference isolation, loopback boundary and independent exit');
} finally {
  await gateway.stop().catch(() => {});
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
function newPreferences() { return createPreferences(prefsFile); }
