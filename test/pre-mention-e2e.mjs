import assert from 'node:assert/strict';
import { bootApp, waitFor, sleep } from './_harness.mjs';

const env = await bootApp({ config: {
  wakeDelayMs: 350, drainDelayMs: 200, sessionRetryAttempts: 0,
  store: { contextSliderPos: 0 }, memory: { consolidateEnabled: false },
  conversationListener: { enabled: false }
} });
const { app, llm, pushGroupMsg, request } = env;
const key = 'group:456';
const at = { type: 'at', data: { qq: '888' } };
const entry = mid => app.store.findByMid(key, mid);
const plain = (mid, text, user = 777, extra = {}) => pushGroupMsg(user, '提问者', text, mid, extra);
const pure = (mid, user = 777, extra = {}) => plain(mid, '', user, { message: [at], ...extra });
const reply = text => ({ toolCalls: [
  { name: 'send_message', args: { messages: text } }, { name: 'finish', args: { summary: '已答复' } }
] });
const sessionFor = mid => app.sessions.listSummaries(30).map(s => app.sessions.get(s.id))
  .find(s => s.trigger?.some(m => m.mid === mid));
const done = async id => {
  const session = await waitFor(() => {
    const s = app.sessions.get(id);
    return s && !['waiting', 'running'].includes(s.status) && s;
  });
  assert.equal(session.status, 'done', session.error || 'run must deliver successfully');
  return session;
};
const nextRun = async (mid, user = 777) => {
  const count = llm.state.requests.length;
  llm.state.script.push(reply('已答复本轮输入 ' + mid));
  pure(mid, user);
  await waitFor(() => llm.state.requests.length > count);
  return { id: sessionFor(mid).id, input: String(llm.state.requests[count].messages[1].content) };
};

try {
  plain(601, '先发的第一句');
  await waitFor(() => entry(601)?.read);
  plain(602, '旁人的闲聊', 778);
  plain(603, '先发的第二句');
  await waitFor(() => entry(603)?.read);
  await sleep(30);
  const first = await nextRun(604);
  assert.deepEqual(app.sessions.get(first.id).trigger.map(m => m.mid), [601, 603, 604],
    'recent same-author background must become current input before the bare mention');
  const inputStart = first.input.indexOf('【本轮输入】以下');
  const current = first.input.slice(inputStart);
  assert.match(current, /#601.*先发的第一句[\s\S]*#603.*先发的第二句[\s\S]*#604/);
  assert.ok(!current.includes('旁人的闲聊'));
  assert.ok(!first.input.slice(0, inputStart).includes('先发的第一句'));
  const window = app.orchestrator.replyWindows.get(key);
  assert.equal(window.deadline, entry(604).receivedAt + 350);
  assert.ok(Date.now() < window.deadline, 'the prelude does not delay starting the model');
  const firstDone = await done(first.id);
  assert.equal(firstDone.timing.receivedAt, entry(604).receivedAt, 'queue timing starts at the real summon');
  assert.ok(firstDone.sent[0].sentAt >= window.deadline);

  // Already handled input remains excluded even after the in-memory set is lost.
  const { ChatStore } = await import('../src/store.js');
  assert.equal(new ChatStore().findByMid(key, 601).handledInRun, true);
  app.orchestrator.handledEntries.clear();
  await request('POST', '/api/config', { body: { wakeDelayMs: 800 } });
  const repeated = await nextRun(605);
  assert.deepEqual(app.sessions.get(repeated.id).trigger.map(m => m.mid), [605]);
  await done(repeated.id);
  console.log('PASS text before @ becomes ordered current input; other speakers stay background; handled input is not replayed');

  await request('POST', '/api/config', { body: { wakeDelayMs: 0 } });
  plain(606, '零窗口前文', 780);
  await waitFor(() => entry(606));
  const zero = await nextRun(607, 780);
  assert.deepEqual(app.sessions.get(zero.id).trigger.map(m => m.mid), [607]);
  await done(zero.id);

  await request('POST', '/api/config', { body: { wakeDelayMs: 300 } });
  plain(608, '超过窗口的前文', 781);
  await waitFor(() => entry(608));
  entry(608).receivedAt = Date.now() - 500;
  const old = await nextRun(609, 781);
  assert.deepEqual(app.sessions.get(old.id).trigger.map(m => m.mid), [609]);
  await done(old.id);

  plain(610, '接收时间为准', 782, { time: 100 });
  await waitFor(() => entry(610));
  const received = await nextRun(611, 782);
  assert.deepEqual(app.sessions.get(received.id).trigger.map(m => m.mid), [610, 611]);
  await done(received.id);
  console.log('PASS zero/expired windows exclude old input; coarse or old QQ timestamps do not override receipt time');

  // Keep the real structured quote, image and avatar targets, not just text.
  const { avatarTargetForMessage } = await import('../src/user-avatar.js');
  let avatar;
  app.orchestrator.toolDefs = app.orchestrator.toolDefs.map(d => d.id !== 'get_user_avatar' ? d : {
    ...d, execute: async (ctx, args) => {
      avatar = avatarTargetForMessage(ctx.triggerEntries, args.requestMessageId, args.target, args.mentionedUserId);
      return { content: '头像目标已核对' };
    }
  });
  plain(612, '', 783, { message: [
    { type: 'reply', data: { id: '9010' } },
    { type: 'at', data: { qq: '900099' } },
    { type: 'image', data: { url: 'https://example.com/prelude.png' } },
    { type: 'text', data: { text: '评价这张图和他的QQ头像' } }
  ] });
  await waitFor(() => entry(612)?.read);
  llm.state.script.push({ toolCalls: [
    { name: 'read_skill_guide', args: { skillId: 'core-media' } },
    { name: 'get_message_detail', args: { messageId: 612 } },
    { name: 'get_message_detail', args: { messageId: 9010 } },
    { name: 'get_user_avatar', args: { requestMessageId: 612, target: 'mention', mentionedUserId: '900099' } }
  ] }, reply('图和引用已收到'));
  pure(613, 783);
  const mediaId = (await waitFor(() => sessionFor(613))).id;
  const media = await done(mediaId);
  assert.equal(media.status, 'done');
  assert.deepEqual(media.trigger.map(m => m.mid), [612, 613]);
  assert.equal(media.trigger[0].media[0].kind, 'image');
  assert.equal(media.trigger[0].reply.messageId, '9010');
  assert.equal(avatar, '900099');
  const reads = media.messages.filter(m => m.toolCall?.name === 'get_message_detail').map(m => m.toolCall);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(r => !r.isError));
  assert.match(reads[1].result, /被引用的原话/);

  plain(614, '已撤回的前文', 784);
  await waitFor(() => entry(614));
  env.onebotWs.push({ post_type: 'notice', notice_type: 'group_recall', group_id: 456,
    user_id: 784, operator_id: 784, message_id: 614, self_id: 888 });
  await waitFor(() => entry(614).recalled);
  const recalled = await nextRun(615, 784);
  assert.deepEqual(app.sessions.get(recalled.id).trigger.map(m => m.mid), [615]);
  await done(recalled.id);

  plain(616, '引用前的闲聊', 785);
  await waitFor(() => entry(616));
  const step = llm.state.requests.length;
  llm.state.script.push(reply('按明确引用回答'));
  pure(617, 785, { message: [{ type: 'reply', data: { id: '9010' } }, at] });
  await waitFor(() => llm.state.requests.length > step);
  const quotedId = sessionFor(617).id;
  assert.deepEqual(app.sessions.get(quotedId).trigger.map(m => m.mid), [617]);
  await done(quotedId);
  console.log('PASS pre-mention images/quotes/avatar targets reach real tools; recalls and explicit quoted summons keep their boundaries');

  // The next speaker's direct summon may be queued behind another run.
  await request('POST', '/api/config', { body: { wakeDelayMs: 200 } });
  const beforeQueued = llm.state.requests.length;
  llm.state.script.push({ ...reply('先处理甲'), delayMs: 100 }, reply('已读乙的前文'));
  plain(618, '', 900001, { message: [at, { type: 'text', data: { text: '正在处理甲的请求' } }] });
  await waitFor(() => llm.state.requests.length > beforeQueued);
  const ownerId = sessionFor(618).id;
  plain(619, '乙的排队前文', 786);
  await waitFor(() => entry(619));
  pure(620, 786);
  await waitFor(() => entry(620));
  await done(ownerId);
  await waitFor(() => llm.state.requests.length > beforeQueued + 1);
  const queuedId = sessionFor(620).id;
  const queued = await done(queuedId);
  assert.deepEqual(queued.trigger.map(m => m.mid), [619, 620]);
  assert.equal(queued.timing.receivedAt, entry(620).receivedAt);
  assert.deepEqual(app.sessions.get(ownerId).trigger.map(m => m.mid), [618]);
  await sleep(250);
  assert.equal(llm.state.requests.length, beforeQueued + 2, 'no duplicate wake for the claimed prelude');
  console.log('PASS queued bare @ also claims its own prelude without mixing into the running speaker or opening duplicate runs');
} finally { await env.teardown(); }
