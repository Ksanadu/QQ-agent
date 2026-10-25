import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';
const env = await bootApp({ config: { wakeDelayMs: 30 }, script: [
  { toolCalls: [{ name: 'finish', args: { reason: '听懂' } }] },
  { toolCalls: [{ name: 'finish', args: { reason: '识别失败不编造' } }] }
] });
try {
  const { app, pushGroupMsg, llm } = env; const calls = [];
  const original = app.onebot.call.bind(app.onebot); let available = true;
  app.onebot.call = async (action, args, timeout) => {
    if (action === 'fetch_ptt_text') { assert.equal(timeout, 25000); calls.push({ action, args }); if (!available) throw Error('QQ识别暂不可用'); return { text: '这是 QQ 原生语音识别的真实文字' }; }
    return original(action, args, timeout);
  };
  const message = [{ type: 'at', data: { qq: '888' } }, { type: 'record', data: { file: 'voice.amr' } }];
  pushGroupMsg(777, '甲', '', -321, { message });
  await waitFor(() => llm.state.requests.length === 1);
  assert.match(app.store.findByMid('group:456', -321).text, /语音转文字.*QQ 原生/);
  assert.equal(app.store.findByMid('group:456', -321).media[0].kind, 'record');
  assert.match(llm.state.requests[0].messages.find(m => m.role === 'user').content, /真实文字/);
  const { transcribeQQVoice } = await import('../src/qq-speech.js');
  assert.match(await transcribeQQVoice(app.onebot, -321), /真实文字/); assert.equal(calls.length, 1);
  await assert.rejects(transcribeQQVoice(app.onebot, 'file:///private'), /ID/);
  await waitFor(() => app.orchestrator.runningChats.size === 0);
  available = false;
  pushGroupMsg(777, '甲', '', -322, { message });
  await waitFor(() => llm.state.requests.length === 2);
  assert.match(app.store.findByMid('group:456', -322).text, /\[语音\]/);
  const { buildToolDefs } = await import('../src/tools.js');
  const tool = buildToolDefs().find(t => t.id === 'transcribe_voice_message');
  const ctx = { chatKey: 'group:456', store: app.store, onebot: app.onebot };
  assert.equal((await tool.execute(ctx, { messageId: -322 })).isError, true);
  available = true;
  assert.match((await tool.execute(ctx, { messageId: -322 })).content, /真实文字/);
  assert.equal((await tool.execute({ ...ctx, chatKey: 'group:789' }, { messageId: -321 })).isError, true);
  assert.ok(calls.every(c => c.action === 'fetch_ptt_text' && c.args.message_id < 0));
  console.log('PASS Phase 2: actual incoming QQ STT before prompt, signed IDs, cached reads, failure placeholder, retry and chat isolation; no audio download or local ASR');
} finally { await env.teardown(); }
