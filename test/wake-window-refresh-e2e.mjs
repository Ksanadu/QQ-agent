import assert from 'node:assert/strict';
import { bootApp, waitFor, sleep } from './_harness.mjs';
const reply = messages => ({ toolCalls: [
  { name: 'send_message', args: { messages } }, { name: 'finish', args: { summary: '已回复' } }
] });
const env = await bootApp({ config: {
  wakeDelayMs: 1500, drainDelayMs: 200, store: { contextSliderPos: 0 },
  conversationListener: { enabled: true, idleMs: 15000, batchDelayMs: 700, wakeDelayMs: 550 }
}, script: [reply('你还想比较什么？')] });
const { app, pushGroupMsg, llm, waitSessionDone } = env;
const key = 'group:456';
const arrived = mid => waitFor(() => app.store.findByMid(key, mid));
const active = () => app.orchestrator.activeRuns.get(key);
try {
  pushGroupMsg(777,'甲','@覆盖Bot 开启监听',810);
  await waitSessionDone('开启监听');
  pushGroupMsg(777,'甲','那光线呢',811);
  const entry = await arrived(811);
  llm.state.script[1] = { content: JSON.stringify({ related: true, ids: [entry.id], reason: '承接机器人问题' }) };
  llm.state.script[2] = reply('第一份分析不应发出');
  llm.state.script[3] = reply('补充的光线和阴影要求已收到');
  await sleep(230);
  pushGroupMsg(999,'乙','不相关旁话',812); await arrived(812);
  await sleep(200);
  assert.equal(llm.state.requests.length, 1, 'classifier still batches before deciding');
  await waitFor(() => llm.state.requests.length >= 3);
  const follow = active();
  assert.ok(follow);
  const win = app.orchestrator.replyWindows.get(key), deadline = win.deadline;
  assert.ok(Date.now() < deadline, 'main LLM starts immediately after classification, before post-judgment deadline');
  assert.equal(win.delayMs, 550, 'listener uses its configured delay, not the 1500ms main delay');
  assert.equal(env.onebotHttp.state.sends.length, 1);
  assert.deepEqual(JSON.parse(llm.state.requests[1].messages[1].content).newMessages.map(m => m.id),
    [entry.id, app.store.findByMid(key,812).id]);
  assert.deepEqual([...win.actors], ['777']);
  pushGroupMsg(777,'甲','也比较阴影',814); await arrived(814);
  assert.equal(active(), follow);
  const renewed = win.deadline;
  assert.ok(renewed > deadline);
  const finished = await waitSessionDone('那光线呢');
  assert.equal(finished.id, follow); assert.equal(finished.followUpFromListener, true);
  assert.deepEqual(finished.trigger.map(m => m.mid), [811,814]);
  assert.deepEqual(finished.sent.map(m => m.text), ['补充的光线和阴影要求已收到']);
  assert.ok(finished.sent[0].sentAt >= renewed);
  assert.ok(finished.sent[0].sentAt < renewed + 800, 'no second full reply window');
  assert.equal(llm.state.requests.length, 4);
  console.log('PASS listener preserves pre-batch, starts main model before configured post-judgment window, merges only approved owner');
} finally { await env.teardown(); }
