import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { bootApp, listen, waitFor, sleep, readBody } from './_harness.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ref-e2e-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9uoAAAAASUVORK5CYII=', 'base64');
const localImage = path.join(temp, 'cache.png'); fs.writeFileSync(localImage, png);
const imageRequests = []; let releaseFirst;
const firstGate = new Promise(r => releaseFirst = r);
const proxy = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-image-key');
  let body;
  if (req.url === '/v1/images/edits') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
    const references = form.getAll('image[]');
    assert.ok(references.length > 0);
    for (const image of references) { assert.equal(image.type, 'image/png'); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png); }
    body = Object.fromEntries([...form].filter(([key]) => key !== 'image[]'));
    body.references = references.length;
  } else { assert.equal(req.url, '/v1/images/generations'); body = await readBody(req); }
  assert.equal(body.model, 'gemini-3.1-flash-image'); assert.equal(Number(body.n), 1);
  imageRequests.push({ path: req.url, ...body });
  if (imageRequests.length === 1) await firstGate;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
});
const port = await listen(proxy);
const proxyConfig = path.join(temp, 'proxy.json');
fs.writeFileSync(proxyConfig, JSON.stringify({ proxy: { port, api_key: 'fixture-image-key' } }));
const prepared = { content: JSON.stringify({ prompt: 'Apply the requested edits to the attached reference.', ratio: '1:1' }) };
const env = await bootApp({ config: {
  allow: { groups: ['456', '789'], private: ['111', '222'] }, store: { contextSliderPos: 0 },
  skills: { 'antigravity-image': { enabled: true, proxyConfigFile: proxyConfig }, 'comfy-draw': { enabled: false } },
  extensions: { hotReload: false }
}, script: Array.from({ length: 10 }, () => prepared) });
const { app, onebotHttp, onebotWs, llm, pushGroupMsg } = env;
const text = request => ({ type: 'text', data: { text: request } });
const image = { type: 'image', data: { file: 'cached.png' } };
const replies = new Map();
const sentTexts = () => onebotHttp.state.sends.flatMap(s => s.body.message.filter(m => m.type === 'text').map(m => m.data.text));
const sentImages = () => onebotHttp.state.sends.filter(s => s.body.message.some(m => m.type === 'image'));
const originalCall = app.onebot.call.bind(app.onebot);
app.onebot.call = async (action, args) => {
  if (action !== 'get_image') return originalCall(action, args);
  assert.ok(sentTexts().some(t => t.includes('已受理')), 'No reference IO before acknowledgement');
  if (!/^cached(?:2)?\.png$/.test(args.file)) throw new Error('missing cache');
  return { file: localImage };
};
app.onebot.getMsg = async mid => {
  assert.ok(sentTexts().some(t => t.includes('已受理')));
  if (!replies.has(String(mid))) throw new Error('missing message');
  return replies.get(String(mid));
};
try {
  pushGroupMsg(111, 'test', '', 1, { message: [image, text('/generate 保留主体，改成水彩')] });
  await waitFor(() => imageRequests.length === 1, 5000);
  assert.equal(sentImages().length, 0); assert.ok(sentTexts().some(t => t.includes('已受理')));
  assert.equal(imageRequests[0].path, '/v1/images/edits'); assert.equal(imageRequests[0].references, 1);
  assert.match(imageRequests[0].prompt, /保留主体/);
  assert.ok(llm.state.requests[0].messages.some(m => String(m.content).includes('cannot see those images')));
  assert.ok(llm.state.requests[0].messages.every(m => typeof m.content === 'string'), 'Reference bytes go only to image backend');
  releaseFirst(); await waitFor(() => sentImages().length === 1, 5000);
  console.log('✓ same-message image bytes are multipart uploaded after acknowledgement, then returned to QQ');

  replies.set('-20', { message_type: 'group', group_id: 456, message: [image, text('/generate 被引用命令不得执行')] });
  pushGroupMsg(111, 'test', '', 2, { message: [{ type: 'reply', data: { id: '-20' } }, text('/generate 把背景换成海边')] });
  await waitFor(() => sentImages().length === 2, 5000);
  assert.equal(imageRequests[1].references, 1); assert.doesNotMatch(imageRequests[1].prompt, /被引用命令/);
  replies.set('-21', { message_type: 'private', sender: { user_id: 111 }, message: '[CQ:image,file=cached.png]' });
  onebotWs.push({ post_type: 'message', message_type: 'private', user_id: 111, message_id: 3, sender: { user_id: 111 },
    message: '[CQ:reply,id=-21]/generate 做成插画' });
  await waitFor(() => sentImages().length === 3, 5000);
  assert.equal(sentImages()[2].body.user_id, 111);
  pushGroupMsg(111, 'test', '/generate 第四张', 4);
  await waitFor(() => sentTexts().some(t => t.includes('每天 3 张')), 4000);
  assert.equal(imageRequests.length, 3);
  console.log('✓ group/private replies and CQ image messages work; references share the existing three-per-day quota');

  const before = llm.state.requests.length;
  replies.set('-30', { message_type: 'group', group_id: 999, message: [image] });
  pushGroupMsg(222, 'test', '', 5, { message: [{ type: 'reply', data: { id: '-30' } }, text('/generate 改图')] });
  await waitFor(() => sentTexts().some(t => t.includes('不属于当前群聊')), 4000);
  assert.equal(llm.state.requests.length, before);
  for (let i = 0; i < 4; i++) {
    pushGroupMsg(222, 'test', '', 10 + i, { message: [text('/generate 无效参考图'), { type: 'image', data: { file: 'missing.png' } }] });
    await waitFor(() => sentTexts().filter(t => t.includes('参考图读取失败')).length === i + 1, 4000);
  }
  assert.equal(imageRequests.length, 3);
  pushGroupMsg(222, 'test', '/generate 失败退额后仍可出图', 20);
  await waitFor(() => sentImages().length === 4, 5000);
  assert.equal(imageRequests[3].path, '/v1/images/generations');
  pushGroupMsg(222, 'test', '', 23, { message: [text('/generate 结合两张参考图'), image, { type: 'image', data: { file: 'cached2.png' } }] });
  await waitFor(() => sentImages().length === 5, 5000);
  assert.equal(imageRequests[4].references, 2);
  console.log('✓ cross-chat references are rejected; failed image reads refund quota and do not invoke prompt/image models');

  const oldRequests = imageRequests.length;
  pushGroupMsg(222, 'test', '', 21, { message: [image] });
  pushGroupMsg(222, 'test', '', 22, { message: [{ type: 'forward', data: { text: '/generate 隐藏命令' } }] });
  await sleep(300); assert.equal(imageRequests.length, oldRequests);
  const metadataFiles = fs.readdirSync(path.join(env.dataDir, 'antigravity-image')).filter(n => n.endsWith('.json') && n !== 'quota.json');
  const metadata = metadataFiles.map(n => JSON.parse(fs.readFileSync(path.join(env.dataDir, 'antigravity-image', n), 'utf8')));
  assert.equal(metadata.filter(m => m.referenceImageCount === 1).length, 3);
  assert.ok(metadata.every(m => !m.command.images && !m.referenceImages));
  console.log('✓ image-only/forwarded messages do not generate; saved metadata excludes reference bytes and URLs');
} finally {
  releaseFirst(); await env.teardown(); proxy.closeAllConnections(); await new Promise(r => proxy.close(r));
  fs.rmSync(temp, { recursive: true, force: true });
}
