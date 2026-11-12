import { sanitizeUserText } from './util.js';

// The archive keeps its original records. These helpers control what may be
// copied into a model request, including the inline preview of a quoted record.
export function replyPreview(id, reply) {
  if (!reply?.sender && !reply?.text) return `[引用 消息 #${id}：原文未获取，不要猜测引用对象]`;
  const sender = reply.senderId ? `${reply.sender}(QQ:${reply.senderId})` : reply.sender;
  const excerpt = reply.text ? '：' + String(reply.text).replace(/\s+/g, ' ').slice(0, 160) : '';
  return `[引用 ${sender || '消息'} #${id}${excerpt}]`;
}

export function modelMessage(store, chatKey, entry) {
  if (!entry || entry.recalled || (entry.mid != null && store.isRecalled?.(chatKey, entry.mid))) return null;
  const id = entry.reply?.messageId;
  if (id == null || (!entry.reply.recalled && !store.isRecalled?.(chatKey, id))) return entry;
  const notice = `[引用消息 #${id} 已撤回]`;
  const text = String(entry.text || '');
  const preview = sanitizeUserText(replyPreview(id, entry.reply));
  // Some old records have a quote preview in a different format. Never carry
  // a legacy inline quote of unknown extent back into the model's context.
  const safeText = text.includes(preview) ? text.replace(preview, notice) : text.startsWith(notice) ? text
    : text.includes('[引用 ') ? notice : `${notice}${text ? ' ' + text : ''}`;
  return { ...entry, text: safeText, reply: { messageId: String(id), resolved: false, recalled: true },
    ...(entry.avatarContext ? { avatarContext: { ...entry.avatarContext, replySenderId: '' } } : {}) };
}

export function findModelMessage(store, chatKey, id) {
  return modelMessage(store, chatKey, store.findByMid(chatKey, id));
}

export function messageDependencyIds(entry) {
  return [entry.mid ?? entry.messageId, entry.reply?.messageId ?? entry.replyToMessageId]
    .filter(id => id != null).map(String);
}
