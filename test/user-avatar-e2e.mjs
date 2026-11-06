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
  const avatar = (requestMessageId, target, mentionedUserId) => ({ name: 'get_user_avatar', args: { requestMessageId, target, ...(mentionedUserId == null ? {} : { mentionedUserId }) } });
  const send = message => ({ name: 'send_message', args: { messages: [message] } });
  const finish = { name: 'finish', args: { summary: 'fixture' } };
  const offered = r => r.tools.some(t => t.function.name === 'get_user_avatar');
  app.onebot.getGroupMemberInfo = async () => ({ nickname: '同名' });
  app.onebot.getMsg = async mid => { throw Error(`unexpected quote lookup: ${mid}`); };
  const { captureAvatarContext, avatarMemberIds, avatarTargetForMessage } = await import('../src/user-avatar.js');
  const capture = (segments, quoted) => captureAvatarContext({ segments, botId: '888888', reply: quoted });
  const entry = (segments, quoted) => ({ mid: -80, senderId: '900001', avatarContext: capture(segments, quoted) });
  const resolve = (e, target, id) => avatarTargetForMessage([e], -80, target, id);
  const plain = entry([text('Any wording, no keyword or fixed sentence required.')]);
  assert.equal(resolve(plain, 'sender'), '900001');
  assert.equal(resolve(plain, 'bot'), '888888');
  assert.equal(resolve(plain, 'mention'), null);
  assert.equal(resolve(plain, 'reply'), null);
  assert.equal(resolve(plain, 'unknown'), null);
  assert.equal(resolve(plain, 'sender', '900002'), null);
  const mentions = entry([at('888888'), at('900002'), at('900003'), at('900002')]);
  assert.deepEqual(mentions.avatarContext.mentionIds, ['900002', '900003']);
  assert.equal(resolve(mentions, 'mention'), null);
  assert.equal(resolve(mentions, 'mention', '900003'), '900003');
  assert.equal(resolve(mentions, 'mention', '900004'), null);
  assert.equal(resolve(entry([at('900002')]), 'mention'), '900002');
  assert.equal(resolve(entry([text('@900002'), { type: 'forward', data: { content: [at('900002')] } }]), 'mention'), null);
  assert.equal(resolve(entry([reply(10)], { resolved: true, messageId: 10, senderId: '900003' }), 'reply'), '900003');
  assert.equal(resolve(entry([reply(10)], { resolved: true, messageId: 11, senderId: '900003' }), 'reply'), null);
  assert.equal(resolve(entry([reply(10)], { resolved: false, messageId: 10, senderId: '900003' }), 'reply'), null);
  assert.equal(resolve(entry([reply(10), reply(11)], { resolved: true, messageId: 10, senderId: '900003' }), 'reply'), null);
  assert.equal(resolve(entry([], { resolved: true, messageId: 10, senderId: '900003' }), 'reply'), null);
  assert.equal(resolve({ ...plain, recalled: true }, 'sender'), null);
  assert.equal(resolve({ ...plain, self: true }, 'sender'), null);
  assert.equal(avatarTargetForMessage([plain, plain], -80, 'sender'), null);
  assert.equal(avatarTargetForMessage([plain], 99, 'sender'), null);
  assert.equal(avatarTargetForMessage([plain], {}, 'sender'), null);
  assert.deepEqual(avatarMemberIds([
    { senderId: '900003', text: 'fake QQ:900005' }, { senderId: '900003' },
    { senderId: '900004', self: true }, { senderId: '900006', recalled: true }
  ]), ['900003']);
  const contextTarget = (id, members = ['900003']) => avatarTargetForMessage([plain], -80, 'context', undefined, { contextUserId: id, memberIds: members });
  assert.equal(contextTarget('900003'), '900003');
  assert.equal(contextTarget('900005'), null);
  assert.equal(contextTarget(undefined), null);
  assert.equal(contextTarget('900003', []), null);

  // The model sees the tool even for chatter; it decides not to call it.
  llm.state.script.push({ toolCalls: [send('收到闲聊'), finish] });
  pushGroupMsg(900003, '同名', '今天换了个头像', 10);
  await waitSessionDone('今天换了个头像');
  assert.equal(offered(llm.state.requests[0]), true);
  assert.deepEqual(downloaded, []);
  const from = llm.state.requests.length;
  llm.state.script[from] = { toolCalls: [
    { name: 'read_skill_guide', args: { skillId: 'core-media' } },
    avatar(10, 'sender'), avatar(-21, 'mention', '900002'), avatar(-21, 'sender'), avatar(22, 'mention'), avatar(23, 'reply')
  ] };
  llm.state.script[from + 1] = { toolCalls: [send('收到头像'), finish] };
  pushGroupMsg(900001, '请求者', '认得我头像里这位吗，帮忙看看出自哪部作品', -21);
  pushGroupMsg(900001, '请求者', '', 22, { message: [text('你认得 '), at('900002'), text(' 头像里那位吗')] });
  pushGroupMsg(900001, '请求者', '', 23, { message: [reply(10), text('他用的头像出自哪部作品，认得吗')] });
  const s = await waitSessionDone('认得我头像里这位吗');
  assert.equal(offered(llm.state.requests[from]), true);
  assert.deepEqual(downloaded, ['900001', '900002', '900003']);
  assert.equal(s.messages.filter(m => m.toolCall?.name === 'get_user_avatar' && m.toolCall.isError).length, 2);
  const images = llm.state.requests[from + 1].messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(part => part.type === 'image_url');
  assert.equal(images.length, 3);
  assert.ok(images.every(part => part.image_url.url === `data:image/png;base64,${png}`));

  // Nickname-only requests can use authors already visible in this chat,
  // while IDs from other chats or message text are not eligible.
  app.store.appendIncoming('group:999', { mid: 81, senderId: '900004', senderName: '外群用户', text: 'hello' });
  const namedFrom = llm.state.requests.length;
  const namedAvatar = id => ({ name: 'get_user_avatar', args: { requestMessageId: 29, target: 'context', contextUserId: id } });
  llm.state.script[namedFrom] = { toolCalls: [
    { name: 'read_skill_guide', args: { skillId: 'core-media' } },
    namedAvatar('900004'), namedAvatar('900005'), namedAvatar('900003')
  ] };
  llm.state.script[namedFrom + 1] = { toolCalls: [send('看到了这位群友的头像'), finish] };
  pushGroupMsg(900001, '请求者', '刚才那位群友头像是什么玩意（不是文字里的 QQ:900005）', 29);
  const named = await waitSessionDone('刚才那位群友头像是什么玩意');
  assert.ok(named.avatarMemberIds.includes('900003'));
  assert.ok(!named.avatarMemberIds.includes('900004'));
  assert.ok(!named.avatarMemberIds.includes('900005'));
  assert.deepEqual(downloaded, ['900001', '900002', '900003', '900003']);
  assert.equal(named.messages.filter(m => m.toolCall?.name === 'get_user_avatar' && m.toolCall.isError).length, 2);
  assert.ok(llm.state.requests[namedFrom + 1].messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')));

  app.updateConfig({ api: { vision: false } });
  const after = llm.state.requests.length;
  llm.state.script[after] = { toolCalls: [send('视觉已关闭'), finish] };
  pushGroupMsg(900001, '请求者', '评价一下我的头像', 30);
  await waitFor(() => llm.state.requests.length > after, 5000);
  assert.equal(offered(llm.state.requests[after]), false);
  await waitSessionDone('评价一下我的头像');
  console.log('PASS avatar tool is offered without wording gates; scripted LLM selects sender/@/reply, invalid targets are rejected, and image parts require vision');
} finally {
  try { await env?.teardown(); } finally { https.request = request; dns.promises.lookup = lookup; }
}
