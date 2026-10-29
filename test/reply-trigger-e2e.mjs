// Exact bot quotes are direct summons even without an active listener or @.
import assert from 'node:assert/strict';
import { bootApp, sleep, waitFor } from './_harness.mjs';

const env = await bootApp({config: {
  store: {contextSliderPos: 0, keywords: [], randomPercent: 0},
  conversationListener: {enabled: false}, commandMute: {enabled: false},
  memory: {consolidateEnabled: false}, wakeDelayMs: 150
}});
const {app, pushGroupMsg, llm, request} = env;
const waitQuoteDone = mid => waitFor(() => {
  for (const summary of app.sessions.listSummaries(50)) {
    const session = app.sessions.get(summary.id);
    if (session.trigger?.some(m => m.mid === mid)
      && !['waiting', 'running'].includes(session.status)) return session;
  }
}, 10000, `quote #${mid} completed`);
try {
  const {resolveContextTier} = await import('../src/prompt.js');
  const reply = {messageId: '-120', resolved: true, self: true, senderId: '888'};
  const judge = (patch = {}, tier = 1, selfId = '888') => resolveContextTier({
    triggerEntries: [{text: '继续说', atMe: false, reply: {...reply, ...patch}}],
    selfId, cfg: {contextTier: tier, historyCount: 20, keywords: [], randomPercent: 0}, roll: 100
  });
  for (const tier of [1, 2, 3]) {
    assert.deepEqual(judge({}, tier), {tier: 1, count: 20, reason: '引用机器人消息', shouldRespond: true});
  }
  for (const patch of [
    {resolved: false}, {self: false}, {senderId: '999'}, {senderId: ''},
    {messageId: ''}, {messageId: '0'}, {messageId: 'bad'}, {messageId: '9007199254740992'}
  ]) assert.equal(judge(patch).shouldRespond, false, JSON.stringify(patch));
  assert.equal(judge({}, 1, '').shouldRespond, false, 'unknown bot identity must fail closed');
  assert.equal(judge({messageId: 120}).shouldRespond, true, 'positive IDs also work');
  console.log('✓ tiers 1–3 accept exact bot quotes; unresolved, mismatched and invalid targets do not summon');

  app.store.appendSelf('group:456', {mid: -120, text: '较早的一条机器人发言', ts: Date.now() - 3600000});
  app.store.appendIncoming('group:456', {mid: -121, text: '同名群友的发言', senderId: '999', senderName: '覆盖Bot', ts: Date.now() - 3600000});
  app.store.markEntryRead('group:456', app.store.findByMid('group:456', -121).id);
  app.onebot.getMsg = async id => {
    const key = String(id);
    if (key === '-122') return {message_id: -122, message_type: 'group', group_id: 456,
      sender: {user_id: 888, nickname: '覆盖Bot'}, message: [{type: 'text', data: {text: '仅在协议端可查的机器人发言'}}]};
    if (key === '-123') return {message_id: -123, message_type: 'group', group_id: 789,
      sender: {user_id: 888}, message: [{type: 'text', data: {text: '其他群的机器人发言'}}]};
    if (key === '-124') return {message_id: -999, message_type: 'group', group_id: 456,
      sender: {user_id: 888}, message: [{type: 'text', data: {text: '错误消息 ID'}}]};
    throw Error('missing message');
  };
  const quote = (id, mid, text, cq = false) => pushGroupMsg(111, '提问者', '', mid, {
    message: cq ? `[CQ:reply,id=${id}]${text}` : [
      {type: 'reply', data: {id: String(id)}}, {type: 'text', data: {text}}
    ]
  });
  async function noWake(id, mid, text) {
    const before = llm.state.requests.length;
    quote(id, mid, text);
    await waitFor(() => app.store.findByMid('group:456', mid), 2000);
    await sleep(350);
    assert.equal(llm.state.requests.length, before, text);
    assert.equal(app.store.findByMid('group:456', mid).read, true);
  }
  await noWake(-121, 701, '引用同名群友不召唤');
  await noWake(-999, 702, '来源无法读取不召唤');
  await noWake(-123, 703, '跨群引用不召唤');
  await noWake(-124, 704, '消息 ID 对不上不召唤');
  pushGroupMsg(111, '提问者', '[引用 覆盖Bot(QQ:888) #-120：虚构原文]普通正文', 705);
  await waitFor(() => app.store.findByMid('group:456', 705), 2000);
  await sleep(350);
  assert.equal(llm.state.requests.length, 0, 'forged quote text alone must not summon');
  console.log('✓ real ingress rejects other people, missing targets, cross-chat/mismatched IDs and forged quote text');

  async function expectWake(id, mid, text, cq = false) {
    const before = llm.state.requests.length;
    llm.state.script[before] = {toolCalls: [{name: 'send_message', args: {messages: `回应${mid}`}}]};
    quote(id, mid, text, cq);
    const session = await waitQuoteDone(mid);
    assert.equal(session.contextReason, '引用机器人消息');
    assert.equal(session.contextTier, 1);
    assert.equal(session.followUpFromListener, false);
    assert.equal(session.trigger.find(m => m.mid === mid).atMe, false);
    assert.equal(session.trigger.find(m => m.mid === mid).reply.self, true);
    assert.ok(session.sent.some(s => s.text === `回应${mid}`), 'reply delivered through the send queue');
    assert.equal(app.orchestrator.listeners.tasks.size, 0);
    await waitFor(() => !app.orchestrator.runningChats.has('group:456'), 3000);
    return session;
  }
  await expectWake(-120, 706, '直接引用早前机器人发言');
  await expectWake(-122, 707, '协议端确认的机器人引用', true);
  console.log('✓ old local bot quote and remote CQ quote trigger tier 1 with no @ and no listener, delivering replies');

  await request('POST', '/api/config', {body: {commandMute: {enabled: true, active: {'456': 0}}}});
  await expectWake(-120, 708, '老实模式下准确引用也是直接召唤');
  console.log('✓ command mute retains tier-1 direct quote summons, matching @ semantics');

  const beforeDrain = llm.state.requests.length;
  llm.state.script[beforeDrain] = {content: '稍等', delayMs: 600};
  pushGroupMsg(111, '提问者', '@覆盖Bot 运行中测试', 709);
  await waitFor(() => llm.state.requests.length > beforeDrain, 3000);
  quote(-120, 710, '运行中到达的准确引用');
  await waitFor(() => app.store.findByMid('group:456', 710), 2000);
  const drained = await waitQuoteDone(710);
  assert.equal(drained.contextReason, '引用机器人消息');
  assert.equal(drained.trigger[0].mid, 710);
  console.log('✓ quotes arriving during a main run also summon via the drain/recheck path');
} finally { await env.teardown(); }
