import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';
const env = await bootApp({ config: { wakeDelayMs: 30 }, script: [
  { toolCalls: [{ name: 'search_chat_history', args: { query: '旧推荐' } }, { name: 'set_task_context', args: { summary: '依次比较两张照片', messageIds: [-11, -12] } }] },
  { toolCalls: [{ name: 'finish', args: { reason: '保存完成' } }] },
  { toolCalls: [{ name: 'finish', args: { reason: '继续第二张' } }] }
] });
try {
  const { app, pushGroupMsg, llm } = env;
  const store = app.store;
  for (let i = 1; i <= 110; i++) store.appendIncoming('group:456', { mid: -i, senderId: '777', senderName: '甲', ts: Date.parse('2026-10-24T10:00:00+08:00') + i, text: i === 11 ? '旧推荐 游戏链接' : '普通聊天', media: i === 11 || i === 12 ? [{ kind: 'image', url: 'https://example.com/a.jpg' }] : [] });
  store.appendIncoming('group:789', { mid: -999, senderId: '777', text: '旧推荐 不能泄漏' });
  assert.equal(store.search('group:456', { query: '旧推荐 游戏', sender: '777', from: '2026-10-24', to: '2026-10-24' }).messages[0].messageId, -11);
  assert.equal(store.search('group:456', { query: '', imagesOnly: true }).total, 2);
  assert.equal(store.search('group:456', { query: '不能泄漏' }).total, 0);
  assert.equal(store.search('group:456', { query: '普通', limit: 5, offset: 5 }).hasMore, true);
  assert.throws(() => store.search('group:456', { from: 'bad date' }));
  store.drainUnread('group:456');
  pushGroupMsg(777, '甲', '@覆盖Bot 找旧推荐并保存图片顺序', -200);
  await waitFor(() => llm.state.requests.length >= 2);
  await waitFor(() => app.orchestrator.runningChats.size === 0);
  const result = llm.state.requests[1].messages.find(m => m.role === 'tool' && m.name === 'search_chat_history');
  assert.ok(JSON.parse(result.content).messages.some(m => m.messageId === -11));
  pushGroupMsg(777, '甲', '@覆盖Bot 第二张继续', -201);
  await waitFor(() => llm.state.requests.length >= 3);
  const prompt = llm.state.requests[2].messages.find(m => m.role === 'user').content;
  assert.match(prompt, /连续任务对象/); assert.match(prompt, /依次比较两张照片/);
  const tasks = app.orchestrator.tasks;
  assert.deepEqual(tasks.forTriggers('group:456', [{ senderId: '777' }], store)[0].targets.map(x => x.messageId), [-11, -12]);
  assert.equal(tasks.forTriggers('group:789', [{ senderId: '777' }], store).length, 0);
  assert.equal(tasks.forTriggers('group:456', [{ senderId: '999' }], store).length, 0);
  assert.throws(() => tasks.save('group:456', '777', '错目标', [-999], store));
  const { ConversationTasks } = await import('../src/conversation-tasks.js');
  assert.equal(new ConversationTasks({ file: tasks.file }).forTriggers('group:456', [{ senderId: '777' }], store).length, 1);
  store.markRecalled('group:456', -12);
  const recalled = tasks.forTriggers('group:456', [{ senderId: '777' }], store)[0].targets;
  assert.equal(recalled[1].unavailable, true); assert.equal(String(recalled[1].messageId), '-12');
  assert.equal(recalled.length, 2, 'recalling one target must not shift the ordinal of another');
  store.markRecalled('group:456', -11);
  assert.ok(!store.search('group:456', { query: '旧推荐' }).messages.some(m => m.messageId === -11));
  const expiry = new ConversationTasks({ file: tasks.file, now: () => Date.now() + 3 * 60 * 60 * 1000 });
  assert.equal(expiry.forTriggers('group:456', [{ senderId: '777' }], store).length, 0);
  console.log('PASS Phase 1: archive search beyond prompt, dates, paging, exact scoped IDs; ordered task persistence, participant/chat isolation, recall and expiry; real model/tool/prompt integration');
} finally { await env.teardown(); }
