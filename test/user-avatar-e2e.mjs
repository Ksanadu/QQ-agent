import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { bootApp, waitFor } from './_harness.mjs';

const downloaded = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=';
const lookup = dns.promises.lookup;
const request = https.request;
dns.promises.lookup = (host, ...args) => host === 'q1.qlogo.cn'
  ? Promise.resolve([{ address: '1.1.1.1', family: 4 }]) : lookup(host, ...args);
https.request = (opts, callback) => {
  if (opts.servername !== 'q1.qlogo.cn') return request(opts, callback);
  const req = new EventEmitter();
  req.end = () => {
    const url = new URL(opts.path, 'https://q1.qlogo.cn');
    downloaded.push(url.searchParams.get('nk'));
    const res = Readable.from([Buffer.from(png, 'base64')]);
    res.statusCode = 200;
    res.headers = { 'content-type': 'image/png' };
    callback(res);
  };
  return req;
};

let env;
try {
  env = await bootApp({ config: { wakeDelayMs: 650, store: { contextSliderPos: 100 } } });
  const { app, llm, pushGroupMsg, waitSessionDone } = env;
  const text = value => ({ type: 'text', data: { text: value } });
  const at = qq => ({ type: 'at', data: { qq } });
  const reply = id => ({ type: 'reply', data: { id } });
  const avatar = requestMessageId => ({ name: 'get_user_avatar', args: { requestMessageId } });
  const send = message => ({ name: 'send_message', args: { messages: [message] } });
  const finish = { name: 'finish', args: { summary: 'fixture' } };
  const offered = r => r.tools.some(t => t.function.name === 'get_user_avatar');
  app.onebot.getGroupMemberInfo = async () => ({ nickname: '同名' });
  app.onebot.getMsg = async mid => { throw Error(`unexpected quote lookup: ${mid}`); };
  const { bindAvatarRequest } = await import('../src/user-avatar.js');
  const bind = (segments, quoted) => bindAvatarRequest({ segments, senderId: '900001', botId: '888888', reply: quoted });
  assert.equal(bind([at('888888'), text(' 看看我的 QQ 头像')]), '900001');
  assert.equal(bind([text('看看 '), at('900002'), text(' 和 '), at('900003'), text(' 的头像')]), null);
  assert.equal(bind([text('看看 @同名 的头像')]), null);
  assert.equal(bind([reply(-80), text('看看他的头像')], { resolved: true, messageId: -81, senderId: '900003' }), null);
  assert.equal(bind([reply(-80), text('他头像换了')], { resolved: true, messageId: -80, senderId: '900003', text: '看看我的头像' }), null);
  assert.equal(bind([{ type: 'forward', data: {} }, text('看看我的头像')]), null);

  llm.state.script.push({ toolCalls: [avatar(10), send('收到闲聊'), finish] });
  pushGroupMsg(900003, '同名', '今天换了个头像', 10);
  await waitSessionDone('今天换了个头像');
  assert.equal(offered(llm.state.requests[0]), false);
  assert.deepEqual(downloaded, []);
  const from = llm.state.requests.length;
  llm.state.script[from] = { toolCalls: [
    { name: 'read_skill_guide', args: { skillId: 'core-media' } },
    avatar(10), avatar(-21), avatar(22), avatar(23)
  ] };
  llm.state.script[from + 1] = { toolCalls: [send('收到头像'), finish] };
  pushGroupMsg(900001, '请求者', '看看我的头像', -21);
  pushGroupMsg(900001, '请求者', '', 22, { message: [text('看看 '), at('900002'), text(' 的头像')] });
  pushGroupMsg(900001, '请求者', '', 23, { message: [reply(10), text('看下他的头像')] });
  const s = await waitSessionDone('看看我的头像');
  assert.equal(offered(llm.state.requests[from]), true);
  assert.deepEqual(downloaded, ['900001', '900002', '900003']);
  assert.equal(s.messages.filter(m => m.toolCall?.name === 'get_user_avatar' && m.toolCall.isError).length, 1);
  const images = llm.state.requests[from + 1].messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(part => part.type === 'image_url');
  assert.equal(images.length, 3);
  assert.ok(images.every(part => part.image_url.url === `data:image/png;base64,${png}`));

  app.updateConfig({ api: { vision: false } });
  const after = llm.state.requests.length;
  llm.state.script[after] = { toolCalls: [send('视觉已关闭'), finish] };
  pushGroupMsg(900001, '请求者', '评价一下我的头像', 30);
  await waitFor(() => llm.state.requests.length > after, 5000);
  assert.equal(offered(llm.state.requests[after]), false);
  await waitSessionDone('评价一下我的头像');
  console.log('PASS avatar requests are scoped to the triggering message, bind sender/@/exact reply, and deliver image parts only with vision enabled');
} finally {
  try { await env?.teardown(); } finally { https.request = request; dns.promises.lookup = lookup; }
}
