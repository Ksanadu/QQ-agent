import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-confirm-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { setup, deactivate } = await import('../skills/sticker-librarian/index.js');
const tools = new Map();
setup({ config: () => ({}), registerTool: t => tools.set(t.id, t) });
const calls = [];
const entries = [
  { id: 'one', emojiId: 'qq-one', desc: '测试表情' },
  { id: 'two', emojiId: 'qq-two', desc: '失败表情' },
  { id: 'local', desc: '本地条目' }
];
const ctx = { stickers: { entries, sync: async () => ({ entries: ctx.stickers.entries }) },
  onebot: { call: async (action, params) => { calls.push({ action, params }); if (params.emoji_id === 'qq-two') throw Error('协议拒绝'); } } };
const execute = args => tools.get('delete_sticker').execute(ctx, args).then(r => JSON.parse(r.content));
try {
  const preview = await execute({ stickerIds: ['one'] });
  assert.equal(preview.dryRun, true); assert.equal(calls.length, 0);
  const result = await execute({ stickerIds: ['one', 'two', 'local'], confirm: true });
  assert.equal(result.deleted, 1); assert.equal(result.results.length, 3);
  assert.deepEqual(calls.map(c => c.params.emoji_id), ['qq-one', 'qq-two']);
  assert.ok(ctx.stickers.entries.some(e => e.id === 'two'));
  assert.ok(!ctx.stickers.entries.some(e => e.id === 'one'));
  console.log('PASS sticker deletion previews without sending; explicit confirm executes QQ deletion and preserves failed/local entries');
} finally { deactivate(); fs.rmSync(dataDir, { recursive: true, force: true }); }
