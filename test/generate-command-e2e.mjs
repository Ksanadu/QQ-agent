import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { bootApp, listen, waitFor, sleep, readBody } from './_harness.mjs';

// Every QQ delivery, prompt LLM and image upstream is local and mocked.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-generate-proxy-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9uoAAAAASUVORK5CYII=', 'base64');
const imageRequests = []; let releaseFirst;
const imageGate = new Promise((r) => { releaseFirst = r; });
const proxy = http.createServer(async (req, res) => {
  assert.equal(req.url, '/v1/images/generations');
  assert.equal(req.headers.authorization, 'Bearer local-image-test-key');
  const body = await readBody(req); imageRequests.push(body);
  if (imageRequests.length === 1) await imageGate;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }] }));
});
const imagePort = await listen(proxy);
const proxyConfigFile = path.join(tmp, 'gui.json');
fs.writeFileSync(proxyConfigFile, JSON.stringify({ proxy: { port: imagePort, api_key: 'local-image-test-key' } }));
const comfyRequests = []; let releaseComfyFirst;
const comfyGate = new Promise((r) => { releaseComfyFirst = r; });
const comfyServer = http.createServer(async (req, res) => {
  const json = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.url === '/object_info/FluxResolutionNode') return json({ FluxResolutionNode: { input: { required: { aspect_ratio: [['1:1 (Square)', '3:4 (Golden Ratio)', '16:9 (Widescreen)']] } } } });
  if (req.url === '/prompt') {
    const body = await readBody(req); comfyRequests.push(body);
    assert.equal(body.prompt['5'].inputs.batch_size, 1);
    assert.match(body.prompt['69'].inputs.text, /^masterpiece, best quality,/);
    return json({ prompt_id: `comfy-${comfyRequests.length}` });
  }
  if (req.url.startsWith('/history/')) {
    const id = req.url.slice('/history/'.length);
    if (id === 'comfy-1') await comfyGate;
    return json({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { '78': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } });
  }
  if (req.url.startsWith('/view?')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
  if (req.url === '/queue') return json({});
  res.writeHead(404); res.end();
});
const comfyPort = await listen(comfyServer);
process.env.COMFYUI_URL = `http://127.0.0.1:${comfyPort}`;
const workflowFile = path.join(tmp, 'workflow.json');
const workflow = Object.fromEntries(['5', '69', '71', '118', '87', '68', '78', '79', '50', '86'].map((id) => [id, { inputs: {} }]));
workflow['5'].inputs.batch_size = 7; // Request logic must force a single-image batch.
fs.writeFileSync(workflowFile, JSON.stringify(workflow));
const prepared = { content: JSON.stringify({ prompt: 'An orange cat drinking tea on the moon, cinematic 3D illustration.', ratio: '16:9' }) };
const comfyPrepared = { content: JSON.stringify({ refused: false, reason: '', prompt: 'orange_cat, drinking_tea, moon, solo', negative: '', ratio: '3:4', preset: 'free' }) };
const env = await bootApp({
  config: {
    allow: { groups: ['456', '789'], private: ['111', '2456214815'] },
    store: { contextSliderPos: 0 }, extensions: { hotReload: false },
    skills: { 'antigravity-image': { enabled: true, proxyConfigFile }, 'comfy-draw': { enabled: true, workflowFile, pollIntervalMs: 100 } }
  },
  script: Array.from({ length: 12 }, () => prepared)
});
const { app, onebotHttp, onebotWs, llm, pushGroupMsg } = env;
const imageSends = () => onebotHttp.state.sends.filter((s) => s.body.message.some((m) => m.type === 'image'));
const apiSends = () => imageSends().filter((s) => s.body.message.some((m) => m.type === 'image' && String(m.data.file).includes('antigravity-image')));
const comfySends = () => imageSends().filter((s) => s.body.message.some((m) => m.type === 'image' && String(m.data.file).includes('comfy-draw')));
const texts = () => onebotHttp.state.sends.flatMap((s) => s.body.message.filter((m) => m.type === 'text').map((m) => m.data.text));
try {
  pushGroupMsg(111, 'test', '帮我画一只猫', 1);
  await sleep(300); assert.equal(imageRequests.length, 0); assert.equal(llm.state.requests.length, 0);
  pushGroupMsg(111, 'test', '/generate', 2);
  await waitFor(() => texts().some((t) => t.includes('用法')), 3000);
  assert.equal(imageRequests.length, 0);

  const promptCallsBefore = llm.state.requests.length;
  const sessionsBefore = app.sessions.listSummaries().length;
  pushGroupMsg(111, 'test', '/generate 一只在月球喝茶的橘猫，横版', 3);
  await waitFor(() => imageRequests.length === 1, 4000);
  assert.ok(texts().some((t) => t.includes('已受理')));
  assert.equal(imageSends().length, 0); // acknowledged while image response is still pending.
  const tools = (await env.request('GET', '/api/tools')).data.tools;
  assert.equal(tools.some((t) => t.skillId === 'comfy-draw' && t.id.endsWith('__generate')), false, 'No implicit Comfy generation tool may remain');
  const comfyPromptIndex = llm.state.requests.length;
  llm.state.script[comfyPromptIndex] = { content: '{"prompt":"orange_cat, drinking_tea' };
  llm.state.script[comfyPromptIndex + 1] = comfyPrepared;
  pushGroupMsg(111, 'test', '/comfy 一只喝茶的橘猫', 300, { group_id: 789 });
  await waitFor(() => comfyRequests.length === 1, 5000);
  assert.ok(texts().some((t) => t.includes('已受理一张本地生图')));
  assert.equal(imageSends().length, 0);
  releaseComfyFirst(); await waitFor(() => comfySends().length === 1, 5000);
  assert.equal(apiSends().length, 0, 'Comfy completes while the API response is still held');
  assert.equal(comfySends()[0].body.group_id, 789);
  assert.match(comfyRequests[0].prompt['69'].inputs.text, /orange_cat/);
  assert.equal(llm.state.requests[comfyPromptIndex].response_format.type, 'json_schema');
  assert.equal(llm.state.requests[comfyPromptIndex].model, 'gemini-3.8-flash-medium');
  console.log('✓ /comfy independently acknowledges, writes Anima tags and returns a local image while /generate remains pending');
  releaseFirst();
  await waitFor(() => apiSends().length === 1, 5000);
  const body = imageRequests[0];
  assert.equal(body.model, 'gemini-3.1-flash-image'); assert.equal(body.n, 1);
  assert.equal(body.quality, 'standard'); assert.equal(body.size, '16:9');
  assert.match(body.prompt, /An orange cat/); assert.match(body.prompt, /月球喝茶/);
  assert.equal(llm.state.requests.length, promptCallsBefore + 3); assert.equal(llm.state.requests.at(-1).tools, undefined);
  const sent = apiSends()[0].body;
  assert.equal(sent.group_id, 456); assert.ok(sent.message.some((m) => m.type === 'at' && String(m.data.qq) === '111'));
  const fileUri = sent.message.find((m) => m.type === 'image').data.file;
  assert.match(fileUri, /^file:\/\/\//);
  assert.equal(app.store.unreadCount('group:456'), 0);
  assert.equal(app.sessions.listSummaries().length, sessionsBefore); // no duplicate ordinary agent session.
  console.log('✓ real ingest → immediate receipt → prompt → fixed one-image API → local-file QQ send, without chat batching');

  pushGroupMsg(111, 'test', '/generate 一只狗', 4, { group_id: 789 });
  await waitFor(() => apiSends().length === 2, 5000);
  onebotWs.push({ post_type: 'message', message_type: 'private', user_id: 111, message_id: 5, sender: { user_id: 111 }, message: [{ type: 'text', data: { text: '/generate 一只兔子' } }] });
  await waitFor(() => apiSends().length === 3, 5000);
  pushGroupMsg(111, 'test', '/generate 第四张应拒绝', 50);
  await waitFor(() => texts().some((t) => t.includes('每天 3 张')), 3000);
  assert.equal(imageRequests.length, 3);
  for (let i = 2; i <= 4; i++) {
    llm.state.script[llm.state.requests.length] = comfyPrepared;
    pushGroupMsg(111, 'test', '/comfy API额度用完仍可出图 ' + i, 300 + i);
    await waitFor(() => comfySends().length === i, 5000);
  }
  assert.equal(imageRequests.length, 3); assert.equal(comfyRequests.length, 4);
  console.log('✓ API daily quota allows three consecutive images across groups/private chats; exhausted API quota does not limit Comfy');

  pushGroupMsg(2456214815, 'admin', '/generate 管理员猫', 6);
  await waitFor(() => apiSends().length === 4, 5000);
  pushGroupMsg(2456214815, 'admin', '/generate 管理员狗', 7);
  await waitFor(() => apiSends().length === 5, 5000);
  assert.equal(texts().filter((t) => t.includes('已受理')).length, 9, 'Every distinct request must get a receipt despite identical acknowledgement text');
  pushGroupMsg(2456214815, 'admin', '/generate 管理员狗', 7);
  await sleep(300); assert.equal(imageRequests.length, 5);
  console.log('✓ trusted admin exemption and duplicate-event suppression');

  pushGroupMsg(333, 'blocked', '/generate 不应调用', 8, { group_id: 999 });
  pushGroupMsg(333, 'forward', '', 9, { message: [{ type: 'forward', data: { text: '/generate 引用中命令' } }] });
  await sleep(300); assert.equal(imageRequests.length, 5);

  // Disable during the real SendQueue delay after an upstream image response.
  pushGroupMsg(333, 'late', '/generate 图片返回后不应再发送', 11);
  await waitFor(() => imageRequests.length === 6, 3000);
  app.updateConfig({ skills: { 'antigravity-image': { enabled: false } } });
  await sleep(1600); assert.equal(apiSends().length, 5, 'Disabled jobs must not deliver even after entering the send chain');
  pushGroupMsg(2456214815, 'admin', '/generate 停用后', 10);
  await waitFor(() => texts().some((t) => t.includes('暂未启用')), 3000);
  assert.equal(imageRequests.length, 6);
  llm.state.script[llm.state.requests.length] = { content: JSON.stringify({ refused: false, reason: '', prompt: 'smiling, looking_at_viewer, sitting', negative: '', ratio: '3:4', preset: 'selfie' }) };
  pushGroupMsg(111, 'test', '/comfy 来张大肥鱼自拍', 400);
  await waitFor(() => comfySends().length === 5, 5000);
  assert.equal(comfyRequests.at(-1).prompt['900'].inputs.lora_name, 'deepseek_whale_girl_maid_anima_lora_clean.safetensors');
  assert.deepEqual(comfyRequests.at(-1).prompt['86'].inputs.model, ['900', 0]);
  assert.match(comfyRequests.at(-1).prompt['69'].inputs.text, /whale maid/);
  const beforeRefusal = llm.state.requests.length;
  llm.state.script[beforeRefusal] = { content: JSON.stringify({ refused: true, reason: 'mock refusal' }) };
  pushGroupMsg(2456214815, 'admin', '/comfy 拒绝处理测试', 500);
  await waitFor(() => texts().some((t) => t.includes('提示词模型拒绝')), 3000);
  assert.equal(llm.state.requests.length, beforeRefusal + 1); assert.equal(comfyRequests.length, 5);
  const beforeFormat = llm.state.requests.length;
  llm.state.script[beforeFormat] = { content: '{"prompt":"broken' };
  llm.state.script[beforeFormat + 1] = { content: '{"prompt":"still broken' };
  pushGroupMsg(2456214815, 'admin', '/comfy 格式处理测试', 501);
  await waitFor(() => texts().some((t) => t.includes('格式仍不完整')), 3000);
  assert.equal(llm.state.requests.length, beforeFormat + 2); assert.equal(comfyRequests.length, 5);
  console.log('✓ corrected JSON produces one GPU job; refusal/format failures give distinct replies and submit no GPU jobs');
  console.log('✓ whitelist, forwarded-message rejection, disabled-skill behavior and cancellation during send-queue delay');
} finally {
  releaseFirst(); releaseComfyFirst(); await env.teardown();
  proxy.closeAllConnections(); await new Promise((r) => proxy.close(r));
  comfyServer.closeAllConnections(); await new Promise((r) => comfyServer.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
