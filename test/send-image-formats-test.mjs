import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-formats-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  security: { allowPrivateImageHosts: true, imageSend: { maxPerRun: 6, maxPreviewsPerRun: 6 } }
}));
const { buildToolDefs } = await import('../src/tools.js');
const tool = buildToolDefs().find(t => t.id === 'send_image');
const fixtures = new Map([
  ['webp', ['image/webp', Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')]],
  ['png', ['image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9uoAAAAASUVORK5CYII=', 'base64')]],
  ['gif', ['image/gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')]]
]);
const requests = [], sends = [];
const server = http.createServer((req, res) => {
  requests.push({ url: req.url, accept: req.headers.accept });
  if (req.url === '/html') { res.writeHead(200, { 'content-type': 'image/webp' }); res.end('<html>not an image</html>'); return; }
  const [mime, bytes] = fixtures.get(req.url.slice(1)) || fixtures.get('webp');
  if (req.url === '/negotiated' && req.headers.accept?.includes('image/avif')) {
    res.writeHead(200, { 'content-type': 'image/avif' }); res.end('unsupported AVIF representation'); return;
  }
  res.writeHead(200, { 'content-type': mime }); res.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const ctx = {
  chatKey: 'group:123', session: { id: 'test', sent: [] }, emit() {},
  sender: { recordsDeliveries: true, async sendImage(chatKey, image) {
    sends.push({ chatKey, image }); return { message_id: 5000 + sends.length };
  } }
};
try {
  for (const [format, [mime, bytes]] of fixtures) {
    const url = `${base}/${format}`;
    assert.equal((await tool.execute(ctx, { url })).isError, true, 'preview is still required');
    const preview = await tool.execute(ctx, { url, preview: true });
    assert.ok(!preview.isError, JSON.stringify(preview));
    assert.ok(preview.content.some(p => p.image_url?.url === `data:${mime};base64,${bytes.toString('base64')}`));
    const sent = await tool.execute(ctx, { url });
    assert.ok(!sent.isError, JSON.stringify(sent));
    assert.equal(sends.at(-1).image.dataUrl, `base64://${bytes.toString('base64')}`);
  }
  console.log('PASS WebP/PNG/GIF download → preview → send_image receipt, preview requirement preserved');
  const negotiated = await tool.execute(ctx, { url: `${base}/negotiated`, preview: true });
  assert.ok(!negotiated.isError, JSON.stringify(negotiated));
  assert.ok(requests.every(r => !r.accept.includes('image/avif')));
  assert.ok(requests.every(r => r.accept.includes('image/webp')));
  console.log('PASS binary Accept negotiates supported image formats instead of AVIF');
  const before = sends.length;
  const invalid = await tool.execute(ctx, { url: `${base}/html`, preview: true });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content, /HTML/);
  assert.equal(sends.length, before);
  console.log('PASS a false image Content-Type cannot turn an HTML response into an image');
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
