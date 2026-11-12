import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Real orchestrator, store, tools and sender. Both external APIs are replaced
// at fetch; no local credentials, listener sockets or QQ traffic are needed.
const temp = fs.realpathSync(os.tmpdir());
const dir = fs.mkdtempSync(path.join(temp, 'qq-reply-lifecycle-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { OneBotClient } = await import('../src/onebot.js');
const { ChatStore } = await import('../src/store.js');
const { SendQueue } = await import('../src/sender.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { MemoryStore } = await import('../src/memory.js');
const { resolveMessageReply } = await import('../src/message-replies.js');
const { replyPreview } = await import('../src/chat-visibility.js');

const call = (name, args = {}) => ({ name, args });
const finish = () => call('finish', { summary: 'fixture' });
const reply = (messages) => [call('send_message', { messages }), finish()];
const ok = (data) => Response.json({ status: 'ok', retcode: 0, data });
const originalFetch = globalThis.fetch;
const modelHost = 'model.fixture.invalid', onebotHost = 'onebot.fixture.invalid';
let nextChat = 500, nextCall = 0;

async function until(condition, label) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const result = condition();
    if (result) return result;
    await sleep(5);
  }
  assert.fail('Timed out: ' + label);
}

function stall(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function fixture({ maxRounds = 12, wakeDelayMs = 0, configure = () => {}, protocol, otherFetch } = {}) {
  const chatId = String(++nextChat);
  const chatKey = 'group:' + chatId;
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.api, { baseUrl: 'http://' + modelHost + '/v1', apiKey: '', model: 'fixture-model', maxRounds });
  cfg.allow.groups = [chatId];
  cfg.store.contextSliderPos = 0;
  cfg.conversationListener.enabled = false;
  cfg.sessionRetryAttempts = 0;
  cfg.wakeDelayMs = wakeDelayMs;
  cfg.send.minGapMs = cfg.send.maxGapMs = 200;
  configure(cfg);
  setRuntimeConfig(cfg);

  const onebot = new OneBotClient({ httpUrl: 'http://' + onebotHost });
  onebot.selfInfo = { user_id: 8888, nickname: 'FixtureBot' };
  const store = new ChatStore();
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ onebot, store });
  const ended = [], requests = [], sends = [], steps = [], started = [];
  const o = new Orchestrator({ onebot, store, sessions, sender, memory: new MemoryStore(),
    emit(type, value) {
      if (type === 'session-end') ended.push(sessions.get(value.sessionId));
      if (type === 'session-start') started.push(value);
    } });
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === modelHost) {
      const index = requests.length;
      const body = JSON.parse(options.body);
      requests.push(body);
      let step = steps[index];
      assert.notEqual(step, undefined, 'Unexpected model call ' + index);
      if (typeof step === 'function') step = await step(body, options);
      if (step instanceof Response) return step;
      const message = Array.isArray(step)
        ? { role: 'assistant', content: null, tool_calls: step.map(({ name, args }) => ({
          id: 'c' + ++nextCall, type: 'function', function: { name, arguments: JSON.stringify(args) }
        })) }
        : { role: 'assistant', content: step };
      return Response.json({ model: cfg.api.model, choices: [{ message }] });
    }
    if (parsed.hostname === onebotHost) {
      const action = parsed.pathname.slice(1);
      const args = JSON.parse(options.body);
      if (action === 'send_group_msg') sends.push(args.message);
      const override = await protocol?.(action, args, options);
      if (override) return override;
      if (action === 'send_group_msg') return ok({ message_id: 1000 + sends.length });
      if (action === 'get_group_member_info') return ok({ shut_up_timestamp: 0 });
      if (action === 'get_group_info') return ok({ group_name: 'Fixture Group' });
      if (action === 'get_group_msg_history') return ok({ messages: [] });
      assert.fail('Unexpected OneBot call: ' + action);
    }
    if (otherFetch) return otherFetch(parsed, options);
    assert.fail('Unexpected fetch host: ' + parsed.hostname);
  };
  const append = (mid, text, extra = {}) => store.appendIncoming(chatKey, {
    mid, text, ts: Date.now(), senderId: '7777', senderName: 'Tester', ...extra
  });
  const receive = (mid, text, { atMe = false, ...extra } = {}) => {
    const m = append(mid, text, { ...extra, atMe });
    o.onIncoming(chatKey, m, m.receivedAt);
    return m;
  };
  const recall = mid => {
    assert.equal(store.markRecalled(chatKey, mid), true);
    o.onMessageRecalled(chatKey, mid);
  };
  const waitEnd = async (count = 1) => {
    await until(() => ended.length >= count, 'session finished');
    return ended.at(-1);
  };
  const sentTexts = () => sends.map(segments => segments.filter(s => s.type === 'text').map(s => s.data.text).join(''));
  return { onebot, o, store, sender, sessions, chatKey, chatId, cfg, started, ended, steps, requests, sends, sentTexts,
    append, receive, recall, waitEnd };
}

const phases = process.argv.slice(2);
const run = n => !phases.length || phases.includes(String(n));
try {
  if (run(1)) {
    // More than three supersessions must neither consume tool rounds nor
    // activate the consecutive-failure fallback. Include both result shapes.
    {
      const f = fixture();
      const resume = [];
      for (let i = 0; i < 4; i++) f.steps.push(() => new Promise(resolve => { resume[i] = resolve; }));
      f.steps.push(reply('只发最终稿'));
      f.receive(101, '初始问题', { atMe: true });
      for (let i = 0; i < 4; i++) {
        const resolve = await until(() => resume[i], 'model round ' + i);
        f.receive(102 + i, '补充 ' + i);
        resolve(i % 2 ? reply('旧稿 ' + i) : '旧正文 ' + i);
      }
      const session = await f.waitEnd();
      assert.equal(session.status, 'done');
      assert.equal(session.toolRoundsUsed, 1);
      assert.deepEqual(f.sentTexts(), ['只发最终稿']);
      assert.ok(f.requests.every(r => r.tools.some(t => t.function.name === 'get_chats')));
    }
    {
      const f = fixture({ maxRounds: 1 });
      let resume;
      f.steps.push([call('get_chats')], () => new Promise(resolve => { resume = resolve; }), reply('后续交付'));
      f.receive(201, '已用额度', { atMe: true });
      await until(() => resume, 'restricted final round');
      assert.deepEqual(f.requests[1].tools.map(t => t.function.name), ['send_message']);
      f.receive(202, '额度用尽之后追加');
      resume(reply('额度用尽的旧稿'));
      const followup = await f.waitEnd(2);
      assert.equal(f.ended[0].status, 'noreply');
      assert.deepEqual(f.ended[0].unansweredMessageIds, [202]);
      assert.equal(followup.status, 'done');
      assert.equal(followup.continuedFrom, f.ended[0].id);
      assert.deepEqual(followup.trigger.map(m => m.mid), [202]);
      assert.deepEqual(f.sentTexts(), ['后续交付']);
    }
    {
      const f = fixture();
      let respond;
      f.steps.push(() => new Promise(resolve => { respond = resolve; }), reply('读到晚到的引用补充'));
      f.receive(211, '等待补充入库的请求', { atMe: true });
      await until(() => respond, 'initial request waiting');
      const reservation = f.o.reserveIncoming(f.chatKey, '7777', Date.now(), false);
      respond(new Response('non-retryable model error', { status: 400 }));
      const initial = await f.waitEnd();
      assert.equal(initial.status, 'noreply');
      await until(() => f.o.activeRuns.get(f.chatKey) && f.o.activeRuns.get(f.chatKey) !== initial.id, 'new run owns pending enrichment');
      assert.equal(f.requests.length, 1, 'do not ask the model until enrichment completes');
      const supplement = f.append(212, '引用补充原文已准备好');
      f.o.onIncoming(f.chatKey, supplement, supplement.receivedAt, reservation);
      reservation.release();
      const session = await f.waitEnd(2);
      assert.equal(session.status, 'done');
      assert.equal(session.continuedFrom, initial.id);
      assert.deepEqual(session.trigger.map(m => m.mid), [212]);
      assert.ok(JSON.stringify(f.requests.at(-1).messages).includes('引用补充原文已准备好'));
    }
    {
      const f = fixture({ configure(cfg) { cfg.drainDelayMs = 200; } });
      f.steps.push(reply('回答新召唤'), reply('回答排队中的旧召唤'));
      f.append(241, '旧积压普通闲聊', { senderId: '6666', atMe: false });
      f.append(242, '旧积压明确召唤', { senderId: '9999', atMe: true });
      f.receive(243, '新的明确召唤', { atMe: true });
      const first = await f.waitEnd();
      assert.deepEqual(first.trigger.map(m => m.mid), [243]);
      assert.ok(f.store.findByMid(f.chatKey, 241).read, 'old chatter is consumed as history');
      const next = await f.waitEnd(2);
      assert.deepEqual(next.trigger.map(m => m.mid), [242], 'old direct summon keeps its own queue entry');
      assert.deepEqual(f.sentTexts(), ['回答新召唤', '回答排队中的旧召唤']);
    }
    {
      const f = fixture();
      let signal;
      f.steps.push((_, options) => { signal = options.signal; return stall(signal); });
      f.receive(301, '撤回唯一问题', { atMe: true });
      await until(() => signal, 'in-flight model call');
      f.recall(301);
      const session = await f.waitEnd();
      assert.equal(signal.aborted, true);
      assert.equal(session.status, 'noreply');
      assert.deepEqual(f.sentTexts(), []);
      assert.equal(f.requests.length, 1);
      // The recall may reach the app before asynchronous incoming enrichment.
      f.recall(302);
      const late = f.receive(302, '先撤回后入库', { atMe: true });
      assert.ok(late.recalled && late.read);
      assert.equal(new ChatStore().isRecalled(f.chatKey, 302), true);
    }
    {
      const f = fixture();
      const original = '撤回后不能再注入的原文';
      const archived = f.append(-401, original);
      f.store.markEntryRead(f.chatKey, archived.id);
      const quote = { resolved: true, messageId: '-401', text: original, sender: 'Tester', senderId: '7777', media: [] };
      let signal;
      f.steps.push((_, options) => { signal = options.signal; return stall(signal); },
        [call('get_message_detail', { messageId: -401 }), call('search_chat_history', { query: original })],
        reply('原文已撤回，按补充回答'));
      f.receive(402, replyPreview('-401', quote) + ' 请评价这条', { atMe: true, reply: quote });
      await until(() => signal, 'first quote prompt');
      assert.ok(JSON.stringify(f.requests[0].messages).includes(original));
      f.receive(403, '我补充一个不依赖原文的问题');
      f.recall(-401);
      const session = await f.waitEnd();
      assert.equal(signal.aborted, true);
      assert.equal(session.status, 'done');
      assert.match(JSON.stringify(f.requests[1].messages), /引用目标 #-401 已撤回/);
      assert.ok(!JSON.stringify(f.requests[1].messages).includes(original));
      const tools = f.requests[2].messages.filter(m => m.role === 'tool');
      assert.match(tools[0].content, /找不到消息/);
      assert.equal(JSON.parse(tools[1].content).total, 0);
      assert.equal(f.store.findByMid(f.chatKey, -401).text, original, 'operator archive is preserved');
      assert.equal((await resolveMessageReply({ messageId: -401, chatKey: f.chatKey, store: f.store, onebot: f.onebot })).resolved, false);
      assert.deepEqual(f.sentTexts(), ['原文已撤回，按补充回答']);
    }
    console.log('PASS 1: repeated supersession, quota handoff, recall cancellation, fresh quote/context/tools and retained archive');
  }
  if (run(2)) {
    {
      let secondAttempts = 0;
      const f = fixture({ configure(cfg) { cfg.send.dedupeWindowMs = 0; }, protocol(action, args) {
        if (action !== 'send_group_msg') return;
        if (args.message.at(-1).data.text === '分段一') return ok({ message_id: -440 });
        if (++secondAttempts === 1) return Response.json({ status: 'failed', retcode: 100, wording: 'send rejected: result=241' });
        return ok({ message_id: -441 });
      } });
      f.steps.push(reply(['分段一', '分段二']), reply('无关文字不能补完旧分段'),
        [call('send_message', { retryFailed: true }), finish()]);
      f.receive(501, '拆分交付', { atMe: true });
      const session = await f.waitEnd();
      assert.equal(session.status, 'done');
      assert.equal(session.toolRoundsUsed, 1, 'partial and rejected tool calls do not consume quota');
      assert.deepEqual(session.sent.map(m => m.messageId), [-440, -441]);
      assert.deepEqual(f.sentTexts(), ['分段一', '分段二', '分段二']);
      const failures = session.messages.filter(m => m.toolCall?.isError);
      assert.equal(JSON.parse(failures[0].toolCall.result).failed[0].index, 1);
      assert.match(failures[1].toolCall.result, /retryFailed/);
      assert.match(failures[2].toolCall.result, /retryFailed/);
    }
    {
      const f = fixture({ protocol(action, args) {
        if (action !== 'send_group_msg') return;
        f.onebot.deliveryVerifier.observe({ post_type: 'message_sent', message_type: 'group', group_id: args.group_id,
          message_id: -543, user_id: 8888, time: Math.floor(Date.now() / 1000), message: args.message });
        return ok({});
      } });
      f.steps.push(reply('缺 ID 但收到真实回显'));
      f.receive(502, '验证聊天回执', { atMe: true });
      const session = await f.waitEnd();
      assert.equal(session.status, 'done');
      assert.equal(session.sent[0].messageId, -543);
      assert.deepEqual(f.sentTexts(), ['缺 ID 但收到真实回显']);
    }
    for (const response of [() => ok({ message_id: 0 }), () => Response.json({ status: 'ok', retcode: 100, data: { message_id: 999 } })]) {
      const f = fixture({ configure(cfg) { cfg.sessionRetryAttempts = 2; },
        protocol: action => action === 'send_group_msg' && response() });
      f.steps.push(reply(['未确认文字', '后续分段不提交']));
      f.receive(503, '未确认送达', { atMe: true });
      const session = await f.waitEnd();
      assert.equal(session.status, 'error');
      assert.equal(session.completion.delivered, false);
      assert.equal(session.deliveryUnconfirmed, true);
      assert.match(session.error, /未能确认/);
      assert.equal(session.sent.length, 0);
      assert.deepEqual(f.sentTexts(), ['未确认文字']);
      assert.equal(f.requests.length, 1);
      assert.match(f.o.retrySession(session.id).reason, /未确认/);
      assert.equal(f.sessions.listSummaries(20).find(s => s.id === session.id).retryAllowed, false);
    }
    {
      const { skillManager } = await import('../src/skills/manager.js');
      const { registerTool, unregisterTool } = await import('../src/tool-registry.js');
      const { normalizeManifest } = await import('../src/skills/manifest.js');
      const tts = await import('../skills/tts-say/index.js');
      const skillDir = new URL('../skills/tts-say/', import.meta.url);
      const { manifest } = normalizeManifest(JSON.parse(fs.readFileSync(new URL('skill.json', skillDir), 'utf8')));
      assert.ok(skillManager.register({ manifest, hooks: tts.hooks }).ok);
      const voice = async (ctx) => {
        await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: 'base64://YXVkaW8=' } }], { label: '[语音]' });
        return { content: 'status: ok\n已发出语音。' };
      };
      let voiceImplementation = voice;
      const voiceId = 'tts-say__say';
      registerTool({ id: voiceId, name: 'fixture voice synthesis', category: 'media',
        description: 'fixture voice synthesis', parameters: { type: 'object' }, execute: (...args) => voiceImplementation(...args) });
      try {
        const f = fixture();
        f.steps.push([call('send_message', { messages: '不要先打字' }), call('tts-say__say', { text: '语音正文' }), finish()],
          reply('语音发好了'));
        f.receive(504, '请用语音回复', { atMe: true });
        const session = await f.waitEnd();
        assert.equal(session.status, 'done');
        assert.deepEqual(session.sent.map(m => m.type), ['record', 'text']);
        assert.equal(session.sent[1].text, '语音发好了');
        assert.equal(session.messages.filter(m => m.toolCall?.name === 'finish')[0].toolCall.isError, true);

        const dry = fixture();
        voiceImplementation = () => ({ content: 'status: dry-run\n未发送' });
        dry.steps.push([call('tts-say__say', { text: '演练正文' })], reply('语音演练未发送'));
        dry.receive(505, '用语音说', { atMe: true });
        assert.equal((await dry.waitEnd()).status, 'done');
        assert.deepEqual(dry.sentTexts(), ['语音演练未发送']);

        const cross = fixture({ configure(cfg) { cfg.tools.crossChatSend = true; cfg.allow.private = ['7777']; } });
        cross.steps.push([call('send_to', { targetChatKey: 'private:7777', messages: '不要改为跨会话文字' }), ...reply('跨会话语音未开启')]);
        cross.receive(506, '发语音给其他群', { atMe: true });
        const disabled = await cross.waitEnd();
        assert.equal(disabled.status, 'done');
        assert.equal(disabled.messages.find(m => m.toolCall?.name === 'send_to').toolCall.isError, true);
        assert.deepEqual(cross.sentTexts(), ['跨会话语音未开启']);
      } finally { unregisterTool(voiceId); skillManager.unregister('tts-say'); }
    }
    console.log('PASS 2: partial repair, independent receipt recovery, no resend on uncertainty, voice and text completion');
  }
  if (run(3)) {
    {
      let searchSignal;
      const f = fixture({
        configure(cfg) {
          cfg.webSearch.provider = 'antigravity';
          cfg.webSearch.antigravity.providerId = 'fixture-search';
          cfg.webSearch.antigravity.model = 'gemini-fixture';
          cfg.providers = [{ id: 'fixture-search', baseURL: 'http://search.fixture.invalid' }];
        },
        otherFetch(url, options) {
          assert.equal(url.hostname, 'search.fixture.invalid');
          assert.match(url.pathname, /streamGenerateContent/);
          searchSignal = options.signal;
          return stall(searchSignal);
        }
      });
      f.steps.push([call('web_search', { query: '测试原生搜索中止' })], reply('同群下一次请求正常'));
      f.receive(601, '中止慢搜索', { atMe: true });
      await until(() => searchSignal, 'Antigravity fetch');
      assert.deepEqual(f.o.abortSession(f.o.activeRuns.get(f.chatKey)), { ok: true });
      assert.equal((await f.waitEnd()).status, 'aborted');
      assert.equal(searchSignal.aborted, true);
      assert.equal(f.o.runningChats.has(f.chatKey), false);
      assert.deepEqual(f.sentTexts(), []);
      f.receive(602, '新问题仍能回复', { atMe: true });
      assert.equal((await f.waitEnd(2)).status, 'done');
      assert.deepEqual(f.sentTexts(), ['同群下一次请求正常']);
    }
    {
      let snapshotSignal;
      const f = fixture({ protocol(action, _, options) {
        if (action !== 'get_group_msg_history') return;
        snapshotSignal = options.signal;
        return stall(snapshotSignal);
      } });
      f.steps.push(reply('尚未提交的稿子'));
      f.receive(603, '中止发送预检', { atMe: true });
      await until(() => snapshotSignal, 'protocol pre-send snapshot');
      f.o.abortSession(f.o.activeRuns.get(f.chatKey));
      assert.equal((await f.waitEnd()).status, 'aborted');
      assert.equal(snapshotSignal.aborted, true);
      assert.deepEqual(f.sentTexts(), []);
    }
    {
      const f = fixture();
      let resume;
      f.o.toolDefs = f.o.toolDefs.map(d => d.id === 'get_message_detail' ? {
        ...d, execute: () => new Promise(resolve => { resume = resolve; })
      } : d);
      f.steps.push([call('get_message_detail', { messageId: 608 })]);
      f.receive(608, '中止旧版只读适配器', { atMe: true });
      await until(() => resume, 'adapter without signal support');
      f.o.abortSession(f.o.activeRuns.get(f.chatKey));
      assert.equal((await f.waitEnd()).status, 'aborted');
      resume({ content: '迟到的工具结果' });
      await sleep(10);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.sentTexts(), []);
    }
    {
      let sendSignal, receipt;
      const f = fixture({ protocol(action, _, options) {
        if (action !== 'send_group_msg') return;
        sendSignal = options.signal;
        return new Promise(resolve => { receipt = resolve; });
      } });
      f.steps.push([call('send_message', { messages: '已经提交的一条' }), call('react_message', { messageId: 604, emojiId: '76' })]);
      f.receive(604, '中止已提交发送', { atMe: true });
      await until(() => receipt, 'outbound request submitted');
      const id = f.o.activeRuns.get(f.chatKey);
      f.o.abortSession(id);
      assert.equal(sendSignal.aborted, false, 'once submitted, preserve verification');
      assert.equal(f.sessions.current.get(id).activity, '正在中止…');
      receipt(ok({ message_id: 544 }));
      const session = await f.waitEnd();
      assert.equal(session.status, 'aborted');
      assert.deepEqual(session.sent.map(m => m.messageId), [544]);
      assert.deepEqual(f.sentTexts(), ['已经提交的一条']);
    }
    {
      const f = fixture({ configure(cfg) {
        cfg.sessionTimeoutMs = 240;
        cfg.sessionRetryAttempts = 2;
        cfg.api.fallbackModels = [{ model: 'fixture-fallback' }];
      } });
      let backupSignal;
      f.steps.push(() => new Response('unauthorized', { status: 401 }),
        (_, options) => { backupSignal = options.signal; return stall(backupSignal); });
      f.receive(605, '整轮用时限制', { atMe: true });
      const session = await f.waitEnd();
      assert.equal(session.status, 'error');
      assert.match(session.error, /总用时上限/);
      assert.equal(backupSignal?.aborted, true);
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.sentTexts(), []);
    }
    {
      const f = fixture({ configure(cfg) { cfg.sessionTimeoutMs = 150; cfg.sessionRetryAttempts = 2; } });
      f.steps.push(() => new Response('temporary error', { status: 503 }));
      f.receive(606, '中断模型退避', { atMe: true });
      const session = await f.waitEnd();
      assert.match(session.error, /总用时上限/);
      assert.equal(f.requests.length, 1, 'cannot retry after the shared deadline');
    }
    for (const order of ['proactive-first', 'direct-running', 'direct-finished']) {
      const checks = [];
      let complete;
      const f = fixture({ protocol(action) {
        if (action === 'get_group_member_info') return new Promise(resolve => checks.push(resolve));
      } });
      f.steps.push(() => new Promise(resolve => { complete = resolve; }));
      const proactive = f.o.wake(f.chatKey, { proactive: true });
      await until(() => checks.length === 1, 'first mute check');
      f.receive(607, '直接召唤优先', { atMe: true });
      await until(() => checks.length === 2, 'direct mute check');
      const unmuted = () => ok({ shut_up_timestamp: 0 });
      if (order === 'proactive-first') {
        checks[0](unmuted());
        await proactive;
        assert.equal(f.requests.length, 0);
      }
      checks[1](unmuted());
      await until(() => complete, 'direct model request');
      if (order === 'direct-running') { checks[0](unmuted()); await proactive; }
      complete(reply('只回答直接召唤'));
      assert.equal((await f.waitEnd()).status, 'done');
      if (order === 'direct-finished') { checks[0](unmuted()); await proactive; }
      assert.equal(f.requests.length, 1, order);
      assert.deepEqual(f.sentTexts(), ['只回答直接召唤'], order);
      assert.equal(f.o.activeRuns.size, 0, order);
    }
    {
      const bangumi = await import('../skills/bangumi-lookup/index.js');
      const tools = new Map();
      const controller = new AbortController();
      let fetchSignal, calls = 0;
      bangumi.internals.internals_resetBases();
      bangumi.setup({
        config: () => ({ requestIntervalMs: 0 }), log() {},
        registerTool: tool => tools.set(tool.id, tool),
        fetch: (_, options) => { calls++; fetchSignal = options.signal; return stall(fetchSignal); }
      });
      const pending = tools.get('search').execute({ signal: controller.signal }, { keyword: 'abort-bangumi-fixture' });
      await until(() => fetchSignal, 'Bangumi request');
      controller.abort(new Error('会话已被用户中止'));
      assert.equal((await pending).isError, true);
      assert.equal(fetchSignal.aborted, true);
      assert.equal(calls, 1, 'cancellation cannot fall back to legacy API or another mirror');
    }
    console.log('PASS 3: native search cancellation, send boundary, shared retry deadline and direct-wake admission');
  }
} finally {
  globalThis.fetch = originalFetch;
  const resolved = fs.realpathSync(dir);
  assert.equal(path.dirname(resolved), temp);
  assert.ok(path.basename(resolved).startsWith('qq-reply-lifecycle-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
