import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, DATA_DIR } from './config.js';
import { findSticker, saveStickerStore } from './stickers.js';
import { withStickerDeletionGrant } from './protected-actions.js';
import { chatAllowed } from './chat-policy.js';

export class ActionApprovals {
  constructor({ onebot, stickers, emit = () => {}, now = Date.now, ttlMs = 300000, config = getConfig }) {
    Object.assign(this, { onebot, stickers, emit, now, ttlMs, config });
    this.operations = new Map();
  }

  admins() {
    const ids = this.config().security?.adminUserIds;
    return (Array.isArray(ids) ? ids : []).map(String).filter((s) => /^\d{1,15}$/.test(s));
  }

  forSession(session, triggerEntries) {
    const actors = [...new Set((triggerEntries || []).filter((e) => !e.self && !e.isPoke).map((e) => String(e.senderId)).filter((s) => /^\d+$/.test(s)))];
    const actorId = actors.length === 1 ? actors[0] : '';
    const messageId = actors.length === 1 ? triggerEntries.find((e) => String(e.senderId) === actorId)?.mid : null;
    return Object.freeze({ requestStickerDeletion: (args) => this.request({ sessionId: session.id, chatKey: session.chatKey, actorId, messageId }, args) });
  }

  async request(context, { stickerIds, reason = '' }) {
    if (!context.actorId) throw new Error('不能确定唯一请求者；请管理员单独发送删除请求');
    if (this.admins().length && !this.admins().includes(context.actorId)) throw new Error('只有指定管理员可以请求删除表情');
    const ids = [...new Set((Array.isArray(stickerIds) ? stickerIds : [stickerIds]).map(String))];
    if (!ids.length || ids.length > 20) throw new Error('每次请指定 1 至 20 张表情');
    const synced = await this.stickers.sync(true);
    if (synced?.error) throw new Error(`无法核对 QQ 收藏：${synced.error}`);
    const entries = synced?.entries || this.stickers.entries || [];
    const targets = ids.map((id) => {
      const entry = findSticker(entries, id);
      if (!entry?.emojiId) throw new Error(`找不到可删除的 QQ 收藏：${id}`);
      return { id: entry.id, emojiId: String(entry.emojiId), label: entry.desc || entry.localNote || entry.id };
    });
    this.list();
    const pending = [...this.operations.values()].filter((o) => o.status === 'pending');
    if (pending.length >= 100) throw new Error('待批准操作过多，请先在控制台处理');
    const equivalent = pending.find((o) => o.chatKey === context.chatKey && o.actorId === context.actorId && JSON.stringify(o.targets) === JSON.stringify(targets));
    if (equivalent) return this.view(equivalent);
    let id;
    do { id = crypto.randomBytes(5).toString('hex').toUpperCase(); } while (this.operations.has(id));
    const op = { ...context, id, action: 'sticker.delete', targets, reason: String(reason).slice(0, 300), createdAt: this.now(), expiresAt: this.now() + this.ttlMs, status: 'pending' };
    this.operations.set(id, op);
    this.notify(op);
    return this.view(op);
  }

  view(op) { return structuredClone(op); }

  list() {
    for (const [id, op] of this.operations) {
      if (op.status === 'pending' && op.expiresAt <= this.now()) op.status = 'expired';
      if (op.expiresAt + 3600000 < this.now() && op.status !== 'executing') this.operations.delete(id);
    }
    return [...this.operations.values()].map((op) => this.view(op)).reverse();
  }

  notify(op) {
    this.emit('action-approvals', this.view(op));
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(path.join(DATA_DIR, 'action-approvals.jsonl'), JSON.stringify(this.view(op)) + '\n');
    } catch (error) { console.error('[approval] 无法保存操作审计:', error.message); }
  }

  cancel(id) {
    const op = this.operations.get(id);
    if (!op || op.status !== 'pending') throw new Error('操作已结束或不存在');
    op.status = 'cancelled'; this.notify(op); return this.view(op);
  }

  async approve(id, { via, actorId = '', chatKey = '' }) {
    const op = this.operations.get(id);
    if (!op || op.status !== 'pending' || op.expiresAt <= this.now()) throw new Error('操作已结束、已过期或不存在；请重新预览');
    if (via !== 'console' && !(via === 'qq' && this.admins().includes(String(actorId)) && op.actorId === String(actorId) && op.chatKey === chatKey)) throw new Error('确认者身份或会话不匹配');
    const [kind, target] = op.chatKey.split(':');
    if (!chatAllowed(kind, target, this.config())) throw new Error('来源聊天已被禁用');
    op.status = 'executing'; op.approvedBy = via === 'console' ? 'console' : String(actorId); this.notify(op);
    const results = [];
    for (const target of op.targets) {
      try {
        await withStickerDeletionGrant([target.emojiId], () => this.onebot.call('delete_custom_face', { emoji_id: target.emojiId }));
        results.push({ ...target, deleted: true });
        const removed = (this.stickers.entries || []).filter((e) => e.id === target.id || String(e.emojiId) === target.emojiId);
        this.stickers.entries = (this.stickers.entries || []).filter((e) => !removed.includes(e));
        try {
          saveStickerStore(this.stickers.entries);
          const base = fs.realpathSync(path.join(DATA_DIR, 'sticker-images'));
          for (const entry of removed) if (entry.localFile?.startsWith('file:///')) {
            const file = fs.realpathSync(fileURLToPath(entry.localFile));
            const relative = path.relative(base, file);
            if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.unlinkSync(file);
          }
        } catch (error) { results.at(-1).cleanupWarning = error.message; }
      } catch (error) { results.push({ ...target, deleted: false, error: error.message }); }
    }
    op.results = results; op.status = results.every((r) => r.deleted) ? 'done' : 'partial'; op.endedAt = this.now(); this.notify(op);
    return this.view(op);
  }

  async confirmFromEvent({ actorId, chatKey, text, plain }) {
    if (!plain) return null;
    const match = /^确认删除\s+([A-F0-9]{10})$/.exec(String(text).trim());
    if (!match) return null;
    return this.approve(match[1], { via: 'qq', actorId, chatKey });
  }
}
