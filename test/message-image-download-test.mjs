import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-image-refresh-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { downloadMessageImage } = await import('../src/message-image-download.js');
const { updateConfig } = await import('../src/config.js');
const { buildToolDefs } = await import('../src/tools.js');
const source = { file: 'original.gif', url: 'https://multimedia.nt.qq.com.cn/download?spec=0&rkey=expired' };
const calls = [];
const onebot = { call: async (action, args) => {
  calls.push({ action, args });
  return { url: 'https://multimedia.nt.qq.com.cn/download?spec=0&rkey=fresh' };
} };
const bytes = Buffer.from('GIF89a');
try {
  let requests = [];
  const result = await downloadMessageImage(source, { onebot, download: async url => {
    requests.push(url);
    if (new URL(url).searchParams.get('rkey') === 'expired') throw new Error('HTTP 400');
    return { buffer: bytes, contentType: 'image/gif' };
  } });
  assert.equal(result.buffer, bytes);
  assert.deepEqual(calls, [{ action: 'get_image', args: { file: 'original.gif' } }]);
  assert.equal(new URL(requests[0]).searchParams.get('spec'), '720');
  assert.equal(new URL(requests[1]).searchParams.get('spec'), '0', 'leave refreshed signed URL intact');
  assert.equal(source.url.includes('expired'), true, 'do not mutate archived media');
  console.log('PASS expired URL -> same image ID -> refreshed URL');

  calls.length = 0;
  await downloadMessageImage(source, { onebot, download: async () => ({ buffer: bytes }) });
  assert.equal(calls.length, 0, 'working URLs need no OneBot call');
  for (const file of ['C:\\secret.png', 'file:///secret.png', '../secret.png', 'https://example.com/x']) {
    await assert.rejects(downloadMessageImage({ ...source, file }, { onebot, download: async () => { throw new Error('HTTP 400'); } }), /HTTP 400/);
  }
  assert.equal(calls.length, 0, 'no disk paths or arbitrary URLs reach get_image');
  await assert.rejects(downloadMessageImage(source, { onebot, download: async () => { throw new Error('HTTP 500'); } }), /HTTP 500/);
  assert.equal(calls.length, 0, 'do not refresh unrelated failures');
  const cancel = new AbortController();
  await assert.rejects(downloadMessageImage(source, { signal: cancel.signal, onebot: { call: async () => {
    cancel.abort(new Error('cancelled'));
    return { url: 'https://example.com/fresh.gif' };
  } }, download: async () => { throw new Error('HTTP 400'); } }), /cancelled/);
  console.log('PASS happy path, opaque-ID scope, error classification and cancellation');

  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const header = Buffer.from(pixel.subarray(0, 19)); header.writeUInt16LE(4, 6); header.writeUInt16LE(4, 8);
  const frame = Buffer.from(pixel.subarray(19, -1)); frame.writeUInt16LE(10, 4);
  const gif = Buffer.concat([header, ...Array(32).fill(frame), Buffer.from([0x3b])]);
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/expired.gif') { res.writeHead(400).end(); return; }
    res.writeHead(200, { 'content-type': 'image/gif' }); res.end(gif);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    updateConfig({ security: { allowPrivateImageHosts: true }, api: { vision: true, video: true } });
    const entry = { mid: 123, text: '[图片]', media: [{ kind: 'image', file: 'original.gif', url: base + '/expired.gif' }] };
    const ctx = { chatKey: 'group:456', store: { findByMid: (_chat, id) => String(id) === '123' ? entry : null },
      onebot: { call: async (action, args) => {
        assert.equal(action, 'get_image'); assert.equal(args.file, 'original.gif');
        return { url: base + '/fresh.gif' };
      } } };
    const tool = buildToolDefs().find(t => t.id === 'get_message_images');
    const read = await tool.execute(ctx, { messageId: 123 });
    assert.ok(!read.isError, JSON.stringify(read));
    const video = read.content.find(p => p.type === 'video_url'); assert.ok(video);
    const output = path.join(dir, 'refreshed.mp4');
    fs.writeFileSync(output, Buffer.from(video.video_url.url.split(',')[1], 'base64'));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames:format=duration', '-of', 'json', output], { encoding: 'utf8', windowsHide: true }));
    assert.equal(probe.streams[0].nb_frames, '32'); assert.equal(probe.format.duration, '3.200000');
    assert.deepEqual(hits, ['/expired.gif', '/fresh.gif']);
    console.log('PASS real tool: HTTP 400 -> refresh -> GIF download -> 32-frame MP4, original duration');

    ctx.onebot.call = async () => {
      updateConfig({ security: { allowPrivateImageHosts: false } });
      return { url: base + '/fresh.gif' };
    };
    const blocked = await tool.execute(ctx, { messageId: 123 });
    assert.equal(blocked.isError, true);
    assert.equal(hits.filter(x => x === '/fresh.gif').length, 1, 'refreshed private URL remains protected');
    console.log('PASS refreshed URLs retain SSRF protection');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
} finally {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('qqa-image-refresh-'));
  fs.rmSync(dir, { recursive: true, force: true });
}
