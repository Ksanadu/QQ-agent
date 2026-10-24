import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';
const env = await bootApp({ config: { wakeDelayMs: 100, store: { historyCount: 20 } }, script: [
  { toolCalls: [{ name: 'react_message', args: { messageId: -101, emojiId: '76' } }] },
  { toolCalls: [
    { name: 'react_message', args: { messageId: -800, emojiId: '66' } },
    { name: 'react_message', args: { messageId: -800, emojiId: '99' } },
    { name: 'send_message', args: { messages: '替你开心！' } }
  ] },
  { toolCalls: [{ name: 'react_message', args: { messageId: -101, emojiId: '76' } }] },
  { toolCalls: [{ name: 'finish', args: { reason: '没有可贴的相关消息' } }] },
  { toolCalls: [{ name: 'react_message', args: { messageId: 104, emojiId: '66' } }] },
  { toolCalls: [{ name: 'finish', args: { reason: '接口失败，安静结束' } }] }
] });
const { app, pushGroupMsg, waitSessionDone, llm, onebotHttp } = env;
const waitForMessageRun = async (mid) => waitFor(() => {
  const run = app.sessions.listSummaries(20).map((summary) => app.sessions.get(summary.id))
    .find((session) => session.trigger?.some((m) => m.mid === mid));
  return run && run.status !== 'running' && run.status !== 'waiting' ? run : null;
}, 10000, `消息 ${mid} 的运行结束`);
const calls = [];
const originalCall = app.onebot.call.bind(app.onebot);
let failReaction = false;
app.onebot.call = async (action, params) => {
  if (action !== 'set_msg_emoji_like') return originalCall(action, params);
  if (failReaction) throw new Error('mock QQ 不支持此表情');
  calls.push({ action, params }); return {};
};
try {
  app.store.appendIncoming('group:456', { mid: -800, senderId: '222', senderName: '佬虎', text: '刚才发的好消息', ts: Date.now() });
  app.store.drainUnread('group:456');
  pushGroupMsg(777, '甲', '只贴表情测试 @覆盖Bot', -101);
  const first = await waitSessionDone('只贴表情测试');
  assert.equal(first.status, 'done'); assert.equal(first.sent.length, 1); assert.equal(first.sent[0].type, 'reaction');
  assert.equal(calls[0].params.message_id, -101); assert.equal(onebotHttp.state.sends.length, 0);
  assert.equal(llm.state.requests.length, 1, 'reaction-only delivery ends without redundant LLM turns or forced text');
  const firstRequest = llm.state.requests[0];
  assert.ok(firstRequest.tools.some((t) => t.function.name === 'react_message'));
  const firstPrompt = firstRequest.messages.find((m) => m.role === 'user').content;
  assert.match(firstPrompt, /【本轮可贴表情的消息】/); assert.match(firstPrompt, /#-101（本轮消息）/);
  console.log('✓ real incoming event → prompt + tool → queued QQ reaction → delivered; no extra text');

  pushGroupMsg(777, '甲', '多种表情加文字测试', 102, { message: [
    { type: 'reply', data: { id: '-101' } }, { type: 'at', data: { qq: '888' } },
    { type: 'text', data: { text: '多种表情加文字测试：给佬虎刚才的消息贴爱心和鼓掌' } }
  ] });
  const second = await waitForMessageRun(102);
  assert.equal(second.status, 'done'); assert.deepEqual(second.sent.map((r) => r.type), ['reaction', 'reaction', 'text']);
  assert.deepEqual(calls.slice(1).map((c) => [c.params.message_id, c.params.emoji_id]), [[-800, '66'], [-800, '99']]);
  assert.equal(onebotHttp.state.sends.length, 1); assert.equal(llm.state.requests.length, 2);
  const secondPrompt = llm.state.requests[1].messages.find((m) => m.role === 'user').content;
  assert.match(secondPrompt, /#-101（之前10条）/);
  assert.match(secondPrompt, /#-800（之前10条）.*佬虎.*222/);
  assert.ok(!calls.slice(1).some((c) => c.params.message_id === 102), 'requester message never substituted for named other person');
  console.log('✓ named other person in previous-ten window receives both reactions; requester is not substituted; normal reply also works');

  for (let i = 0; i < 11; i++) app.store.appendIncoming('group:456', {
    mid: 700 + i, senderId: '555', senderName: '路人', text: `后续消息${i}`, ts: Date.now(), read: true
  });
  app.store.drainUnread('group:456');
  pushGroupMsg(777, '甲', '禁止翻旧消息贴表情测试 @覆盖Bot', 103);
  const third = await waitSessionDone('禁止翻旧消息');
  assert.equal(third.sent.length, 0); assert.equal(calls.length, 3);
  const lastRequest = llm.state.requests[3];
  assert.ok(lastRequest.messages.some((m) => m.role === 'tool' && String(m.content).includes('只能给本轮')));
  console.log('✓ an older message outside the previous-ten window is forbidden even when visible in 20-message context');

  failReaction = true;
  pushGroupMsg(777, '甲', '贴表情失败测试 @覆盖Bot', 104);
  const fourth = await waitSessionDone('贴表情失败测试');
  assert.equal(fourth.sent.length, 0); assert.equal(onebotHttp.state.sends.length, 1);
  await waitFor(() => llm.state.requests.length >= 6);
  assert.ok(llm.state.requests[5].messages.some((m) => m.role === 'tool' && String(m.content).includes('mock QQ 不支持')));
  console.log('✓ QQ API failure is returned to model, never shown as successful delivery');
} finally { await env.teardown(); }
