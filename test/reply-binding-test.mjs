import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reply-bind-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { ChatStore } = await import('../src/store.js');
const { resolveMessageReply, findMessageWithReply } = await import('../src/message-replies.js');
const { segmentsToText } = await import('../src/onebot.js');
const { buildUserPrompt, resolveContextTier } = await import('../src/prompt.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const cfg = structuredClone(DEFAULT_CONFIG); cfg.sticker.enabled = false; cfg.store.promptAnchor.enabled = false;
setRuntimeConfig(cfg);
const store = new ChatStore();
const chatKey = 'group:456';
const fullText = '完整评价对象A。'.repeat(100) + '结论：这才是被引用内容的结尾。';
store.appendIncoming(chatKey, { mid: -101, senderId: 111, senderName: '甲', text: fullText, media: [{ kind: 'image', url: 'https://example.com/correct.png' }] });
store.appendIncoming(chatKey, { mid: -102, senderId: 222, senderName: '乙', text: '另一条对象B' });
let calls = 0;
const onebot = { selfId: '888', getMsg: async () => { calls++; throw new Error('offline'); } };
const local = await resolveMessageReply({ messageId: '-101', chatKey, store, onebot });
assert.equal(local.messageId, '-101'); assert.equal(local.text, fullText); assert.equal(local.media[0].url, 'https://example.com/correct.png'); assert.equal(calls, 0);
const absentStore = { findByMid: () => null };
const remote = await resolveMessageReply({ messageId: '-201', chatKey, store: absentStore, onebot: { ...onebot, getMsg: async () => ({ message_id: -201, group_id: 456, sender: { user_id: 333 }, message: '[CQ:image,file=quoted.png,url=https://example.com/quoted.png]原图说明' }) } });
assert.equal(remote.resolved, true); assert.equal(remote.media.length, 1);
store.appendSelf(chatKey, { mid: -103, text: '[图片]按要求生成的图' });
const ownImage = await resolveMessageReply({ messageId: '-103', chatKey, store, onebot: { ...onebot,
  getMsg: async () => ({ message_id: -103, group_id: 456, sender: { user_id: 888 }, message: [{ type: 'image', data: { file: 'own.png', url: 'https://example.com/own.png' } }] }) } });
assert.equal(ownImage.media.length, 1);
assert.equal(findMessageWithReply({ chatKey, store, triggerEntries: [{ reply: ownImage }] }, -103).media[0].url, 'https://example.com/own.png');
for (const wrong of [{ message_id: -999, group_id: 456 }, { message_id: -201, group_id: 789 }]) {
  const reply = await resolveMessageReply({ messageId: '-201', chatKey, store: absentStore, onebot: { ...onebot, getMsg: async () => ({ ...wrong, sender: { user_id: 333 }, message: [{ type: 'text', data: { text: '错的对象' } }] }) } });
  assert.equal(reply.resolved, false); assert.equal(reply.messageId, '-201'); assert.equal(reply.text, '');
}
console.log('✓ exact ID lookup, long text/media snapshot, CQ strings, mismatched message/chat rejection');

let bound;
const text = await segmentsToText([{ type: 'reply', data: { id: '-101' } }, { type: 'text', data: { text: '评价一下' } }], {
  resolveReply: async () => local, onReply: reply => bound = reply,
});
assert.match(text, /#-101/); assert.equal(bound.text, fullText); assert.equal(bound.messageId, '-101');
const a = store.appendIncoming(chatKey, { mid: 301, senderId: 777, senderName: '提问者', text, reply: bound });
const b = store.appendIncoming(chatKey, { mid: 302, senderId: 777, senderName: '提问者', text: '[引用 乙 #-102：另一条对象B]评价一下',
  reply: await resolveMessageReply({ messageId: '-102', chatKey, store, onebot }) });
const prompt = buildUserPrompt({ chatKey, kind: 'group', chatId: '456', chatName: '测试', triggerEntries: [a, b],
  store, memory: { formatForPrompt: () => '' }, stickerEntries: [], selfNickname: '测试Bot', contextLimit: 0 });
assert.match(prompt, /请求消息 #301 → 引用目标 #-101/);
assert.match(prompt, /请求消息 #302 → 引用目标 #-102/);
assert.match(prompt, /这才是被引用内容的结尾/);
assert.match(prompt, /get_message_images\(messageId=-101\)/);
assert.ok(prompt.indexOf('【本轮引用对象绑定】') < prompt.indexOf('【未读信息】以下是'));
assert.ok(!prompt.includes('[引用 甲：完整评价对象A。[引用'), 'Do not duplicate the inline quote');
const found = findMessageWithReply({ chatKey, store: absentStore, triggerEntries: [a] }, -101);
assert.equal(found.text, fullText); assert.equal(found.media[0].url, 'https://example.com/correct.png');
assert.equal(findMessageWithReply({ chatKey, store: absentStore, triggerEntries: [a] }, -102), null);
console.log('✓ each batched request binds its own target outside context window; tools can read the exact quoted snapshot');

const missing = await resolveMessageReply({ messageId: '-404', chatKey, store: absentStore, onebot });
const missingText = await segmentsToText([{ type: 'reply', data: { id: '-404' } }, { type: 'text', data: { text: '评价一下' } }], { resolveReply: async () => missing });
assert.match(missingText, /#-404/); assert.match(missingText, /不要猜测/);
const entry = store.appendIncoming(chatKey, { mid: 303, senderId: 777, senderName: '提问者', text: missingText, reply: missing });
const missingPrompt = buildUserPrompt({ chatKey, kind: 'group', chatId: '456', triggerEntries: [entry], store,
  memory: { formatForPrompt: () => '' }, stickerEntries: [], contextLimit: 0 });
assert.match(missingPrompt, /引用目标 #-404/); assert.match(missingPrompt, /不要拿最新消息/);
console.log('✓ unavailable reply keeps original target ID and explicitly forbids guessing a substitute');
fs.rmSync(temp, { recursive: true, force: true });
