import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';

const delay = 1200;
const env = await bootApp({ config: { wakeDelayMs: delay, drainDelayMs: 200, conversationListener: { enabled: false } } });
const { app, llm, pushGroupMsg, request, onebotHttp } = env;
const key = 'group:456';
const at = { type: 'at', data: { qq: '888' } };
const reply = messages => ({ toolCalls: [
  { name: 'send_message', args: { messages } }, { name: 'finish', args: { summary: '已回复' } }
] });
const pure = mid => pushGroupMsg(777, '甲', '', mid, { message: [at] });
const active = () => app.orchestrator.activeRuns.get(key);
const activity = () => app.sessions.current.get(active())?.activity;
const getMessage = mid => app.store.findByMid(key, mid);
const done = id => waitFor(() => {
  const session = app.sessions.get(id);
  return session?.status === 'done' && session;
});

try {
  llm.state.script.push(reply('我在，怎么啦？'));
  pure(501);
  const bareId = await waitFor(active);
  const bareDeadline = app.orchestrator.replyWindows.get(key).deadline;
  await waitFor(() => llm.state.requests.length === 1);
  assert.ok(Date.now() < bareDeadline, 'bare @ reaches the LLM before the ordinary send window ends');
  assert.match(JSON.stringify(llm.state.requests[0].messages), /#501/);
  assert.equal(onebotHttp.state.sends.length, 0);
  const bare = await done(bareId);
  assert.ok(bare.sent[0].sentAt >= bareDeadline);
  assert.equal(llm.state.requests.length, 1, 'no extra model request is needed just to wait for delivery');

  llm.state.script.push(reply('不应发送的旧回复'), reply('图片已收到'));
  pure(502);
  const photoId = await waitFor(active);
  await waitFor(() => activity() === '等待回复窗口…');
  pushGroupMsg(777, '甲', '', 503, { message: [{ type: 'image', data: { url: 'https://example.com/test.png' } }] });
  await waitFor(() => llm.state.requests.length === 3 && activity() === '等待回复窗口…');
  assert.match(JSON.stringify(llm.state.requests[2].messages), /本轮新增消息[\s\S]*#503/);
  const firstDeadline = app.orchestrator.replyWindows.get(key).deadline;
  pure(504);
  await waitFor(() => getMessage(504)?.nudgeForSessionId === photoId);
  const renewed = app.orchestrator.replyWindows.get(key).deadline;
  assert.ok(renewed > firstDeadline);
  const photo = await done(photoId);
  assert.deepEqual(photo.trigger.map(m => m.mid), [502, 503]);
  assert.equal(photo.trigger[1].media[0].kind, 'image');
  assert.deepEqual(photo.sent.map(m => m.text), ['图片已收到']);
  assert.ok(photo.sent[0].sentAt >= renewed);
  assert.equal(llm.state.requests.length, 3, 'a later bare @ renews sending without a model rerun');
  assert.equal(onebotHttp.state.sends.length, 2);

  await request('POST', '/api/config', { body: { wakeDelayMs: 7000 } });
  llm.state.script.push(reply('中止后不能发送'));
  pure(530);
  const cancelled = await waitFor(active);
  await waitFor(() => activity() === '等待回复窗口…');
  assert.equal((await request('POST', '/api/sessions/' + cancelled + '/abort', { body: {} })).status, 200);
  await waitFor(() => !active());
  assert.equal(app.sessions.get(cancelled).status, 'aborted');
  assert.equal(llm.state.requests.length, 4);
  assert.equal(onebotHttp.state.sends.length, 2);
  console.log('PASS bare @ thinks immediately, follows ordinary delivery timing and late-input handling, and remains cancellable');
} finally { await env.teardown(); }
