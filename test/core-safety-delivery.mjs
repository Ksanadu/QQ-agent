import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-core-safety-'));
const { getConfig, updateConfig } = await import('../src/config.js');
const { chatAllowed } = await import('../src/chat-policy.js');
const { SendQueue } = await import('../src/sender.js');
const { loadPlugins } = await import('../src/plugin-loader.js');
const { skillManager } = await import('../src/skills/manager.js');
const cfg = { allow: { groups: ['100', '200'], private: ['900'] }, deny: { groups: [], private: [] }, tools: { crossChatSend: true } };
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
