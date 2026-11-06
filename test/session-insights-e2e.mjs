import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp } from './_harness.mjs';

const summary = '先确认可用信息，再作简短答复。';
const env = await bootApp({ config: { wakeDelayMs: 30, store: { contextSliderPos: 100, peakSchedule: { enabled: false } } }, script: [
  { reasoning: summary, toolCalls: [{ name: 'get_active_members', args: {} }] },
  { toolCalls: [{ name: 'send_message', args: { messages: '你好，收到。' } }, { name: 'finish', args: { summary: '已回复' } }] }
] });
try {
  env.pushGroupMsg(900001, '甲', '你好，打个招呼', -910);
  const s = await env.waitSessionDone('你好，打个招呼');
  const assistant = s.messages.filter(m => m.role === 'assistant');
  assert.equal(assistant[0].reasoningSummary, summary);
  assert.equal(assistant[1].reasoningSummary, undefined);
  assert.ok(!JSON.stringify(env.llm.state.requests[1].messages).includes(summary), 'display metadata must not enter the next LLM request');
  assert.equal(env.onebotHttp.state.sends.length, 1);
  assert.ok(!JSON.stringify(env.onebotHttp.state.sends).includes(summary), 'summary is not sent to QQ');
  const disk = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'sessions', `${s.id}.json`), 'utf8'));
  assert.equal(disk.messages.find(m => m.role === 'assistant').reasoningSummary, summary);
  const api = await env.request('GET', `/api/sessions/${s.id}`);
  assert.equal(api.data.messages.find(m => m.role === 'assistant').reasoningSummary, summary);
  console.log('PASS returned reasoning survives session/API storage without resending it to the model or QQ');
} finally { await env.teardown(); }
