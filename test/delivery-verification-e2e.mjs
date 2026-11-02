import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';
const env = await bootApp({ config: { wakeDelayMs: 25 }, script: [
  { toolCalls: [{ name: 'send_message', args: { messages: '这一条已经实际送达' } }] },
  { toolCalls: [{ name: 'react_message', args: { messageId: 9001, emojiId: '76' } }] },
  { toolCalls: [{ name: 'finish', args: { summary: '文字和贴表情均已完成' } }] }
] });
const originalFetch = globalThis.fetch;
let attempts = 0;
globalThis.fetch = async (url, init, ...rest) => {
  if (String(url) === env.app.onebot.httpUrl + '/send_group_msg') {
    attempts++;
    const params = JSON.parse(init.body);
    setTimeout(() => env.onebotWs.push({
      post_type: 'message_sent', message_type: 'group', group_id: 456,
      user_id: 888, self_id: 888, message_id: 9876, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 888 }, message: params.message
    }), 350);
    return new Response(JSON.stringify({ status: 'failed', retcode: 100, wording: 'send group message rejected: result=241 err=' }),
      { headers: { 'content-type': 'application/json' } });
  }
  if (String(url).endsWith('/set_msg_emoji_like')) return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: {} }));
  return originalFetch(url, init, ...rest);
};
try {
  env.pushGroupMsg(777, '测试者', '@覆盖Bot 回复之后给我贴表情', 9001);
  const session = await waitFor(() => {
    const s = env.app.sessions.listSummaries(10).map(x => env.app.sessions.get(x.id)).find(s => s.trigger?.some(m => m.mid === 9001));
    return s?.status === 'done' && s;
  }, 8000);
  assert.equal(attempts, 1, 'a verified delivery must not be rewritten and submitted again');
  const send = session.messages.find(m => m.toolCall?.name === 'send_message').toolCall;
  assert.equal(send.isError, false);
  assert.match(send.result, /9876/);
  assert.equal(session.completion.delivered, true);
  assert.deepEqual(session.sent.map(s => s.type), ['text', 'reaction']);
  assert.equal(env.llm.state.requests.length, 3, 'delivery does not automatically terminate the model run');
  assert.equal(env.app.store.recent('group:456', { limit: 20 }).filter(m => m.mid === 9876 && m.self).length, 1);
  console.log('PASS failed response → actual WS self echo → successful send_message → follow-up reaction → explicit finish; one outbound submission and one archive entry');
} finally {
  globalThis.fetch = originalFetch;
  await env.teardown();
}
