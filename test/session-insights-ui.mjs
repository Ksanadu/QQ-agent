import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="session-detail"></div>', { runScripts: 'outside-only' });
const w = dom.window;
Object.assign(w, {
  state: {}, STATUS_LABEL: { done: '已完成', noreply: '已结束' },
  $: sel => w.document.querySelector(sel),
  esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  formatChatTitle: () => '测试群', chatNameOf: () => '测试群',
  fmtClock: t => new Date(t).toLocaleTimeString('zh-CN', { hour12: false }), fmtTokens: n => n || 0,
  uiEnter: () => {}
});
w.eval(fs.readFileSync(new URL('../ui/app/02-sse-sessions.js', import.meta.url), 'utf8') + '\nwindow.renderSessionDetail = renderSessionDetail; window.resetDetail = () => { lastDetailFp = null; };');
const base = { id: 'main', chatKey: 'group:123', status: 'done', startedAt: Date.now(), model: '测试模型', messages: [] };
const draw = s => { w.resetDetail(); w.renderSessionDetail(s); return w.document.querySelector('#session-detail'); };
const main = { ...base, messages: [
  { role: 'assistant', content: null, reasoningSummary: '先检查图片，再比较构图。\n<不要执行 HTML>', tool_calls: [{ id: '1' }] },
  { toolCall: { name: 'get_message_images', args: { messageId: -503 }, result: '已读取图片', isError: false } },
  { role: 'assistant', content: '两张图片的光线有明显差异。' }
] };
let box = draw(main);
assert.equal(box.querySelectorAll('.reasoning-flow').length, 1);
assert.equal(box.querySelector('.reasoning-flow').open, false);
assert.match(box.querySelector('.reasoning-flow').textContent, /先检查图片/);
assert.match(box.textContent, /模型输出/);
assert.equal(box.querySelector('不要执行'), null);
box.querySelector('.reasoning-flow').open = true;
w.renderSessionDetail({ ...main, messages: [...main.messages, { role: 'assistant', content: '继续处理。' }] });
assert.equal(box.querySelector('.reasoning-flow').open, true, 'updates preserve expansion');
const mainHtml = box.innerHTML;
assert.equal(draw({ ...base, messages: [{ role: 'assistant', content: '普通输出' }] }).querySelectorAll('.reasoning-flow').length, 0);

const listener = { ...base, id: 'listener', status: 'noreply', taskType: 'conversation-listener', triggerSummary: '独立关联监听', messages: [
  { listenerCheck: { related: true, ids: [4], checkedAt: Date.now(), reason: '继续追问机器人刚才的图片比较。', entries: [
    { id: 4, messageId: -503, sender: '甲', senderId: '900001', text: '那第二张的光线呢？', replyTo: -500 },
    { id: 5, messageId: -504, sender: '乙', senderId: '900002', text: '<img src=x onerror=alert(1)>有人打游戏吗' }
  ] } },
  { listenerCheck: { related: false, ids: [], reason: '群友在聊其他话题。', entries: [{ id: 6, messageId: -505, sender: '乙', text: '晚上一起打游戏' }] } },
  { listenerCheck: { related: false, ids: [], reason: '关联判断暂不可用', error: '请求超时', entries: [{ id: 7, messageId: -506, sender: '甲', text: '再看看这张' }] } },
  { listenerCheck: { related: false, ids: [8], reason: '旧版本判定依据' } }
] };
box = draw(listener);
assert.equal(box.querySelectorAll('.listener-flow').length, 4);
assert.match(box.textContent, /判定依据/);
assert.match(box.textContent, /对应消息/);
assert.match(box.textContent, /#-503 · 选为相关消息/);
assert.match(box.textContent, /引用 #-500/);
assert.match(box.textContent, /不相关/);
assert.match(box.textContent, /判定失败/);
assert.match(box.textContent, /旧记录未保存消息正文/);
assert.equal(box.querySelector('img'), null);
box.querySelectorAll('.listener-flow').forEach(d => { d.open = true; });
const listenerHtml = box.innerHTML;
box.querySelector('#json-mode-btn').click();
assert.match(box.textContent, /listenerChecks/);
assert.match(box.textContent, /那第二张的光线呢/);
w.state.sessionJsonMode = 'main';
assert.match(draw(main).textContent, /reasoningSummary/);
if (process.env.INSIGHTS_PREVIEW) {
  fs.writeFileSync(process.env.INSIGHTS_PREVIEW, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>会话过程预览</title><style>${fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')} body{overflow:auto;padding:24px}main{max-width:1000px;margin:auto}section{margin-bottom:32px}</style><main><section>${mainHtml}</section><section>${listenerHtml}</section></main></html>`);
}
dom.window.close();
console.log('PASS session UI: returned reasoning, listener evidence/messages, escaping, expansion and JSON');
