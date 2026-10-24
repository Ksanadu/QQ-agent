import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JSDOM } from 'jsdom';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-model-connection-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { getConfig, setRuntimeConfig, updateConfig, DEFAULT_CONFIG, loadConfig } = await import('../src/config.js');
const { currentProviders, setProviderKey } = await import('../src/providers.js');
const { chatCompletion, resolveApiKey } = await import('../src/llm.js');
const { createRoutes } = await import('../src/routes.js');
const received = [];
const server = http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  received.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(text) });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ model: 'model-a', choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const fallbackModels = [{ model: 'backup-model', provider: 'b' }];
setRuntimeConfig({ ...structuredClone(DEFAULT_CONFIG),
  api: { ...DEFAULT_CONFIG.api, provider: 'a', model: 'model-a', apiKey: 'old-top-a', baseUrl: base + '/old/v1', fallbackModels },
  providers: [
    { id: 'a', displayName: 'A', baseURL: base + '/old/v1', apiKey: 'legacy-a', models: ['model-a'] },
    { id: 'b', displayName: 'B', baseURL: base + '/b/v1', models: ['model-b'] },
    { id: 'c', displayName: 'C', baseURL: base + '/c/v1', models: ['model-c'] }
  ],
  dshProviderKeys: { a: 'stored-a', b: 'stored-b' }
});
const dom = new JSDOM('<main></main>', { runScripts: 'outside-only', url: 'http://127.0.0.1:3210' });
const w = dom.window;
const refresh = () => {
  const config = structuredClone(getConfig());
  config.api.hasKey = Boolean(resolveApiKey(config));
  delete config.api.apiKey;
  delete config.dshProviderKeys;
  w.state = { config, providers: currentProviders().map(({ apiKey, ...p }) => ({ ...p, hasKey: Boolean(apiKey) })) };
};
refresh();
w.$ = (s) => w.document.querySelector(s);
w.$$ = (s) => [...w.document.querySelectorAll(s)];
w.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
w.visionBadge = () => '';
w.uiConfirm = async () => true;
const alerts = [];
w.alert = (text) => alerts.push(text);
w.loadSettings = async () => refresh();
const testRoute = createRoutes({ readBody: async (req) => req.body }).find((r) => r.pattern === '/api/providers/test-chat');
let saves = 0;
w.api = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : {};
  if (url === '/api/config') { saves++; updateConfig(body); return { ok: true }; }
  if (url === '/api/providers/set-key') { setProviderKey(body.providerId, body.apiKey); return { ok: true }; }
  if (url.startsWith('/api/providers/key?')) {
    const id = new URL(url, 'http://localhost').searchParams.get('providerId');
    return { apiKey: currentProviders().find((p) => p.id === id)?.apiKey || '' };
  }
  if (url === '/api/api-key') return { apiKey: getConfig().api.apiKey || '' };
  if (url === '/api/providers/test-chat') {
    let result;
    await testRoute.handler({ req: { body }, json: (_res, status, value) => { assert.equal(status, 200); result = value; } });
    return result;
  }
  throw new Error('Unexpected test URL: ' + url);
};
w.eval(fs.readFileSync(new URL('../ui/app/08-modals.js', import.meta.url), 'utf8') + '\ncloseModelModal = (overlay) => overlay.remove(); window.openModelConfigModal = openModelConfigModal;');
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(fn) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await tick(); }
  throw new Error('Timed out waiting for UI');
}
const el = (s) => w.document.querySelector(s);
const open = () => { refresh(); w.openModelConfigModal(); };
const save = async () => { el('#mc-save').click(); await until(() => !el('#mc-save')); };
const pick = (pid) => {
  el('#mc-model-pick').click();
  el(`#mcp-left [data-pid="${pid}"]`).click();
  el('#mcp-right .mm-model').click();
};

try {
  open();
  assert.equal(el('#mc-baseurl').readOnly, false);
  el('#mc-baseurl').value = base + '/edited/v1/';
  el('#mc-apikey').value = 'new-a';
  el('#mc-apikey-toggle').click(); await tick();
  assert.equal(el('#mc-apikey').value, 'new-a');
  assert.equal(el('#mc-apikey').type, 'text');
  el('#mc-apikey-toggle').click();
  assert.equal(el('#mc-apikey').value, 'new-a');
  await save();
  assert.equal(resolveApiKey(getConfig()), 'new-a');
  assert.equal(currentProviders()[0].apiKey, 'new-a');
  assert.equal(currentProviders()[0].baseURL, base + '/edited/v1');
  assert.equal(loadConfig().dshProviderKeys.a, 'new-a');
  await chatCompletion({ messages: [{ role: 'user', content: 'test' }] });
  assert.equal(received.at(-1).url, '/edited/v1/chat/completions');
  assert.equal(received.at(-1).authorization, 'Bearer new-a');
  console.log('✓ edited URL and key persist and are used by the actual chat client');

  open();
  assert.equal(el('#mc-apikey').value, '******');
  el('#mc-apikey').value = '';
  await save();
  updateConfig({ api: { apiKey: '******' } });
  assert.equal(resolveApiKey(getConfig()), 'new-a');
  assert.deepEqual(getConfig().api.fallbackModels, fallbackModels);
  console.log('✓ blank/masked keys preserve credentials and backup model order');

  open();
  pick('b');
  el('#mc-test-btn').click();
  await until(() => !el('#mc-test-btn').disabled);
  assert.equal(received.at(-1).authorization, 'Bearer stored-b');
  assert.equal(getConfig().api.provider, 'a');
  el('#mc-baseurl').value = base + '/edited-b/v1';
  el('#mc-apikey').value = 'new-b';
  await save();
  assert.equal(getConfig().api.provider, 'b');
  assert.equal(getConfig().api.baseUrl, base + '/edited-b/v1');
  assert.equal(currentProviders().find((p) => p.id === 'b').baseURL, base + '/edited-b/v1');
  assert.equal(resolveApiKey(getConfig()), 'new-b');
  assert.equal(getConfig().dshProviderKeys.a, 'new-a');
  console.log('✓ switching provider tests its saved key and saves the edited connection');

  open();
  el('#mc-apikey-clear').click();
  await until(() => el('#mc-apikey').value === '');
  assert.equal(resolveApiKey(getConfig()), '');
  assert.equal(currentProviders().find((p) => p.id === 'b').apiKey, '');
  el('#mc-cancel').click();
  setProviderKey('b', 'restored-b');
  open(); pick('c'); await save();
  assert.equal(resolveApiKey(getConfig()), '');
  assert.equal(getConfig().api.apiKey, '');
  console.log('✓ clearing removes fallback credentials; keyless providers do not inherit another key');

  open();
  const before = saves;
  el('#mc-baseurl').value = 'not-a-url';
  el('#mc-save').click(); await tick();
  assert.equal(saves, before);
  assert.match(el('#mc-test-result').textContent, /HTTP/);
  el('#mc-cancel').click();
  updateConfig({ api: { provider: '', baseUrl: base + '/manual/v1', apiKey: 'manual-key' } });
  open();
  assert.equal(el('#mc-apikey').value, '******');
  el('#mc-apikey').value = 'edited-manual';
  await save();
  assert.equal(resolveApiKey(getConfig()), 'edited-manual');
  assert.equal(alerts.length, 0);
  console.log('✓ invalid URLs stay unsaved and manual connections remain editable');
} finally {
  dom.window.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
