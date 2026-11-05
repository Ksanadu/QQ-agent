import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { APP_PARTS, readAppPart } from './_ui-load.mjs';
import { TIER_SLIDER_BANDS, sliderToTier, tierToSlider } from '../src/tier-slider.js';
import { matchPriceTable } from '../src/model-prices.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-settings-layout-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { DEFAULT_CONFIG } = await import('../src/config.js');
const dom = new JSDOM(fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8'), {
  runScripts: 'outside-only', url: 'http://127.0.0.1:3210'
});
const w = dom.window;
Object.assign(w, { structuredClone, TIER_SLIDER_BANDS, sliderToTier, tierToSlider, matchPriceTable,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  requestAnimationFrame: (f) => w.setTimeout(f, 0) });
const code = APP_PARTS.filter((p) => p !== '11-init.js').map(readAppPart).join('\n') + '\n' + readAppPart('12-concept2-ui.js');
w.eval(code + `
  window.qa = { state, renderSettings, saveConfig, flushSettingsSaves };
  refreshStatus = async () => {}; startListPoller = () => {}; startStatusPoller = () => {};
  api = async (url, opts = {}) => {
    if (url === '/api/config' && opts.method === 'POST') {
      const patch = JSON.parse(opts.body); window.saved.push(patch);
      return { config: window.mergeConfig(state.config, patch) };
    }
    if (url === '/api/chats') return { chats: [] };
    if (url === '/api/onebot/groups') return { groups: [] };
    if (url === '/api/snowluma/install') return { status: 'idle' };
    return {};
  };
`);
w.saved = [];
w.mergeConfig = (base, patch) => {
  const merge = (a, b) => {
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      if ('__replace__' in b) return structuredClone(b.__replace__);
      return Object.fromEntries([...new Set([...Object.keys(a || {}), ...Object.keys(b)])].map(k => [k, k in b ? merge(a?.[k], b[k]) : a[k]]));
    }
    return structuredClone(b);
  };
  return merge(base, patch);
};
const q = s => w.document.querySelector(s);
const qa = w.qa;
qa.state.config = structuredClone(DEFAULT_CONFIG);
qa.state.providers = [];
qa.state.chats = [{ key: 'group:100', chatName: '测试群' }];
qa.state.personaTemplates = {};
qa.state.skills = [];
qa.state.toolRegistry = [
  { id: 'send_message', category: 'messaging', icon: '💬', description: '发送文字。' },
  { id: 'send_to', category: 'messaging', icon: '📨', description: '跨会话发送。' },
  { id: 'web_search', category: 'web', icon: '🔍', description: '搜索网页。' },
  { id: 'inactive__tool', category: 'web', skillId: 'inactive' }
];
const show = section => { qa.state.settingsSection = section; qa.renderSettings(); assert.ok(!q('#settings-form > .empty-hint'), 'settings rendered'); };
const save = async () => { await qa.saveConfig({ quiet: true }); };
try {
  show('memory');
  assert.deepEqual([...w.document.querySelectorAll('.settings-menu-item')].map(e => e.textContent), ['模型 API', '搜索服务', '记忆与人设', '聊天设置', '界面与系统', '工具与技能']);
  assert.equal(w.document.querySelectorAll('#settings-form > .setcard.open').length, 2);
  q('#cfg-mem-interval').value = '7200000';
  q('#cfg-roletext').value = '合并后的人设';
  await save();
  assert.equal(qa.state.config.memory.consolidateMinIntervalMs, 7200000);
  assert.equal(qa.state.config.persona.roleText, '合并后的人设');
  show('memory'); assert.equal(q('#cfg-roletext').value, '合并后的人设');
  console.log('PASS merged memory/persona defaults expanded and saves both sections');

  for (const section of ['api', 'search']) {
    show(section);
    const cards = [...w.document.querySelectorAll('#settings-form > .setcard')];
    assert.ok(cards.length > 1);
    assert.equal(cards.filter(c => c.classList.contains('open')).length, 1);
    assert.ok(cards[0].classList.contains('open'));
  }
  show('chat');
  assert.equal(q('#settings-form').lastElementChild.id, 'settings-allow');
  assert.equal(q('#settings-allow h4').textContent, '白名单');
  q('#cfg-allowgroups').value = '100,200'; q('#sc-temperature').value = '0.7';
  await save();
  assert.deepEqual(qa.state.config.allow.groups, ['100', '200']);
  assert.equal(qa.state.config.api.temperature, 0.7);
  show('desktop');
  assert.ok(q('#cfg-theme')); assert.ok(q('#cfg-wsurl'));
  q('#cfg-wsurl').value = 'ws://127.0.0.1:3999'; q('#cfg-obtoken').value = '******';
  await save();
  assert.equal(qa.state.config.snowluma.wsUrl, 'ws://127.0.0.1:3999');
  assert.ok(!('accessToken' in w.saved.at(-1).snowluma));
  console.log('PASS first API/search cards expanded, whitelist last in chat, OneBot merged and saves');

  show('tools');
  assert.equal(q('#card-tools-list'), null);
  assert.equal(w.document.querySelectorAll('#settings-form > .setcard').length, 2);
  assert.equal(w.document.querySelectorAll('.tool-checkbox').length, 3);
  const messaging = q('#card-tools-messaging'), web = q('#card-tools-web');
  messaging.querySelector('.fold-head').click(); web.querySelector('.fold-head').click();
  messaging.querySelector('.fold-head').click();
  assert.ok(!messaging.classList.contains('open')); assert.ok(web.classList.contains('open'));
  assert.equal(q('#card-tools-web'), web, 'collapse never rebuilds sibling cards');
  web.querySelector('.category-checkbox').click();
  assert.ok(web.classList.contains('open'), 'header switch does not collapse card');
  qa.flushSettingsSaves(); await new Promise(r => setTimeout(r, 10));
  assert.equal(qa.state.config.tools.categories.web, false);
  q('[data-tool-id="send_message"].tool-checkbox').click();
  qa.flushSettingsSaves(); await new Promise(r => setTimeout(r, 10));
  assert.equal(qa.state.config.tools.overrides.send_message, false);
  q('#tools-enable-all').click(); await new Promise(r => setTimeout(r, 10));
  assert.equal(qa.state.config.tools.enabled, true);
  assert.equal(Object.keys(qa.state.config.tools.categories).length, 0);
  q('#tools-disable-all').click(); await new Promise(r => setTimeout(r, 10));
  assert.equal(w.saved.at(-1).tools.enabled, false);
  console.log('PASS tools use sibling settings cards; folds stay independent; switches and bulk actions persist');
} finally {
  dom.window.close(); fs.rmSync(dataDir, { recursive: true, force: true });
}

