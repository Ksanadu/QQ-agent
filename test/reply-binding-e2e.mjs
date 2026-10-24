import assert from 'node:assert/strict';
import { bootApp, waitFor, sleep } from './_harness.mjs';
const env = await bootApp({ config: { store: { contextSliderPos: 0, historyCount: 1 }, wakeDelayMs: 250,
  security: { allowPrivateImageHosts: true } },
  script: Array.from({ length: 8 }, () => ({ toolCalls: [{ name: 'finish', args: { reason: 'mock' } }] })) });
const { app, pushGroupMsg, onebotWs, llm } = env;
let reads = 0;
const fullA = '引用对象A，旧消息。'.repeat(40) + 'A的末尾结论。';
app.onebot.getMsg = async id => {
  reads++;
  if (String(id) === '-400') return { message_id: -400, group_id: 456, sender: { user_id: 222, nickname: '原图发送者' }, message: [{ type: 'image', data: { file: 'exact.png', url: `http://127.0.0.1:${env.onebotHttp.server.address().port}/img.png` } }] };
  throw new Error('message unavailable');
};
try {
  pushGroupMsg(111, '甲', fullA, -101);
  pushGroupMsg(222, '乙', '引用对象B，是另一条消息。', -102);
  await waitFor(() => app.store.findByMid('group:456', -102), 2000);
  const quote = (id, mid) => pushGroupMsg(777, '提问者', '', mid, { message: [{ type: 'reply', data: { id: String(id) } }, { type: 'at', data: { qq: '888' } }, { type: 'text', data: { text: ' 评价一下' } }] });
  quote(-101, 301); quote(-102, 302);
  pushGroupMsg(333, '路人', '这是最新闲聊，不能被错当成评价对象。', 303);
  await waitFor(() => llm.state.requests.length >= 1, 5000);
  const prompt = llm.state.requests[0].messages.find(m => m.role === 'user').content;
  assert.match(prompt, /请求消息 #301 → 引用目标 #-101/);
  assert.match(prompt, /请求消息 #302 → 引用目标 #-102/);
  assert.match(prompt, /A的末尾结论/);
  assert.equal(app.store.findByMid('group:456', 301).reply.messageId, '-101');
  assert.equal(app.store.findByMid('group:456', 302).reply.messageId, '-102');
  assert.equal(reads, 0, 'Already stored reply targets do not depend on remote lookups');
  console.log('✓ two identical evaluation requests in one batch retain separate exact targets despite newer chatter');
  await sleep(600);
  const imageIndex = llm.state.requests.length;
  llm.state.script[imageIndex] = { toolCalls: [
    { name: 'get_message_detail', args: { messageId: -400 } },
    { name: 'get_message_images', args: { messageId: -400 } }
  ] };
  onebotWs.push({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 777, message_id: 304,
    sender: { user_id: 777, nickname: '提问者' }, message: '[CQ:reply,id=-400][CQ:at,qq=888]评价这张图' });
  await waitFor(() => llm.state.requests.length >= imageIndex + 2, 5000);
  const imagePrompt = llm.state.requests[imageIndex].messages.find(m => m.role === 'user').content;
  assert.match(imagePrompt, /请求消息 #304 → 引用目标 #-400/);
  assert.match(imagePrompt, /get_message_images\(messageId=-400\)/);
  assert.equal(app.store.findByMid('group:456', 304).reply.media[0].file, 'exact.png');
  const toolMessages = llm.state.requests[imageIndex + 1].messages.filter(m => m.role === 'tool');
  assert.ok(toolMessages.some(m => String(m.content).includes('原图发送者')));
  assert.ok(toolMessages.some(m => String(m.content).includes('消息 -400 的内容')));
  console.log('✓ quoted image in CQ string binds the source image ID and media, including targets outside local history');
  await sleep(600);
  const missingIndex = llm.state.requests.length;
  quote(-999, 305);
  await waitFor(() => llm.state.requests.length > missingIndex, 5000);
  const missing = llm.state.requests[missingIndex].messages.find(m => m.role === 'user').content;
  assert.match(missing, /请求消息 #305 → 引用目标 #-999/); assert.match(missing, /不要拿最新消息/);
  assert.equal(app.store.findByMid('group:456', 305).reply.resolved, false);
  console.log('✓ failed quote lookup remains explicit; no latest-message substitution');
} finally { await env.teardown(); }
