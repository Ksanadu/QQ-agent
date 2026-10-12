import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-core-safety-'));
const { getConfig, updateConfig } = await import('../src/config.js');
const { chatAllowed } = await import('../src/chat-policy.js');
const { SendQueue } = await import('../src/sender.js');
const { ActionApprovals } = await import('../src/action-approvals.js');
const { OneBotClient } = await import('../src/onebot.js');
const { assertProtectedAction, withStickerDeletionGrant } = await import('../src/protected-actions.js');
const { loadPlugins } = await import('../src/plugin-loader.js');
const { skillManager } = await import('../src/skills/manager.js');
const cfg = { allow: { groups: ['100', '200'], private: ['900'] }, deny: { groups: [], private: [] }, tools: { crossChatSend: true }, security: { adminUserIds: ['900'] } };
updateConfig(cfg);
assert.equal(chatAllowed('group', '100', { ...cfg, deny: { groups: [100] } }), false);
assert.equal(chatAllowed('private', '900', { ...cfg, deny: { private: ['900'] } }), false);
assert.equal(chatAllowed('group', '300', cfg), false);
assert.equal(chatAllowed('group', '300', { allow: {}, allowAllWhenEmpty: true }), true);
console.log('✓ incoming/outgoing chat policy: deny precedes allow');

let nextId = 0, sends = [];
const queue = new SendQueue({ onebot: {
  sendText: async (...args) => { sends.push(args); return { message_id: ++nextId }; },
  sendSegments: async (...args) => { sends.push(args); return { message_id: ++nextId }; }
}, store: { appendSelf() {} } });
const first = { id: 'first', chatKey: 'group:100', sent: [] };
const second = { id: 'second', chatKey: 'group:200', sent: [] };
const sender1 = queue.forSession(first), sender2 = queue.forSession(second);
await Promise.all([
  sender1.sendMedia('group:100', [{ type: 'record', data: { file: 'mock.wav' } }], { label: '[语音]' }),
  sender2.sendTextBatch('group:200', ['second'])
]);
assert.equal(first.sent.length, 1); assert.equal(first.sent[0].type, 'record'); assert.equal(first.sent[0].sessionId, 'first');
assert.equal(second.sent.length, 1); assert.equal(second.sent[0].sessionId, 'second');
await sender1.sendTextBatch('group:100', ['dedupe']);
const before = first.sent.length;
await sender1.sendTextBatch('group:100', ['dedupe']);
assert.equal(first.sent.length, before);
updateConfig({ tools: { crossChatSend: false } });
await assert.rejects(sender1.sendTextBatch('group:200', ['forbidden']), /跨会话/);
updateConfig({ tools: { crossChatSend: true } });
const pending = sender1.sendMedia('group:200', [{ type: 'record', data: { file: 'queued.wav' } }]);
await new Promise((resolve) => setTimeout(resolve, 20));
updateConfig({ deny: { groups: ['200'] } });
await assert.rejects(pending, /黑名单/);
assert.equal(first.sent.length, before);
updateConfig({ deny: { groups: [] } });
console.log('✓ media receipts bind to the correct session; denied/duplicate sends are not receipts');

await assert.rejects(new OneBotClient({}).call('delete_custom_face', { emoji_id: 'one' }), /批准/);
assert.throws(() => assertProtectedAction('delete_custom_face', { emoji_id: 'one' }), /批准/);
await withStickerDeletionGrant(['one'], async () => {
  await Promise.resolve();
  assertProtectedAction('delete_custom_face', { emoji_id: 'one' });
  assert.throws(() => assertProtectedAction('delete_custom_face', { emoji_id: 'two' }), /批准/);
});
assert.throws(() => assertProtectedAction('delete_custom_face', { emoji_id: 'one' }), /批准/);
let clock = Date.now(), deleted = [];
const entries = [{ id: 'one', emojiId: 'qq-one', desc: 'one' }, { id: 'two', emojiId: 'qq-two', desc: 'two' }];
const stickers = { entries, sync: async () => ({ entries: stickers.entries }) };
const approvals = new ActionApprovals({ now: () => clock, config: getConfig, stickers, onebot: { call: async (action, params) => { assertProtectedAction(action, params); deleted.push(params.emoji_id); } } });
const scoped = approvals.forSession(first, [{ senderId: '900', mid: 10 }]);
await assert.rejects(approvals.forSession(first, [{ senderId: '900' }, { senderId: '901' }]).requestStickerDeletion({ stickerIds: ['one'] }), /唯一请求者/);
await assert.rejects(approvals.forSession(first, [{ senderId: '901' }]).requestStickerDeletion({ stickerIds: ['one'] }), /管理员/);
const operation = await scoped.requestStickerDeletion({ stickerIds: ['one'] });
assert.deepEqual(deleted, []);
operation.targets[0].emojiId = 'qq-two'; // callers only receive a copy
await assert.rejects(approvals.approve(operation.id, { via: 'qq', actorId: '901', chatKey: first.chatKey }), /不匹配/);
await assert.rejects(approvals.approve(operation.id, { via: 'qq', actorId: '900', chatKey: second.chatKey }), /不匹配/);
assert.equal(await approvals.confirmFromEvent({ actorId: '900', chatKey: first.chatKey, text: '确认删除 ' + operation.id, plain: false }), null);
await approvals.confirmFromEvent({ actorId: '900', chatKey: first.chatKey, text: '确认删除 ' + operation.id, plain: true });
assert.deepEqual(deleted, ['qq-one']);
await assert.rejects(approvals.approve(operation.id, { via: 'console' }), /已结束/);
const expired = await scoped.requestStickerDeletion({ stickerIds: ['two'] });
clock += 300001;
await assert.rejects(approvals.approve(expired.id, { via: 'console' }), /过期/);
console.log('✓ deletion requires trusted approval, immutable targets, matching identity and a single-use unexpired code');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-duplicate-id-'));
const roots = { skills: path.join(root, 'skills'), plugins: path.join(root, 'plugins') };
for (const dir of [path.join(roots.skills, 'one'), path.join(roots.plugins, 'two')]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ id: 'duplicate-demo', name: 'demo', version: '1.0.0', apiVersion: 1 }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'throw new Error("duplicate entry must not execute");');
}
const loaded = await loadPlugins({ roots, log: () => {} });
assert.equal(loaded.loaded.length, 0); assert.equal(loaded.conflicts.length, 1);
assert.match(skillManager.registry.get('duplicate-demo').loadError, /ID 冲突/);
console.log('✓ duplicate IDs across skills/plugins are rejected before entry code executes');
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true, force: true });
