import fs from 'node:fs';
import path from 'node:path';
import { bootApp } from './_harness.mjs';

const output = path.resolve(process.argv[2]);
if (!output.includes('desktop-migration-qa')) throw new Error('Use a dedicated desktop-migration-qa path');
const env = await bootApp({ config: { persona: { botName: '验收机器人' }, memory: { consolidateEnabled: false },
  telemetry: { enabled: false }, ui: { theme: 'dark' } } });
for (const [i, text] of ['帮我查一下今天的安排','补充：只看下午的活动','明白了，稍后再继续'].entries()) {
  env.app.store.appendIncoming('group:456', { mid: 9000 + i, ts: Date.now() - (10 - i) * 60000,
    senderId: '777', senderName: '测试群友', text });
}
env.app.store.markAllRead('group:456');
env.app.store.appendSelf('group:456', { text: '下午有两项安排，已经整理好了', ts: Date.now() - 300000, mid: 9100 });
env.app.memory.append('group:456', 'memberImpression', '喜欢音乐，倾向于简洁直接的答复。', { userId: '777', target: '测试群友' });
for (const [i, title] of ['下午的活动安排','图片内容与引用核对','连续补充合并测试'].entries()) {
  const s = env.app.sessions.create({ chatKey: 'group:456', trigger: [], triggerSummary: '测试群友：' + title });
  s.model = 'test-model-a'; s.rounds = 3; s.finishReason = '已完成请求';
  s.messages = [
    { role: 'assistant', reasoningSummary: '先检查本轮输入，再结合补充内容整理答复。', content: null },
    { toolCall: { name: 'get_recent_messages', args: { limit: 10 }, result: '已读取相关消息', isError: false, durationMs: 24 } },
    { toolCall: { name: 'send_message', args: { messages: ['已根据最新补充整理好结果'] }, result: '发送成功', isError: false, durationMs: 210 } }
  ];
  s.usage = { promptTokens: 1800 + i * 900, completionTokens: 230, totalTokens: 2030 + i * 900, cachedTokens: 1200, calls: 3 };
  s.sent = [{ type: 'text', text: '已根据最新补充整理好结果', messageId: 9200 + i, sentAt: Date.now(), to: 'group:456' }];
  s.timing = { receivedAt: s.startedAt, queueMs: 10, modelMs: 3400, toolMs: 234, firstTextMs: 3650, sendReceiptMs: 210 };
  env.app.sessions.finish(s.id, 'done');
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ pid: process.pid, backendUrl: env.base, dataDir: env.dataDir }));
console.log('READY isolated backend: ' + env.base);
process.on('SIGTERM', async () => { await env.teardown(); process.exit(0); });
