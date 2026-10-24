import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Each participant has an explicit, ordered task in each chat. New quotes take
// precedence over this material. Keeping IDs (not media URLs) respects recalls.
export class ConversationTasks {
  constructor({ file = path.join(DATA_DIR, 'conversation-tasks.json'), now = Date.now, ttlMs = 2 * 60 * 60 * 1000 } = {}) {
    this.file = file; this.now = now; this.ttlMs = ttlMs;
    try { this.tasks = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.tasks = []; }
    if (!Array.isArray(this.tasks)) this.tasks = [];
  }
  forTriggers(chatKey, entries, store) {
    const actors = new Set(entries.filter(m => !m.self).map(m => String(m.senderId)));
    return this.tasks.filter(t => t.chatKey === chatKey && actors.has(t.actorId) && this.now() - t.updatedAt < this.ttlMs)
      .map(t => ({ ...t, targets: t.messageIds.map(id => {
        const m = store.findByMid(chatKey, id);
        return !m || m.recalled ? { messageId: id, unavailable: true, text: '对象已撤回或不再保留，不可换成另一条' }
          : { messageId: m.mid, sender: m.senderName, text: String(m.text).slice(0, 500), imageCount: m.media?.filter(x => x.kind === 'image').length || 0 };
      }) }));
  }
  rememberInteraction(chatKey, entries, sent, viewedIds, store) {
    const actors = [...new Set(entries.filter(m => !m.self).map(m => String(m.senderId)))];
    if (actors.length !== 1 || !sent.length) return;
    const prior = this.forTriggers(chatKey, entries, store)[0];
    const referenced = entries.map(m => m.reply?.messageId).filter(id => id != null);
    const inputs = entries.filter(m => m.media?.some(x => x.kind === 'image')).map(m => m.mid);
    let ids = [...new Set([...referenced, ...inputs, ...viewedIds].map(String))];
    if (!referenced.length && !inputs.length && prior && (!ids.length || ids.every(id => prior.messageIds.includes(id)))) ids = prior.messageIds;
    if (!ids.length) ids = sent.filter(m => m.type === 'text' && m.messageId != null).slice(-2).map(m => String(m.messageId));
    if (prior && ids.some(id => prior.messageIds.includes(id) && (!store.findByMid(chatKey, id) || store.findByMid(chatKey, id).recalled))) return;
    ids = ids.filter(id => { const m = store.findByMid(chatKey, id); return m && !m.recalled; });
    const summary = '请求：' + entries.map(m => m.text).join('；').slice(0, 500) + '\n答复：' + sent.map(m => m.text).join('；').slice(0, 600);
    this.save(chatKey, actors[0], summary, ids, store);
  }
  save(chatKey, actorId, summary, messageIds, store) {
    if (!/^(group|private):\d+$/.test(chatKey) || !/^\d+$/.test(String(actorId))) throw new Error('缺少有效会话或请求者');
    const ids = [...new Set(messageIds.map(String))].slice(0, 12);
    for (const id of ids) { const m = store.findByMid(chatKey, id); if (!m || m.recalled) throw new Error(`当前会话找不到有效消息 #${id}`); }
    const task = { chatKey, actorId: String(actorId), summary: String(summary).slice(0, 1200), messageIds: ids, updatedAt: this.now() };
    this.tasks = this.tasks.filter(t => this.now() - t.updatedAt < this.ttlMs && !(t.chatKey === chatKey && t.actorId === task.actorId));
    this.tasks.push(task); this.tasks = this.tasks.slice(-200);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.tasks)); fs.renameSync(tmp, this.file);
    return task;
  }
}
