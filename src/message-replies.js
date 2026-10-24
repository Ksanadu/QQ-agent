import { imageMessageSegments } from './image-commands.js';
import { extractMediaFromSegments } from './onebot.js';

const MAX_REPLY_TEXT = 12000;
const validMid = id => /^-?\d+$/.test(String(id)) && Number.isSafeInteger(Number(id));

// Bind a reply to its exact QQ message ID; never substitute a nearby message.
export async function resolveMessageReply({ messageId, chatKey, store, onebot }) {
  const mid = String(messageId ?? '');
  const missing = { messageId: mid, resolved: false, sender: '', senderId: '', text: '', media: [] };
  if (!validMid(mid)) return missing;
  const known = store.findByMid(chatKey, mid);
  let source;
  if (known) {
    source = { sender: known.self ? (onebot.selfNickname || '机器人') : known.senderName,
      senderId: known.self ? String(onebot.selfId || '') : known.senderId,
      text: known.text, media: known.media, ts: known.ts, self: known.self };
  }
  const needsMedia = known && !(known.media || []).length && /\[(?:图片|image|视频|video)\]/.test(String(known.text || ''));
  if (!known || needsMedia) {
    try {
      const message = await onebot.getMsg(mid);
      if (!message) { if (!known) return missing; }
      else {
        if (message.message_id != null && String(message.message_id) !== mid) return { ...missing, reason: 'message-id-mismatch' };
        const [kind, id] = chatKey.split(':');
        if (message.message_type && message.message_type !== kind) return { ...missing, reason: 'chat-mismatch' };
        if (kind === 'group' && message.group_id != null && String(message.group_id) !== id) return { ...missing, reason: 'chat-mismatch' };
        const senderId = String(message.sender?.user_id ?? message.user_id ?? '');
        if (kind === 'private' && message.group_id != null && Number(message.group_id) !== 0) return { ...missing, reason: 'chat-mismatch' };
        if (kind === 'private' && senderId && senderId !== id && senderId !== String(onebot.selfId)) return { ...missing, reason: 'chat-mismatch' };
        if (kind === 'private' && senderId === String(onebot.selfId) && message.target_id != null && String(message.target_id) !== id) return { ...missing, reason: 'chat-mismatch' };
        const segments = imageMessageSegments(message.message ?? message.raw_message ?? '');
        source = { sender: message.sender?.card || message.sender?.nickname || senderId,
          senderId, text: segments.map(s => s.type === 'text' ? String(s.data?.text ?? '') : `[${s.type === 'image' ? '图片' : s.type}]`).join('').trim(),
          media: extractMediaFromSegments(segments), ts: Number(message.time) * 1000 || null,
          self: senderId === String(onebot.selfId) };
      }
    } catch { if (!known) return missing; }
  }
  const text = String(source.text ?? '');
  return { messageId: mid, resolved: true, sender: String(source.sender || ''), senderId: String(source.senderId || ''),
    text: text.slice(0, MAX_REPLY_TEXT), truncated: text.length > MAX_REPLY_TEXT,
    media: Array.isArray(source.media) ? source.media : [], ts: source.ts || null, self: Boolean(source.self),
    mediaUnavailable: /\[(?:图片|image)\]/.test(text) && !(source.media || []).some(m => m.kind === 'image') };
}

// A quoted target may lie outside the prompt/store window; use only this run's
// resolved snapshots, never arbitrary cross-chat get_msg lookups from model args.
export function findMessageWithReply(ctx, messageId) {
  const stored = ctx.store.findByMid(ctx.chatKey, messageId);
  for (const request of ctx.triggerEntries || []) {
    const reply = request.reply;
    if (reply?.resolved && String(reply.messageId) === String(messageId)) {
      if (stored) return !(stored.media || []).length && (reply.media || []).length ? { ...stored, media: reply.media } : stored;
      return { mid: reply.messageId, ts: reply.ts, senderName: reply.sender, senderId: reply.senderId,
        text: reply.text, media: reply.media || [], self: reply.self, reply: null, truncated: reply.truncated };
    }
  }
  return stored || null;
}
