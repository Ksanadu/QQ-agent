import assert from 'node:assert/strict';
import { bootApp, waitFor, sleep } from './_harness.mjs';

// Actual worker -> mock LLM -> main orchestrator handoff, no keyword shortcut.
const env = await bootApp({ config: { wakeDelayMs: 30, store: { contextTier: 1, contextSliderPos: 10, peakSchedule: { enabled: false } }, conversationListener: { enabled: true, idleMs: 4000 } }, script: [
  { toolCalls: [{ name: 'send_message', args: { messages: '第一张构图不错，你想比较哪里？' } }] },
  { content: JSON.stringify({ related: false, ids: [], reason: '群友在聊别的游戏' }) },
  { content: JSON.stringify({ related: true, ids: [4, 99999], reason: '继续回答机器人的比较问题' }) },
  { toolCalls: [{ name: 'send_message', args: { messages: '第二张可以再看一下光线。' } }] }
] });
try {
  const { app, pushGroupMsg, llm } = env, events = [];
  app.orchestrator.emit = (type, value) => events.push({ type, value });
  pushGroupMsg(777, '甲', '@覆盖Bot 比较这组照片', -501);
  await waitFor(() => env.onebotHttp.state.sends.length === 1);
  await waitFor(() => app.orchestrator.runningChats.size === 0);
  assert.equal(app.orchestrator.listeners.tasks.size, 1);
  const first = app.orchestrator.listeners.tasks.get('group:456'), deadline = first.until;
  pushGroupMsg(999, '乙', '有人打游戏吗', -502); // local ID 3 (bot response occupies 2)
  await waitFor(() => events.some(e => e.type === 'listener-check'));
  assert.equal(app.orchestrator.listeners.tasks.get('group:456').until, deadline, 'unrelated traffic must not refresh lifetime');
  assert.equal(env.onebotHttp.state.sends.length, 1);
  pushGroupMsg(777, '甲', '那第二张的光线呢', -503); // ID 4
  await waitFor(() => env.onebotHttp.state.sends.length === 2);
  const checks = llm.state.requests.filter(r => r.messages[0]?.content?.includes('独立关联监听'));
  assert.equal(checks.length, 2); assert.ok(checks.every(r => !r.tools));
  const main = llm.state.requests[3]; assert.match(main.messages.find(m => m.role === 'user').content, /第二张的光线/);
  assert.ok(!main.messages.find(m => m.role === 'user').content.includes('#99999'));
  const sessions = app.sessions.listSummaries(30).map(s => app.sessions.get(s.id));
  assert.ok(sessions.some(s => s.followUpFromListener && s.trigger.some(m => m.mid === -503)));
  const child = sessions.find(s => s.taskType === 'conversation-listener' && s.usage.calls === 2);
  assert.ok(child?.parentSessionId); assert.ok(child.usage.totalTokens > 0);
  await waitFor(() => app.orchestrator.listeners.tasks.size === 0, 8000, 'idle worker exits');
  const before = llm.state.requests.length;
  pushGroupMsg(777, '甲', '窗口已经结束，不要再自动接话', -504);
  await sleep(650); assert.equal(llm.state.requests.length, before);
  // Explicit triggers still work and restart a single worker; pausing kills it.
  pushGroupMsg(777, '甲', '@覆盖Bot 再开启一次', -505);
  await waitFor(() => app.orchestrator.listeners.tasks.size === 1);
  app.orchestrator.setPaused(true);
  assert.equal(app.orchestrator.listeners.tasks.size, 0);
  assert.equal(app.orchestrator.listenerRelevant.size, 0);
  console.log('PASS Phase 5: real isolated worker + LLM classification, unrelated no reply/no extension, exact relevant ID handoff without @, child usage audit, timeout termination, restart and pause cleanup');
} finally { await env.teardown(); }
