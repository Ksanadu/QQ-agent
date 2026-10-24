import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-comfy-json-'));
const { updateConfig } = await import('../src/config.js');
const { preparePrompt } = await import('../skills/comfy-draw/index.js');
const { chatCompletion } = await import('../src/llm.js');
updateConfig({ api: { baseUrl: 'http://127.0.0.1:9/v1', model: 'gemini-3.8-flash-low', apiKey: 'test-only' } });
const realFetch = globalThis.fetch;
let script = [], calls = [];
globalThis.fetch = async (_url, options) => {
  calls.push(JSON.parse(options.body));
  const step = script.shift();
  assert.ok(step, 'No unbounded retries');
  return new Response(JSON.stringify(step.status ? { error: { message: 'mock upstream unavailable' } } : {
    choices: [{ message: { role: 'assistant', content: step.content ?? null, refusal: step.refusal }, finish_reason: step.finishReason || 'stop' }]
  }), { status: step.status || 200, headers: { 'content-type': 'application/json' } });
};
const good = { refused: false, reason: '', prompt: '1girl, togawa_sakiko, blue_hair, long_hair, fully_clothed, solo', negative: '', ratio: '3:4', preset: 'free' };
const run = async (responses) => { script = responses; calls = []; return preparePrompt('生成一张丰川祥子', new AbortController().signal); };
try {
  const normal = await run([{ content: JSON.stringify(good) }]);
  assert.match(normal.prompt, /togawa_sakiko/); assert.equal(calls.length, 1);
  assert.equal(calls[0].response_format.type, 'json_schema');
  assert.equal(calls[0].response_format.json_schema.strict, true); assert.equal(calls[0].max_tokens, 4096);
  assert.equal(calls[0].model, 'gemini-3.8-flash-medium');
  console.log('✓ structured JSON schema reaches the actual chat API, valid prompts need one call');

  const corrected = await run([{ content: '{"prompt":"1girl, togawa_sakiko, high collar' }, { content: JSON.stringify(good) }]);
  assert.equal(corrected.preset, 'free'); assert.equal(calls.length, 2);
  assert.equal(calls[1].messages[1].content, '生成一张丰川祥子');
  assert.match(calls[1].messages.at(-1).content, /complete valid JSON/);
  console.log('✓ exact observed partial-JSON failure is corrected once with original request preserved');

  await assert.rejects(run([{ content: '{"prompt":"broken' }, { content: '{"prompt":"still broken' }]), (e) => e.code === 'LLM_JSON_INVALID' && /格式仍不完整/.test(e.userMessage));
  assert.equal(calls.length, 2); console.log('✓ two invalid replies stop with a useful format error and no extra attempts');

  await assert.rejects(run([{ content: JSON.stringify({ refused: true, reason: 'mock refusal' }) }]), (e) => e.code === 'IMAGE_CONTENT_REFUSED' && /拒绝/.test(e.userMessage));
  assert.equal(calls.length, 1);
  await assert.rejects(run([{ refusal: 'mock native refusal' }]), (e) => e.code === 'LLM_CONTENT_REFUSED');
  assert.equal(calls.length, 1); console.log('✓ structured and native refusals never retry or become malformed-JSON errors');

  await assert.rejects(run([{ status: 503 }]), /HTTP 503/); assert.equal(calls.length, 1);
  script = [{ content: 'ordinary chat' }]; calls = [];
  await chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(calls[0].response_format, undefined); console.log('✓ upstream outages are not format retries; ordinary chat request body stays unchanged');
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true, force: true });
}
