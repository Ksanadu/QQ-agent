import assert from 'node:assert/strict';
import { bootApp, waitFor, sleep } from './_harness.mjs';
const reply = messages => ({toolCalls:[{name:'send_message',args:{messages}},{name:'finish',args:{summary:'已回复'}}]});
const env = await bootApp({ config: { wakeDelayMs: 20, store: { contextSliderPos: 0 }, conversationListener: { enabled: true, idleMs: 6000, batchDelayMs: 80, wakeDelayMs: 700 } }, script: [
  {...reply('第一问的回答'), delayMs: 1000},
  {content: JSON.stringify({related:true, ids:[2], reason:'另一位群友跟进'})},
  reply('另一位群友的独立回复'),
  {delayMs: 1400, content: JSON.stringify({related:true, ids:[4], reason:'这次不会回传'})}
] });
try {
  const {app,llm,pushGroupMsg,waitSessionDone} = env, key='group:456';
  pushGroupMsg(777,'甲','@覆盖Bot 第一问',-601);
  await waitFor(()=>llm.state.requests.length===1);
  const firstId=app.orchestrator.activeRuns.get(key);
  assert.equal(app.orchestrator.listeners.tasks.has(key),false,'no classifier while the main run is active');
  pushGroupMsg(999,'乙','我也想知道补充要求',-602);
  await waitFor(()=>app.store.findByMid(key,-602));
  await sleep(200);
  assert.equal(llm.state.requests.length,1);
  assert.equal(app.orchestrator.activeRuns.get(key),firstId);
  assert.equal(app.orchestrator.listeners.tasks.has(key),false);
  assert.deepEqual(app.sessions.get(firstId).trigger.map(m=>m.mid),[-601]);
  const first=await waitSessionDone('第一问');
  assert.equal(first.status,'done');
  const listenerAfterFirst=app.sessions.get(first.listenerSessionId);
  assert.equal(listenerAfterFirst.parentSessionId,firstId);
  assert.ok(listenerAfterFirst.startedAt>=first.endedAt);
  await waitFor(()=>llm.state.requests.length>=2);
  const classification=JSON.parse(llm.state.requests[1].messages[1].content);
  assert.ok(classification.conversation.some(m=>m.text==='第一问的回答'));
  assert.ok(!classification.conversation.some(m=>m.messageId===-602));
  assert.deepEqual(classification.newMessages.map(m=>m.messageId),[-602]);
  await waitFor(()=>llm.state.requests.length===3);
  const followId=app.orchestrator.activeRuns.get(key);
  assert.notEqual(followId,firstId);
  assert.equal(app.orchestrator.listeners.tasks.has(key),false,'a follow-up main run also suspends classification');
  assert.ok(Date.now()<app.orchestrator.replyWindows.get(key).deadline);
  assert.deepEqual([...app.orchestrator.replyWindows.get(key).actors],['999']);
  const follow=await waitSessionDone('我也想知道补充要求');
  assert.equal(follow.status,'done');assert.equal(follow.followUpFromListener,true);
  assert.equal(env.onebotHttp.state.sends.length,2);
  pushGroupMsg(999,'乙','尚未完成的监听判定',-603);
  await waitFor(()=>llm.state.requests.length===4);
  const listener=app.orchestrator.listeners.tasks.get(key);
  assert.ok(listener);
  assert.equal(app.orchestrator.listeners.feed(key,app.store.findByMid(key,-603)),false);
  assert.equal(app.orchestrator.listeners.feed('group:789',app.store.findByMid(key,-603)),false);
  app.orchestrator.abortSession(listener.sessionId);
  assert.equal(app.orchestrator.listeners.tasks.size,0);
  await sleep(1500);
  assert.equal(llm.state.requests.length,4,'cancelled in-flight verdict cannot wake main');
  assert.equal(env.onebotHttp.state.sends.length,2);
  console.log('PASS listener starts after completed main runs, checks buffered candidates using the actual reply, and cancels cleanly');
} finally {await env.teardown();}
