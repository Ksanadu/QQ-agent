// Search the current chat's retained archive, never other chats or recalled text.
function boundary(value, end = false) {
  if (!value) return end ? Infinity : -Infinity;
  const s = String(value);
  const n = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${end ? '23:59:59.999' : '00:00:00'}+08:00` : s);
  if (!Number.isFinite(n)) throw new Error('时间格式应为 YYYY-MM-DD 或含时区的 ISO 时间');
  return n;
}

export function searchChatHistory(messages, { query = '', sender = '', from = '', to = '', limit = 20, offset = 0, imagesOnly = false } = {}) {
  const words = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  const who = String(sender).trim().toLocaleLowerCase();
  const start = boundary(from), end = boundary(to, true);
  if (start > end) throw new Error('开始时间不能晚于结束时间');
  const hits = messages.filter(m => !m.recalled && m.ts >= start && m.ts <= end
    && (!imagesOnly || m.media?.some(x => x.kind === 'image'))
    && (!who || String(m.senderId) === who || String(m.senderName).toLocaleLowerCase().includes(who) || (who === 'self' && m.self))
    && words.every(w => String(m.text).toLocaleLowerCase().includes(w))).reverse();
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const take = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
  return { total: hits.length, offset: skip, hasMore: hits.length > skip + take,
    messages: hits.slice(skip, skip + take).map(m => ({ messageId: m.mid, localId: m.id,
      time: new Date(m.ts).toISOString(), sender: m.self ? '我' : m.senderName, senderId: m.senderId,
      text: String(m.text).slice(0, 2000), imageCount: m.media?.filter(x => x.kind === 'image').length || 0,
      replyToMessageId: m.reply?.messageId ?? null })) };
}
