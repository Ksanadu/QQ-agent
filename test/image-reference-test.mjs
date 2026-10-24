import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-reference-'));
process.env.QQ_AGENT_DATA_DIR = path.join(temp, 'data');
const { parseImageCommand } = await import('../src/image-commands.js');
const { loadImageReferences, MAX_REFERENCE_BYTES } = await import('../src/image-references.js');
const { ImageCommandService } = await import('../src/image-command-service.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9uoAAAAASUVORK5CYII=', 'base64');
const imageFile = path.join(temp, 'cached.png'); fs.writeFileSync(imageFile, png);
const event = (message) => ({ post_type: 'message', user_id: 111, sender: { user_id: 111 }, message_id: 1, message });
const text = { type: 'text', data: { text: '/generate 改成水彩' } };
const img = { type: 'image', data: { file: 'picture.png', url: 'https://example.com/p.png' } };
const command = parseImageCommand(event([img, text]), '888');
assert.equal(command.images.length, 1); assert.equal(command.request, '改成水彩');
assert.equal(parseImageCommand(event([img]), '888'), null);
assert.equal(parseImageCommand(event([{ type: 'forward', data: { text: '/generate 改图' } }]), '888'), null);
assert.ok(parseImageCommand(event([{ type: 'text', data: { text: '/comfy 改图' } }, img]), '888').inputError);
assert.match(parseImageCommand(event([text, ...Array(5).fill(img)]), '888').inputError, /最多/);
const raw = parseImageCommand(event('[CQ:reply,id=-20] /generate 改背景[CQ:image,file=abc.png,url=https://example.com/a?x=1&#44;y=2]'), '888');
assert.equal(raw.replyId, '-20'); assert.equal(raw.images[0].url, 'https://example.com/a?x=1,y=2');
console.log('✓ direct images, CQ strings, explicit command gate, Comfy separation and reference count');

let reads = 0, downloads = 0;
const onebot = { selfId: '888', call: async (_action, args) => { reads++; assert.equal(args.file, 'picture.png'); return { file: imageFile }; },
  getMsg: async () => ({ group_id: 456, message_type: 'group', message: [img, { type: 'text', data: { text: '/generate 被引用命令不得执行' } }] }) };
const load = (cmd, extra = {}) => loadImageReferences({ command: cmd, chatKey: 'group:456', onebot, download: async () => { downloads++; return { buffer: png }; }, ...extra });
assert.deepEqual((await load(command))[0].buffer, png); assert.equal(reads, 1); assert.equal(downloads, 0);
assert.equal((await load({ ...command, images: [], replyId: '-20' })).length, 1);
await assert.rejects(load({ ...command, images: [], replyId: '-20' }, { onebot: { ...onebot, getMsg: async () => ({ group_id: 999, message: [img] }) } }), /不属于当前群聊/);
await assert.rejects(load({ ...command, images: [], replyId: '-20' }, { onebot: { ...onebot, getMsg: async () => ({ message: [img] }) } }), /无法确认/);
assert.equal((await load({ ...command, images: [], replyId: '-20' }, { onebot: { ...onebot, getMsg: async () => ({ message: [img] }) }, knownMessage: () => ({ media: [] }) })).length, 1);
assert.equal((await load({ ...command, images: [], replyId: '-20' }, { onebot: { ...onebot, getMsg: async () => { throw new Error('expired'); } },
  knownMessage: () => ({ media: [{ kind: 'image', file: 'picture.png' }] }) })).length, 1);
await assert.rejects(load({ ...command, images: [], replyId: '-20' }, { onebot: { ...onebot, getMsg: async () => ({ group_id: 456, message: [] }) } }), /没有可用图片/);
console.log('✓ reply images, same-chat validation and locally known message fallback');

reads = 0;
await assert.rejects(load({ ...command, images: [{ file: imageFile, url: '' }] }), /读取失败/);
assert.equal(reads, 0, 'Do not send arbitrary user disk paths to get_image');
await assert.rejects(load({ ...command, images: [{ url: 'http://127.0.0.1:9/private' }] }, { download: undefined }), /读取失败/);
await assert.rejects(load({ ...command, images: [{ url: 'https://example.com/bad' }] }, { download: async () => ({ buffer: Buffer.from('not an image') }) }), /只支持/);
const huge = path.join(temp, 'huge.png'); fs.writeFileSync(huge, png); fs.truncateSync(huge, MAX_REFERENCE_BYTES + 1);
await assert.rejects(load(command, { onebot: { ...onebot, call: async () => ({ file: huge }) } }), /10 MB/);
const controller = new AbortController(); controller.abort();
await assert.rejects(load(command, { signal: controller.signal }), /abort/i);
await assert.rejects(load({ ...command, images: Array.from({ length: 5 }, (_, i) => ({ url: `https://example.com/${i}` })) }), /最多输入 4/);
const largeImage = Buffer.alloc(9 * 1024 * 1024); png.copy(largeImage);
await assert.rejects(load({ ...command, images: Array.from({ length: 3 }, (_, i) => ({ url: `https://example.com/${i}` })) },
  { download: async () => ({ buffer: largeImage }) }), /总大小超过 24 MB/);
const during = new AbortController();
await assert.rejects(load({ ...command, images: [{ url: 'https://example.com/p.png' }] },
  { signal: during.signal, download: async () => { during.abort(); return { buffer: png }; } }), /abort/i);
console.log('✓ SSRF, arbitrary local paths, invalid image content, size limits and cancellation');

const order = []; let releaseAck;
const ack = new Promise(r => releaseAck = r);
const service = new ImageCommandService({ stateFile: path.join(temp, 'quota.json'),
  preparePrompt: async (_request, _signal, context) => { order.push('prompt'); assert.equal(context.referenceCount, 1); return { prompt: 'edit', ratio: '1:1' }; },
  generateImage: async (prepared) => { order.push('image'); assert.deepEqual(prepared.referenceImages[0].buffer, png); return { buffer: png }; },
  saveImage: async (_image, metadata) => { assert.equal(metadata.command.images, undefined); assert.equal(metadata.referenceImageCount, 1); return {}; },
});
const ctx = { command, chatKey: 'group:456', kind: 'group', canSend: () => true,
  loadImageReferences: async () => { order.push('reference'); return [{ buffer: png, mime: 'image/png', ext: '.png' }]; },
  sender: { sendTextBatch: () => ack, sendImage: async () => { order.push('send'); } } };
const job = service.handle(ctx); await Promise.resolve(); assert.deepEqual(order, []);
releaseAck(); await job.completion; assert.deepEqual(order, ['reference', 'prompt', 'image', 'send']);
await service.handle({ ...ctx, command: { ...command, messageId: 2 }, loadImageReferences: async () => { throw Object.assign(new Error('bad ref'), { userMessage: '参考图失败' }); } }).completion;
assert.equal(service.readState().users['111'].entries.length, 1, 'Failed references refund the reserved daily image');
console.log('✓ acknowledgement before reference IO; real image bytes reach backend; failures refund quota; metadata excludes references');
fs.rmSync(temp, { recursive: true, force: true });
