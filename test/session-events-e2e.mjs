import assert from 'node:assert/strict';
import { bootApp } from './_harness.mjs';

const env = await bootApp({ config: { wakeDelayMs: 30 }, script: [
  { reasoning: '先读取群成员，再回复。', toolCalls: [{ name: 'get_active_members', args: {} }] },
  { toolCalls: [{ name: 'send_message', args: { messages: '事件验收已回复' } },
    { name: 'finish', args: { summary: '事件验收完成' } }] },
  { delayMs: 2000, toolCalls: [{ name: 'send_message', args: { messages: '不应发送' } },
    { name: 'finish', args: {} }] }
] });
const controller = new AbortController();
let reader;
try {
  const res = await fetch(env.base + '/api/events', {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
  });
  assert.equal(res.status, 200);
  reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function nextEvent() {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const lines = event.split('\n');
        const data = lines.find(l => l.startsWith('data: '));
        if (data) return { type: lines.find(l => l.startsWith('event: '))?.slice(7),
          data: JSON.parse(data.slice(6)) };
      } else {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'SSE remains connected during the test');
        buffer += decoder.decode(value, { stream: true });
      }
    }
  }
  assert.equal((await nextEvent()).type, 'hello');
  env.pushGroupMsg(900001, '甲', '事件验收：回复一句', -920, { atMe: true });
  const updates = [];
  let completed;
  while (!completed) {
    const event = await nextEvent();
    if (event.type === 'session-update') {
      assert.equal(typeof event.data, 'object', 'session-update must expand the emitted session ID into a snapshot');
      assert.ok(event.data.sessionId);
      assert.equal(event.data.chatKey, 'group:456');
      updates.push(event.data);
    }
    if (event.type === 'session-end') completed = event.data;
  }
  assert.equal(completed.status, 'done');
  assert.ok(updates.some(s => s.activity.includes('get_active_members')));
  assert.ok(updates.some(s => s.messages.some(m => m.reasoningSummary === '先读取群成员，再回复。')));
  assert.ok(updates.some(s => s.sent.some(m => m.text === '事件验收已回复')));

  env.pushGroupMsg(900001, '甲', '事件验收：中止测试', -921, { atMe: true });
  let abortSent = false, sawAborting = false;
  for (;;) {
    const event = await nextEvent();
    if (event.type === 'session-update' && event.data.trigger.includes('中止测试')) {
      if (!abortSent && event.data.activity.includes('正在思考')) {
        const aborted = await env.request('POST', `/api/sessions/${event.data.sessionId}/abort`, { body: {} });
        assert.equal(aborted.data.ok, true);
        abortSent = true;
      }
      if (event.data.activity === '正在中止…') sawAborting = true;
    }
    if (event.type === 'session-end') {
      assert.equal(event.data.status, 'aborted'); break;
    }
  }
  assert.equal(abortSent, true);
  assert.equal(sawAborting, true, 'the UI receives the in-progress abort status without polling');
  assert.equal(env.onebotHttp.state.sends.length, 1);
  console.log('PASS real HTTP SSE expands session IDs, streams reasoning/tools/receipts, and exposes abort status');
} finally {
  controller.abort();
  try { await reader?.cancel(); } catch { /* Abort already closed it. */ }
  await env.teardown();
}
