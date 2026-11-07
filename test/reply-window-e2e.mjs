import assert from 'node:assert/strict';
import { bootApp, waitFor, sleep } from './_harness.mjs';

const call = (name, args = {}) => ({ name, args });
const reply = messages => ({ toolCalls: [call('send_message', { messages }), call('finish', { summary: '已答复' })] });
const env = await bootApp({ config: {
  wakeDelayMs: 950, drainDelayMs: 200, sessionRetryAttempts: 0,
  conversationListener: { enabled: false }, store: { contextSliderPos: 0 }
} });
const { app, llm, pushGroupMsg, request, waitSessionDone } = env;
const key = 'group:456';
const messages = () => env.onebotHttp.state.sends;
const input = i => llm.state.requests[i].messages;
const entry = id => app.store.findByMid(key, id);
const active = () => app.orchestrator.activeRuns.get(key);
const activity = () => app.sessions.current.get(active())?.activity;
const start = (mid, text, sender = 777) => pushGroupMsg(sender, '提问者', '@覆盖Bot ' + text, mid);
const setting = body => request('POST', '/api/config', { body });

try {
  // Phase 1: read-only work can finish before the deadline; the same draft is
  // sent on time without asking the model again. Ignore the protocol timestamp.
  llm.state.script.push({ toolCalls: [call('get_chats')] }, reply('及时交付'));
  pushGroupMsg(777, '甲', '@覆盖Bot 提前查资料', 501, { time: 100 });
  await waitFor(() => llm.state.requests.length === 2);
  await waitFor(() => activity() === '等待回复窗口…');
  assert.equal(messages().length, 0);
  assert.ok(Date.now() < entry(501).receivedAt + 950, 'model and read tool ran within the send window');
  const first = await waitSessionDone('提前查资料');
  assert.equal(first.status, 'done');
  assert.ok(first.sent[0].sentAt >= entry(501).receivedAt + 950);
  assert.equal(llm.state.requests.length, 2, 'waiting does not consume a third model request');

  await setting({ wakeDelayMs: 500 });
  let step = llm.state.requests.length;
  llm.state.script[step] = { ...reply('慢模型直接发'), delayMs: 670 };
  start(502, '模型比窗口慢');
  const slow = await waitSessionDone('模型比窗口慢');
  assert.ok(slow.sent[0].sentAt - entry(502).receivedAt < 1070, 'never waits a second whole window after the model returns');
  await setting({ wakeDelayMs: 0 });
  llm.state.script[step + 1] = reply('零等待');
  start(503, '零毫秒配置');
  const zero = await waitSessionDone('零毫秒配置');
  assert.ok(zero.sent[0].sentAt - entry(503).receivedAt < 1000, 'zero does not turn into the 2000ms default');
  console.log('PASS Phase 1: model and read tools run before deadline; no early sends, second delay, or extra LLM call');

  // Phase 2: the old response cannot send, react, mutate, or finish. Slow
  // reference enrichment is reserved at receipt, and later photos cannot overtake it.
  await setting({ wakeDelayMs: 850 });
  step = llm.state.requests.length;
  llm.state.script[step] = { toolCalls: [
    call('send_message', { messages: '旧稿不能发送' }),
    call('react_message', { messageId: 510, emojiId: '76' }),
    call('memory_append', { userId: '900001', text: '旧决定不能写入' }),
    call('finish', { summary: '旧稿不能完结' })
  ] };
  llm.state.script[step + 1] = { toolCalls: [
    call('get_message_detail', { messageId: 9010 }),
    call('get_message_detail', { messageId: 513 }),
    call('read_skill_guide', { skillId: 'core-media' }),
    call('get_user_avatar', { requestMessageId: 512, target: 'mention', mentionedUserId: '900099' })
  ] };
  llm.state.script[step + 2] = reply('已按新图和新引用回答');
  const oldGetMsg = app.onebot.getMsg.bind(app.onebot);
  let releaseQuote, quoteStarted = false, fetchedAvatar;
  app.onebot.getMsg = async mid => {
    if (String(mid) !== '9010') return oldGetMsg(mid);
    quoteStarted = true;
    await new Promise(resolve => { releaseQuote = resolve; });
    return { message_id: 9010, message_type: 'group', group_id: 456, sender: { user_id: 900010 },
      message: [{ type: 'text', data: { text: '确切引用原文' } }] };
  };
  // The existing avatar e2e test covers binary transport; intercept only this
  // tool handler to inspect the structured allowlist it received.
  const { avatarTargetForMessage } = await import('../src/user-avatar.js');
  app.orchestrator.toolDefs = app.orchestrator.toolDefs.map(d => d.id !== 'get_user_avatar' ? d : {
    ...d, execute: async (ctx, args) => {
      fetchedAvatar = avatarTargetForMessage(ctx.triggerEntries, args.requestMessageId, args.target, args.mentionedUserId);
      return { content: '头像范围已检查' };
    }
  });
  start(510, '请看原稿', 900001);
  await waitFor(() => activity() === '等待回复窗口…');
  const id = active(), deadline = app.orchestrator.replyWindows.get(key).deadline;
  pushGroupMsg(900002, '路人', '其他人闲聊不插队', 511);
  await waitFor(() => entry(511));
  assert.equal(app.orchestrator.replyWindows.get(key).deadline, deadline);
  pushGroupMsg(900001, '甲', '', 512, { message: [
    { type: 'reply', data: { id: '9010' } }, { type: 'at', data: { qq: '900099' } },
    { type: 'text', data: { text: '刚才说错了，评价这条和他的头像' } }
  ] });
  await waitFor(() => quoteStarted);
  pushGroupMsg(900001, '甲', '', 513, { message: [{ type: 'image', data: { url: 'https://example.com/added.png' } }] });
  pushGroupMsg(900001, '甲', '最后看看人物是谁', 514);
  await sleep(Math.max(0, deadline - Date.now() + 50));
  assert.equal(messages().length, 3, 'blocked while the newly received quote is unresolved');
  assert.equal(llm.state.requests.length, step + 1, 'do not think on partial enrichment');
  releaseQuote();
  const updated = await waitSessionDone('请看原稿');
  assert.equal(updated.id, id);
  assert.deepEqual(updated.trigger.map(m => m.mid), [510, 512, 513, 514]);
  assert.equal(updated.trigger[2].media[0].kind, 'image');
  assert.equal(fetchedAvatar, '900099');
  assert.ok(updated.sent[0].sentAt >= entry(514).receivedAt + 850);
  assert.deepEqual(updated.sent.map(m => m.text), ['已按新图和新引用回答']);
  const supplemental = input(step + 1).find(m => typeof m.content === 'string' && m.content.startsWith('【本轮新增消息】')).content;
  assert.match(supplemental, /#512.*QQ:900001.*刚才说错了[\s\S]*#513.*图片[\s\S]*#514.*最后看看人物是谁/);
  assert.match(supplemental, /请求消息 #512 → 引用目标 #9010[\s\S]*确切引用原文/);
  assert.ok(!supplemental.includes('其他人闲聊'));
  const reads = updated.messages.filter(m => m.toolCall?.name === 'get_message_detail').map(m => m.toolCall);
  assert.equal(reads.length, 2); assert.ok(reads.every(m => !m.isError));
  assert.match(reads[0].result, /确切引用原文/);
  assert.match(reads[1].result, /图片/);
  const refusals = updated.messages.filter(m => m.toolCall?.isError);
  assert.ok(refusals.length >= 4);
  assert.ok(refusals.slice(0, 4).every(m => m.toolCall.result.includes('新增消息')));
  await waitFor(() => entry(511).read);
  console.log('PASS Phase 2: owner-only renewal, ordered media/quote/author enrichment, stale sends/reactions/writes/finish refused');

  // Already-sent text remains real, but cannot complete a later version.
  await setting({ wakeDelayMs: 30 });
  step = llm.state.requests.length;
  llm.state.script[step] = { toolCalls: [call('send_message', {messages:'已经交付的第一段'})] };
  llm.state.script[step + 1] = { ...reply('不得发出的中间稿'), delayMs: 300 };
  llm.state.script[step + 2] = reply('已答复新增要求');
  start(515, '首答后继续');
  await waitFor(() => llm.state.requests.length === step + 2);
  pushGroupMsg(777, '甲', '补充要求必须看到', 516);
  const continued = await waitSessionDone('首答后继续');
  assert.equal(continued.status, 'done');
  assert.deepEqual(continued.sent.map(m => m.text), ['已经交付的第一段','已答复新增要求']);

  // An external action already in progress keeps its real receipt. A repeated
  // call with the same arguments on the next version must not apply it twice.
  let unblockEffect, commits = 0;
  app.orchestrator.toolDefs = app.orchestrator.toolDefs.map(d => d.id !== 'memory_append' ? d : {
    ...d, execute: async () => {
      commits++;
      await new Promise(resolve => { unblockEffect = resolve; });
      return { content: '已实际写入一次' };
    }
  });
  const args = { userId: '900001', text: '已实际写入一次' };
  step = llm.state.requests.length;
  llm.state.script[step] = { toolCalls: [call('memory_append', args)] };
  llm.state.script[step + 1] = { toolCalls: [call('memory_append', {...args}), ...reply('保留已完成的操作').toolCalls] };
  start(517, '副作用已在执行');
  await waitFor(() => unblockEffect);
  pushGroupMsg(777, '甲', '另外补充，不要重复执行', 518);
  await waitFor(() => entry(518)?.read);
  unblockEffect();
  const once = await waitSessionDone('副作用已在执行');
  assert.equal(once.status, 'done'); assert.equal(commits, 1);
  assert.ok(once.messages.some(m => m.toolCall?.result.includes('未重复执行')));

  // A draft may get past the timer, then wait on the protocol preflight.
  // Check the version immediately before the actual HTTP submission as well.
  const prepare = app.onebot.deliveryVerifier.prepare.bind(app.onebot.deliveryVerifier);
  let releasePreflight;
  app.onebot.deliveryVerifier.prepare = async (action, ...args) => {
    if (!releasePreflight && action === 'send_group_msg') {
      await new Promise(resolve => { releasePreflight = resolve; });
    }
    return prepare(action, ...args);
  };
  step = llm.state.requests.length;
  llm.state.script[step] = reply('过了时间但协议未提交的旧稿');
  llm.state.script[step + 1] = reply('实际出站前读到了补充');
  start(519, '协议边界检查');
  await waitFor(() => releasePreflight);
  pushGroupMsg(777, '甲', '请不要发上一版', 525);
  await waitFor(() => entry(525)?.read);
  releasePreflight();
  const checked = await waitSessionDone('协议边界检查');
  assert.deepEqual(checked.sent.map(m => m.text), ['实际出站前读到了补充']);
  app.onebot.deliveryVerifier.prepare = prepare;

  // A pure @ in the same preflight stage renews the window without
  // discarding a still-valid draft or consuming another model round.
  await setting({ wakeDelayMs: 520 });
  let releaseNudge;
  app.onebot.deliveryVerifier.prepare = async (action, ...args) => {
    if (!releaseNudge && action === 'send_group_msg') {
      await new Promise(resolve => { releaseNudge = resolve; });
    }
    return prepare(action, ...args);
  };
  step = llm.state.requests.length;
  llm.state.script[step] = reply('仍使用原稿');
  start(526, '协议预检阶段催促');
  await waitFor(() => releaseNudge);
  pushGroupMsg(777, '甲', '', 527, { message: [{type:'at', data:{qq:'888'}}] });
  await waitFor(() => entry(527)?.nudgeForSessionId);
  releaseNudge();
  const nudged = await waitSessionDone('协议预检阶段催促');
  assert.equal(nudged.status,'done');
  assert.equal(llm.state.requests.length, step+1);
  assert.ok(nudged.sent[0].sentAt >= entry(527).receivedAt+520);
  app.onebot.deliveryVerifier.prepare = prepare;

  // Phase 3: waiting output is abortable, and exhaustion retains the last
  // input in the session without sending the outdated recovery draft.
  await setting({ wakeDelayMs: 950 });
  step = llm.state.requests.length;
  llm.state.script[step] = reply('中止后不得发送');
  start(520, '中止等待发送');
  await waitFor(() => activity() === '等待回复窗口…');
  const oldSendCount = messages().length;
  const cancelled = active();
  assert.equal((await request('POST', '/api/sessions/' + cancelled + '/abort', { body: {} })).status, 200);
  assert.equal((await waitSessionDone('中止等待发送')).status, 'aborted');
  await sleep(980);
  assert.equal(messages().length, oldSendCount);
  await setting({ wakeDelayMs: 450, api: {maxRounds:1} });
  step = llm.state.requests.length;
  llm.state.script[step] = { toolCalls: [call('get_chats')] };
  llm.state.script[step + 1] = { ...reply('用尽额度的旧稿'), delayMs: 400 };
  start(521, '预算耗尽');
  await waitFor(() => llm.state.requests.length === step + 2);
  pushGroupMsg(777, '甲', '最后补充不丢失', 522);
  const exhausted = await waitSessionDone('预算耗尽');
  assert.equal(exhausted.status,'error');
  assert.match(exhausted.error, /补充消息已保存/);
  assert.ok(exhausted.trigger.some(m => m.mid === 522));
  assert.deepEqual(exhausted.unansweredMessageIds, [522]);
  assert.equal(llm.state.requests.length, step + 2);
  assert.equal(messages().length, oldSendCount);
  console.log('PASS Phase 3 core: abort, no stale final delivery, no new tool budget, supplements retained');
} finally { await env.teardown(); }
