import assert from 'node:assert/strict';
import { bootApp, waitFor, sleep } from './_harness.mjs';
const env = await bootApp({ config: { wakeDelayMs: 30, store: { contextSliderPos: 10, peakSchedule: { enabled: false } }, conversationListener: { enabled: true, idleMs: 6000 } }, script: [
  { delayMs: 1400, toolCalls: [{ name: 'send_message', args: { messages: '第一问的回答' } }] },
  { content: JSON.stringify({ related: true, ids: [2], reason: '对刚才的请求补充要求' }) },
  { toolCalls: [{ name: 'send_message', args: { messages: '补充要求的回答' } }] },
  { delayMs: 2000, content: JSON.stringify({ related: true, ids: [99], reason: '伪造旧 ID' }) }
] });
try {
  const { app, llm, pushGroupMsg } = env;
  pushGroupMsg(777, '甲', '@覆盖Bot 第一问', -601);
  await waitFor(() => llm.state.requests.length === 1);
  pushGroupMsg(777, '甲', '再补充一点，按时间顺序说', -602);
  await waitFor(() => llm.state.requests.length === 2);
  assert.equal(app.orchestrator.runningChats.size, 1);
  assert.equal(app.orchestrator.pendingWake.size, 0, 'related handoff waits for active main run');
  await waitFor(() => env.onebotHttp.state.sends.length === 2);
  await waitFor(() => app.orchestrator.runningChats.size === 0);
  assert.equal(llm.state.requests.length, 3, 'one classifier and exactly two main replies');
  assert.equal(app.orchestrator.listeners.feed('group:456', app.store.findByMid('group:456', -602)), true);
  assert.equal(app.orchestrator.listeners.feed('group:456', app.store.findByMid('group:456', -602)), false);
  assert.equal(app.orchestrator.listeners.feed('group:789', app.store.findByMid('group:456', -602)), false);
  await waitFor(() => llm.state.requests.length === 4);
  const active = app.orchestrator.listeners.tasks.get('group:456');
  app.orchestrator.abortSession(active.sessionId);
  assert.equal(app.orchestrator.listeners.tasks.size, 0);
  await sleep(2100);
  assert.equal(llm.state.requests.length, 4, 'cancelled in-flight result cannot wake main');
  assert.equal(env.onebotHttp.state.sends.length, 2);
  console.log('PASS listener concurrency: related messages during main run wait then reply exactly once; duplicate/cross-chat feed and cancelling an in-flight LLM result are contained');
} finally { await env.teardown(); }
