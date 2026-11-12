import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';

const reply = text => ({ toolCalls: [
  { name: 'send_message', args: { messages: text } }, { name: 'finish', args: { summary: 'fixture' } }
] });
const env = await bootApp({ config: {
  wakeDelayMs: 100, sessionRetryAttempts: 0, conversationListener: { enabled: false },
  store: { contextSliderPos: 0 }, memory: { consolidateEnabled: false }
} });
const { app, pushGroupMsg, onebotWs, llm, waitSessionDone } = env;
const key = 'group:456';
const recall = mid => onebotWs.push({ post_type: 'notice', notice_type: 'group_recall',
  group_id: 456, user_id: 777, operator_id: 777, message_id: mid });
try {
  llm.state.script.push({ ...reply('撤回后不发送'), delayMs: 600 });
  pushGroupMsg(777, '提问者', '@覆盖Bot 撤回唯一请求', 901);
  await waitFor(() => llm.state.requests.length === 1);
  recall(901);
  const cancelled = await waitSessionDone('撤回唯一请求');
  assert.equal(cancelled.status, 'noreply');
  assert.ok(app.store.findByMid(key, 901).recalled);
  assert.equal(env.onebotHttp.state.sends.length, 0);
  await waitFor(() => !app.orchestrator.runningChats.has(key));

  const original = '撤回后不应复制进提示词的原文';
  const m = app.store.appendIncoming(key, { mid: -902, text: original, senderId: '9101', senderName: '被引用者' });
  app.store.markEntryRead(key, m.id);
  llm.state.script.push({ ...reply('引用撤回前的旧稿'), delayMs: 600 }, reply('引用原文已撤回，请重发'));
  pushGroupMsg(777, '提问者', '', 903, { message: [
    { type: 'reply', data: { id: '-902' } }, { type: 'at', data: { qq: '888' } },
    { type: 'text', data: { text: '评价这个引用' } }
  ] });
  await waitFor(() => llm.state.requests.length === 2);
  recall(-902);
  const rebound = await waitFor(() => app.sessions.listSummaries(30).map(s => app.sessions.get(s.id))
    .find(s => s.trigger?.some(m => m.mid === 903) && !['waiting', 'running'].includes(s.status)));
  assert.equal(rebound.status, 'done');
  assert.equal(llm.state.requests.length, 3);
  assert.ok(!JSON.stringify(llm.state.requests[2].messages).includes(original));
  assert.match(JSON.stringify(llm.state.requests[2].messages), /已撤回/);
  assert.deepEqual(rebound.sent.map(s => s.text), ['引用原文已撤回，请重发']);

  recall(904);
  await waitFor(() => app.store.isRecalled(key, 904));
  const before = llm.state.requests.length;
  pushGroupMsg(777, '提问者', '@覆盖Bot 先撤回后入库', 904);
  await waitFor(() => app.store.findByMid(key, 904)?.recalled);
  assert.equal(llm.state.requests.length, before);
  console.log('PASS real OneBot recall events: cancel draft, rebuild exact quotes, preserve tombstones through late ingress');
} finally { await env.teardown(); }
