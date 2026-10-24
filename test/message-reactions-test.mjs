import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reactions-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { reactionTargets, validateMessageReaction } = await import('../src/message-reactions.js');
const { SendQueue } = await import('../src/sender.js');
const { updateConfig } = await import('../src/config.js');
const { ChatStore } = await import('../src/store.js');
const { buildToolDefs, executeTool } = await import('../src/tools.js');
updateConfig({ allow: { groups: ['456'], private: ['777'] }, deny: { groups: [], private: [] },
  send: { maxPerMinute: 80, maxPerHour: 1000 } });
const trigger = [{ mid: -101, text: '好消息', senderName: '甲', reply: {
  resolved: true, messageId: '-200', text: '被引用的原话', sender: '乙'
} }, { mid: 102, text: '第二条', reply: { resolved: false, messageId: -999 } },
{ mid: null, text: '[拍一拍]' }, { mid: '-101', text: '重复' }];
const targets = reactionTargets(trigger);
assert.deepEqual(targets.map((m) => m.messageId), [-101, 102]);
assert.deepEqual(reactionTargets('proactive'), []);
const args = { messageId: '-101', emojiId: '76' };
for (const messageId of [0, '', null, '1.0', '1e2', [], {}, '9007199254740993']) {
  assert.throws(() => validateMessageReaction({ targets, ...args, messageId }), /消息 ID/);
}
for (const messageId of [-999, -300, -200, 888]) {
  assert.throws(() => validateMessageReaction({ targets, ...args, messageId }), /只能给本轮/);
}
assert.throws(() => validateMessageReaction({ targets, ...args, emojiId: 'bogus' }), /支持的 QQ 表情/);
assert.throws(() => validateMessageReaction({ targets, ...args, set: 'false' }), /布尔/);
console.log('✓ invalid / outside-window / unresolved IDs rejected; quotes cannot bypass the window');
const calls = [];
let fail = false;
const onebot = { async call(action, params) { if (fail) throw new Error('协议端拒绝'); calls.push({ action, params }); return {}; } };
const store = new ChatStore(0);
store.appendIncoming('group:456', { mid: -300, text: '无关历史', ts: Date.now() });
const queue = new SendQueue({ onebot, store });
const makeSession = (chatKey = 'group:456', entries = trigger) => ({ id: 'test-session', chatKey, trigger: entries, sent: [] });
const session = makeSession();
const sender = queue.forSession(session);
await assert.rejects(queue.reactMessage('group:456', args), /必须绑定/);
await assert.rejects(sender.reactMessage('private:777', args), /必须绑定/);
await assert.rejects(sender.reactMessage('group:456', { ...args, messageId: -300, triggerEntries: [{ mid: -300 }] }), /只能给本轮/);
await sender.reactMessage('group:456', args);
assert.deepEqual(calls[0], { action: 'set_msg_emoji_like', params: { message_id: -101, emoji_id: '76', set: true } });
const duplicate = await sender.reactMessage('group:456', args);
assert.equal(duplicate.duplicate, true); assert.equal(calls.length, 1); assert.equal(session.sent.length, 1);
await sender.reactMessage('group:456', { ...args, set: false });
assert.equal(calls.at(-1).params.set, false);
await assert.rejects(sender.reactMessage('group:456', { messageId: -200, emojiId: '66' }), /只能给本轮/);
assert.equal(session.sent[0].type, 'reaction'); assert.equal(store.recent('group:456').length, 1, 'no fabricated text message enters chat history');
console.log('✓ signed QQ IDs, remove, duplicate suppression and delivery receipt; no fake chat text');
fail = true;
const before = session.sent.length;
await assert.rejects(sender.reactMessage('group:456', { messageId: 102, emojiId: '14' }), /协议端拒绝/);
assert.equal(session.sent.length, before);
fail = false;
await sender.reactMessage('group:456', { messageId: 102, emojiId: '14' });
assert.equal(session.sent.length, before + 1, 'failed operation does not get marked delivered or deduplicated');
const privateSession = makeSession('private:777', [{ mid: -600, text: '谢谢' }]);
await queue.forSession(privateSession).reactMessage('private:777', { messageId: -600, emojiId: '66' });
const denied = makeSession('group:789');
await assert.rejects(queue.forSession(denied).reactMessage('group:789', args), /未获准/);
updateConfig({ deny: { groups: ['456'] } });
await assert.rejects(sender.reactMessage('group:456', { messageId: 102, emojiId: '32' }), /未获准/);
updateConfig({ deny: { groups: [] }, send: { maxPerMinute: 1 } });
const limitedQueue = new SendQueue({ onebot, store });
const limited = limitedQueue.forSession(makeSession());
await limited.reactMessage('group:456', args);
await assert.rejects(limited.reactMessage('group:456', { messageId: 102, emojiId: '66' }), /频率超限/);
console.log('✓ failures not recorded as success; private chat, allow/deny and outbound rate limits enforced');
updateConfig({ send: { maxPerMinute: 80 } });
const finished = makeSession(); finished.status = 'done';
await assert.rejects(queue.forSession(finished).reactMessage('group:456', args), /已结束或中止/);
const defs = buildToolDefs();
const tool = defs.find((d) => d.id === 'react_message');
assert.ok(tool); assert.equal(tool.category, 'messaging'); assert.ok(tool.parameters.properties.emojiId.enum.includes('76'));
const result = await executeTool(defs, { sender: queue.forSession(makeSession()), chatKey: 'group:456' }, 'react_message', JSON.stringify({ messageId: 102, emojiId: '99' }));
assert.equal(result.isError, undefined); assert.equal(JSON.parse(result.content).emojiId, '99');
const rejected = await executeTool(defs, { sender, chatKey: 'group:456' }, 'react_message', JSON.stringify({ messageId: -300, emojiId: '76' }));
assert.equal(rejected.isError, true);
console.log('✓ registered model tool executes through guarded sender and returns useful errors');
fs.rmSync(dataDir, { recursive: true, force: true });
