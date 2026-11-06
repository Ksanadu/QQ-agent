import { safeFetchBinary } from './safe-fetch.js';
import { detectMime } from './image-type.js';

const qqId = value => /^[1-9]\d{4,9}$/.test(String(value ?? '')) ? String(value) : '';
// Capture trusted message structure only. Request intent and target selection
// belong to the LLM; text, nicknames and forwarded bodies never supply IDs.
export function captureAvatarContext({ segments, botId, reply }) {
  const parts = Array.isArray(segments) ? segments : [];
  const bot = qqId(botId);
  const mentionIds = [...new Set(parts.filter(s => s?.type === 'at')
    .map(s => qqId(s.data?.qq)).filter(id => id && id !== bot))];
  const quotes = parts.filter(s => s?.type === 'reply');
  const replySenderId = quotes.length === 1 && reply?.resolved
    && String(quotes[0].data?.id) === String(reply.messageId) ? qqId(reply.senderId) : '';
  return { botId: bot, mentionIds, replySenderId };
}

export function avatarTargetForMessage(entries, requestMessageId, target, mentionedUserId) {
  if (!['number', 'string'].includes(typeof requestMessageId) || !/^-?\d+$/.test(String(requestMessageId)) || !Number.isSafeInteger(Number(requestMessageId))) return null;
  const matches = (entries || []).filter(e => !e.self && !e.recalled && String(e.mid) === String(requestMessageId));
  if (matches.length !== 1) return null;
  const entry = matches[0];
  const context = entry.avatarContext || {};
  if (target !== 'mention' && mentionedUserId != null) return null;
  if (target === 'sender') return qqId(entry.senderId) || null;
  if (target === 'bot') return qqId(context.botId) || null;
  if (target === 'reply') return qqId(context.replySenderId) || null;
  if (target !== 'mention') return null;
  const ids = (context.mentionIds || []).map(qqId).filter(Boolean);
  if (mentionedUserId != null) {
    const id = qqId(mentionedUserId);
    return ids.includes(id) ? id : null;
  }
  return ids.length === 1 ? ids[0] : null;
}

export async function fetchUserAvatar(userId) {
  const id = qqId(userId);
  if (!id) throw new Error('头像目标 QQ 号无效');
  const url = new URL('https://q1.qlogo.cn/g');
  url.search = new URLSearchParams({ b: 'qq', nk: id, s: '100' });
  const { buffer } = await safeFetchBinary(url.toString(), 512 * 1024, { browseLocked: true });
  if (buffer.length >= 512 * 1024) throw new Error('QQ 头像超过下载大小上限');
  const mime = detectMime(buffer);
  if (!mime) throw new Error('QQ 未返回可识别的头像图片');
  return { buffer, mime };
}
