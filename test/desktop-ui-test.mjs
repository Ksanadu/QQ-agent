import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { bootApp, waitFor } from './_harness.mjs';
import { APP_PARTS, readAppPart } from './_ui-load.mjs';
import { TIER_SLIDER_BANDS, sliderToTier, tierToSlider } from '../src/tier-slider.js';
import { matchPriceTable } from '../src/model-prices.js';
import { createPreferences } from '../desktop/preferences.js';
import { createDesktopGateway } from '../desktop/gateway.js';
import { shutdownLogUrl } from '../desktop/window-policy.js';

const env = await bootApp({ config: { telemetry: { enabled: false }, memory: { consolidateEnabled: false }, ui: { theme: 'dark' } } });
const prefs = createPreferences(path.join(env.dataDir, 'desktop-preferences.json'));
const desktopVersion = JSON.parse(fs.readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8')).version;
prefs.update({ backendUrl: env.base, railCollapsed: true });
const gateway = createDesktopGateway({ preferences: prefs });
const base = await gateway.start();
env.app.store.appendIncoming('group:456', { mid: 123, senderId: '777', senderName: '测试群友', text: '桌面验收消息', ts: Date.now() });
env.app.memory.append('group:456', 'memberImpression', '喜欢简洁的答复', { userId: '777', target: '测试群友' });
const session = env.app.sessions.create({ chatKey: 'group:456', trigger: [], triggerSummary: '桌面验收' });
session.messages = [{ role: 'assistant', content: '准备回答', reasoningSummary: '检查最新补充再回答。' },
  { toolCall: { name: 'send_message', args: { messages: ['已处理'] }, result: '成功', isError: false } }];
session.sent = [{ text: '已处理' }];
env.app.sessions.finish(session.id, 'done');
const dom = new JSDOM(await fetch(base + '/desktop/index.html').then(r => r.text()), { runScripts: 'outside-only', url: base });
const w = dom.window, errors = [];
let leave, quit = 0, shutdownJob, offline = false;
const job = { url: 'http://127.0.0.1:12345', token: 'a'.repeat(64) };
Object.assign(w, { structuredClone, AbortController, AbortSignal, TIER_SLIDER_BANDS, sliderToTier, tierToSlider, matchPriceTable,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  requestAnimationFrame: fn => w.setTimeout(fn, 0), scrollTo() {},
  EventSource: class { addEventListener() {} close() {} },
  qqAgentShell: { refocus() {}, quit() { quit++; }, onPrepareLeave(callback) { leave = callback; },
    async openShutdownLog(value) { shutdownJob = value; } },
  fetch: async (url, options) => {
    const target = new URL(url, base);
    assert.equal(target.origin, base, 'renderer stays on its desktop adapter');
    if (offline && target.pathname === '/api/status') throw new TypeError('测试后台离线');
    if (target.pathname === '/api/shutdown') return Response.json(job); // Never stop a real process in this DOM test.
    return fetch(target, options);
  }
});
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; };
w.console.error = (...args) => errors.push(args.map(String).join(' '));
w.addEventListener('error', event => errors.push(event.message));
const scripts = APP_PARTS.filter(p => p !== '11-init.js').map(readAppPart).join('\n') + '\n' + readAppPart('12-concept2-ui.js');
w.eval(scripts + '\n' + fs.readFileSync(new URL('../desktop/ui/runtime.js', import.meta.url), 'utf8') + `
  startStatusPoller = () => {}; startListPoller = () => {};
  window.qa = { state, loadSessions, selectSession, loadMemoryView, loadMemoryDetail, loadSettings, renderSettings,
    loadUsageView, loadModulePage, loadSnowlumaPage, saveConfig, switchTab, refreshStatus, openShutdownDialog };
  window.confirmShutdown = value => { uiConfirm = async () => value; };
` + readAppPart('11-init.js'));
const q = selector => w.document.querySelector(selector), qa = w.qa;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const showSettings = async section => {
  qa.state.settingsSection = section;
  await qa.loadSettings();
  assert.ok(!q('#settings-form').textContent.includes('渲染失败'));
};
try {
  await waitFor(() => q('#desktop-version').textContent === desktopVersion && qa.state.config, 5000, 'desktop initialization');
  await qa.loadSessions();
  await qa.selectSession(session.id);
  assert.match(q('#session-detail .reasoning-flow').textContent, /最新补充/);
  assert.match(q('#session-detail').textContent, /send_message/);
  q('#json-mode-btn').click();

  const sidebar = q('#desktop-rail-toggle'), detail = q('#session-detail');
  const configBeforeCollapse = JSON.stringify(env.app.getConfig());
  assert.equal(w.document.body.dataset.railCollapsed, 'true', 'restores the persisted desktop preference');
  assert.equal(sidebar.getAttribute('aria-expanded'), 'false');
  assert.equal(sidebar.getAttribute('aria-label'), '展开侧栏');
  sidebar.click();
  assert.equal(w.document.body.dataset.railCollapsed, 'false');
  assert.equal(sidebar.getAttribute('aria-label'), '收起侧栏');
  for (let i = 0; i < 3; i++) sidebar.click();
  await leave();
  assert.equal(w.document.body.dataset.railCollapsed, 'true');
  assert.equal(prefs.get().railCollapsed, true, 'rapid clicks persist the final state');
  assert.equal(createPreferences(path.join(env.dataDir, 'desktop-preferences.json')).get().railCollapsed, true);
  assert.equal(q('#session-detail'), detail, 'collapse never remounts the active page');
  assert.equal(qa.state.currentSessionId, session.id);
  assert.equal(JSON.stringify(env.app.getConfig()), configBeforeCollapse, 'layout writes never touch the robot config');
  for (const tab of w.document.querySelectorAll('#tabs .tab')) assert.equal(tab.title, tab.querySelector('span').textContent);
  assert.ok(q('#desktop-quit svg'), 'exit remains available in the compact footer');
  sidebar.click(); await leave();
  console.log('PASS animated sidebar state/ARIA, saved compact layout, rapid reversals, page identity and backend isolation');
  assert.match(q('#session-detail').textContent, /inputMessages/);
  q('#json-mode-btn').click();

  const pages = [ ['memory', qa.loadMemoryView, '#memory-items'], ['usage', () => qa.loadUsageView({ force: true }), '#usage-page'],
    ['skills', () => qa.loadModulePage('all'), '#skills-page'], ['snowluma', qa.loadSnowlumaPage, '#snowluma-page'],
    ['settings', qa.loadSettings, '#settings-form'] ];
  for (const [tab, load, selector] of pages) {
    q(`#tabs [data-tab="${tab}"]`).click();
    await load();
    assert.equal(qa.state.tab, tab);
    assert.equal(q('#layout > .view.active').id, 'view-' + tab);
    assert.equal(q(`#tabs [data-tab="${tab}"]`).getAttribute('aria-current'), 'page');
    assert.ok(q(selector).textContent.trim());
    assert.ok(!/渲染失败|加载失败/.test(q(selector).textContent), tab);
  }
  for (const section of ['api','search','chat','memory','desktop','tools','archive']) await showSettings(section);
  assert.deepEqual([...w.document.querySelectorAll('.settings-menu-item')].map(el => el.textContent.trim()),
    ['模型 API','搜索服务','聊天设置','记忆人设','界面系统','工具技能','会话存档']);
  console.log('PASS six desktop pages, seven settings sections, reasoning/tools/JSON and original business handlers');

  await showSettings('api');
  q('#open-model-config-btn').click();
  assert.ok(q('#mc-model-pick')); assert.ok(q('#mc-baseurl'));
  q('.model-modal-close').click(); await pause(450);
  await showSettings('chat');
  assert.ok(q('#card-active-config').classList.contains('open'));
  assert.ok(q('#settings-allow #blocklist-btn'));
  await showSettings('tools');
  assert.ok(q('#cfg-list-stickers-limit'));
  q('#cfg-list-stickers-limit').value = '36';
  await qa.saveConfig({ quiet: true });
  assert.equal(env.app.getConfig().tools.listStickersLimit, 36);

  await showSettings('desktop');
  assert.ok(q('#cfg-autostart')); assert.ok(q('#install-snowluma-btn'));
  assert.equal(q('#check-update-btn'), null, 'no upstream core updater');
  q('#cfg-theme').value = 'light'; q('#cfg-refreshms').value = '7000';
  q('#cfg-closetray').checked = false;
  q('#cfg-theme').dispatchEvent(new w.Event('change', { bubbles: true }));
  await qa.saveConfig({ quiet: true });
  assert.equal(prefs.get().ui.theme, 'light');
  assert.equal(prefs.get().ui.refreshMs, 7000);
  assert.equal(prefs.get().desktop.closeToTray, false);
  assert.equal(env.app.getConfig().ui.theme, 'dark');
  assert.notEqual(env.app.getConfig().ui.refreshMs, 7000);
  console.log('PASS model dialog, editable tool limit, SnowLuma install entry and isolated desktop settings');

  qa.switchTab('skills'); await qa.loadModulePage('all');
  q('#skills-add-btn').click();
  assert.ok(q('#ic-codes')); assert.equal(q('#addmod-diy'), null);
  q('.model-modal-close').click(); await pause(450);
  assert.ok(q('.mcard-uninstall'));
  const skillCount = qa.state.skills.length;
  q('.mcard-uninstall').click();
  assert.equal(q('.module-clear-data').checked, false);
  q('.module-uninstall-cancel').click(); await pause(450);
  assert.equal(qa.state.skills.length, skillCount);
  q('#desktop-connection').click(); await waitFor(() => q('#desktop-connection-dialog').open);
  assert.equal(q('#desktop-backend-url').value, env.base);
  q('#desktop-connection-cancel').click();
  offline = true; await qa.refreshStatus();
  assert.match(q('#onebot-label').textContent, /后台未连接/);
  assert.ok(q('#desktop-reconnect'));
  offline = false; await qa.refreshStatus();
  assert.match(q('#onebot-label').textContent, /已连接/);
  assert.ok(q('#banner').classList.contains('hidden'));
  w.confirmShutdown(false); await qa.openShutdownDialog(); assert.equal(shutdownJob, undefined);
  w.confirmShutdown(true); await qa.openShutdownDialog(); assert.deepEqual(shutdownJob, job);
  assert.equal(shutdownLogUrl(job), job.url + '/#' + job.token);
  assert.throws(() => shutdownLogUrl({ ...job, url: 'https://example.com' }));
  assert.throws(() => shutdownLogUrl({ ...job, token: 'not-a-token' }));
  q('#desktop-quit').click(); assert.equal(quit, 1);
  await leave();
  assert.equal((await env.request('GET', '/api/status')).status, 200);
  assert.deepEqual(errors, []);
  console.log('PASS install/connection dialogs, disconnect recovery, confirmed shutdown handoff and save-before-quit');
} finally {
  dom.window.close();
  await gateway.stop();
  await env.teardown();
}
