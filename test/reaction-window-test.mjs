import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reaction-window-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { ChatStore } = await import('../src/store.js');
const { captureReactionTargets, validateMessageReaction } = await import('../src/message-reactions.js');
const { SendQueue } = await import('../src/sender.js');
const { buildUserPrompt, buildSystemPrompt } = await import('../src/prompt.js');
const { MemoryStore } = await import('../src/memory.js');
const { updateConfig } = await import('../src/config.js');
updateConfig({ allow: { groups: ['456'], private: ['777'] }, deny: { groups: [], private: [] },
  store: { historyCount: 80 }, send: { maxPerMinute: 80, maxPerHour: 1000 } });
const store = new ChatStore(0);
const CHAT = 'group:456';
const append = (mid, senderName, text, extra = {}) => store.appendIncoming(CHAT, {
  mid, senderId: senderName === '佬虎' ? '257214159' : '2456214815', senderName, text,
  ts: 1792498000000 + store.getChatMeta(CHAT).total * 1000, ...extra
});
const history = Array.from({ length: 12 }, (_, i) => append(-1000 - i, i === 11 ? '佬虎' : '路人', `历史${i}`));
store.drainUnread(CHAT);
const first = append(-2000, '管理员', '@机器人 给佬虎的消息贴个赞', { reply: { resolved: true, messageId: history[0].mid } });
const second = append(-2001, '管理员', '就是他刚才那句');
const triggerEntries = [first, second];
const context = { triggerEntries, store, chatKey: CHAT };
const targets = captureReactionTargets(context);
assert.deepEqual(targets.map((t) => t.messageId), [-2000, -2001, ...history.slice(2).map((m) => m.mid)]);
assert.equal(targets.filter((t) => t.historical).length, 10);
assert.deepEqual(captureReactionTargets({ ...context, triggerEntries: [second, first] }).map((t) => t.messageId).sort(), targets.map((t) => t.messageId).sort());
assert.equal(validateMessageReaction({ targets, messageId: history[2].mid, emojiId: '76' }).messageId, history[2].mid, 'exact tenth previous message allowed');
assert.throws(() => validateMessageReaction({ targets, messageId: history[1].mid, emojiId: '76' }), /10 条窗口/, 'eleventh previous message rejected');
assert.throws(() => validateMessageReaction({ targets, messageId: history[0].mid, emojiId: '76' }), /10 条窗口/, 'direct quote does not bypass limit');
console.log('✓ all current-batch messages + exact previous ten; 10th allowed / 11th rejected; old quotes cannot bypass');

const memory = new MemoryStore();
const prompt = buildUserPrompt({ ...context, kind: 'group', chatId: '456', chatName: '测试群',
  memory, stickerEntries: [], selfNickname: '机器人', runSeq: 1, proactive: false,
  contextLimit: 80, reactionMessages: targets, session: {} });
const block = prompt.split('【本轮可贴表情的消息】固定窗口＝')[1].split('\n\n【')[0];
assert.match(block, new RegExp(`#${history[11].mid}（之前10条）.*佬虎.*257214159`));
assert.ok(!block.includes(`#${history[1].mid}（`));
assert.match(buildSystemPrompt(), /core-stickers/);
const stickerGuide = fs.readFileSync(new URL('../doc/core-guides/core-stickers.md', import.meta.url), 'utf8');
assert.match(stickerGuide, /不能换成请求者/);
assert.match(stickerGuide, /指定表情不受支持时也应说明/);
console.log('✓ model sees historical target ID + sender identity; instructions forbid substituting requester or emoji');

const calls = [];
const queue = new SendQueue({ store, onebot: { async call(action, params) { calls.push({ action, params }); return {}; } } });
const session = { id: 'window-run', chatKey: CHAT, trigger: triggerEntries, status: 'running', sent: [] };
const sender = queue.forSession(session, () => {}, { reactionMessages: targets });
const later = append(-3000, '路人', '运行开始后才来的消息');
for (let i = 0; i < 15; i++) append(-3100 - i, '路人', '新消息不应推动窗口');
await sender.reactMessage(CHAT, { messageId: history[11].mid, emojiId: '76' });
assert.equal(calls[0].params.message_id, history[11].mid, 'reaction targets named other person, not requester');
await sender.reactMessage(CHAT, { messageId: history[2].mid, emojiId: '66' });
await assert.rejects(sender.reactMessage(CHAT, { messageId: later.mid, emojiId: '76', targets: [{ messageId: later.mid }] }), /10 条窗口/);
assert.deepEqual(captureReactionTargets(context), targets, 'new arrivals never shift a window anchored to first trigger');
store.appendIncoming('private:777', { mid: -9999, ts: Date.now(), text: '另一个会话' });
await assert.rejects(sender.reactMessage(CHAT, { messageId: -9999, emojiId: '76' }), /10 条窗口/);
assert.deepEqual(captureReactionTargets({ ...context, triggerEntries: [] }), []);
assert.deepEqual(store.recentBefore(CHAT, 999999), []);
console.log('✓ fixed snapshot survives new arrivals, denies forged targets and cross-chat IDs; proactive runs have no target');

store.markRecalled(CHAT, history[10].mid);
const afterRecall = captureReactionTargets(context);
assert.equal(afterRecall.length, targets.length - 1);
assert.ok(!afterRecall.some((t) => t.messageId === history[10].mid));
assert.ok(!afterRecall.some((t) => t.messageId === history[1].mid), 'recalled slots do not pull in older messages');
const poke = append(null, '路人', '[拍一拍]');
const last = append(-5000, '管理员', '现在窗口里有一条无 ID 事件');
assert.ok(captureReactionTargets({ ...context, triggerEntries: [last] }).every((t) => t.messageId !== null));
assert.ok(store.recentBefore(CHAT, last.id).some((m) => m.id === poke.id));
console.log('✓ recalled / missing-QQ-ID records are not actionable and do not expand the ten-record window');
fs.rmSync(dataDir, { recursive: true, force: true });
