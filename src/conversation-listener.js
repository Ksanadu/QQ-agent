import { Worker } from 'node:worker_threads';

export function listenerMessage(m) {
  return { id: m.id, messageId: m.mid, senderId: m.senderId, sender: m.self ? '机器人' : m.senderName,
    self: Boolean(m.self), text: String(m.text || '').slice(0, 1200), replyTo: m.reply?.messageId ?? null };
}

// One short-lived worker per active group. The worker can classify, never send.
export class ConversationListeners {
  constructor({ onRelated, onCheck = () => {}, onClose = () => {} }) {
    this.tasks = new Map(); this.onRelated = onRelated; this.onCheck = onCheck; this.onClose = onClose;
  }
  start(chatKey, { config, anchor, parentSessionId, idleMs = 60000 }) {
    this.stop(chatKey, '新会话接管监听');
    const until = Date.now() + idleMs;
    const worker = new Worker(new URL('./conversation-listener-worker.js', import.meta.url), { workerData: { config, anchor: anchor.map(listenerMessage), idleMs, until } });
    const state = { worker, parentSessionId, until, checked: 0, seen: new Set() };
    this.tasks.set(chatKey, state);
    const close = reason => {
      if (this.tasks.get(chatKey) !== state) return;
      this.tasks.delete(chatKey); worker.terminate().catch(() => {}); this.onClose(chatKey, state, reason);
    };
    state.close = close;
    worker.on('message', event => {
      if (this.tasks.get(chatKey) !== state) return;
      if (event.type === 'closed') return close(event.reason);
      if (event.type !== 'check') return;
      state.checked++; state.until = event.until;
      const ids = event.ids.filter(id => state.seen.has(id));
      this.onCheck(chatKey, state, { ...event, ids });
      if (event.related && ids.length) this.onRelated(chatKey, ids, event.reason);
    });
    worker.on('error', () => close('监听任务异常，已退出'));
    worker.on('exit', () => close('监听任务退出'));
    return state;
  }
  feed(chatKey, entry) {
    const task = this.tasks.get(chatKey);
    if (!task || !entry || entry.self || entry.recalled || task.seen.has(entry.id)) return false;
    task.seen.add(entry.id);
    if (task.seen.size > 1000) task.seen.delete(task.seen.values().next().value);
    task.worker.postMessage({ type: 'entry', entry: listenerMessage(entry) }); return true;
  }
  updateAnchor(chatKey, entries) {
    const task = this.tasks.get(chatKey);
    if (task) task.worker.postMessage({ type: 'anchor', anchor: entries.map(listenerMessage) });
  }
  stop(chatKey, reason = '监听已停止') { this.tasks.get(chatKey)?.close(reason); }
  stopAll() { for (const key of [...this.tasks.keys()]) this.stop(key); }
  summary() { return [...this.tasks].map(([chatKey, t]) => ({ chatKey, parentSessionId: t.parentSessionId, until: t.until, checks: t.checked })); }
}
