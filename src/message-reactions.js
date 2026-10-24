// QQ 系统表情编号。只发送编号，不另发图片或文字消息。
export const REACTION_EMOJIS = Object.freeze([
  { id: '76', label: '赞', icon: '👍' },
  { id: '66', label: '爱心', icon: '❤️' },
  { id: '74', label: '太阳', icon: '☀️' },
  { id: '14', label: '微笑', icon: '🙂' },
  { id: '13', label: '呲牙', icon: '😁' },
  { id: '4', label: '得意', icon: '😎' },
  { id: '5', label: '流泪', icon: '😢' },
  { id: '21', label: '可爱', icon: '😊' },
  { id: '24', label: '饥饿', icon: '🤤' },
  { id: '32', label: '疑问', icon: '❓' },
  { id: '39', label: '再见', icon: '👋' },
  { id: '99', label: '鼓掌', icon: '👏' }
].map(Object.freeze));

export function validReactionMessageId(value) {
  const raw = String(value ?? '');
  const n = Number(raw);
  return /^-?\d+$/.test(raw) && Number.isSafeInteger(n) && n !== 0 ? n : null;
}

export const REACTION_HISTORY_LIMIT = 10;

// 本轮触发消息 + 首条触发消息之前的 10 条同会话记录。
// 引用本身不再绕过窗口；无 QQ ID / 已撤回的记录占窗口位置，但不可操作。
export function reactionTargets(triggerEntries = [], previousEntries = []) {
  const targets = new Map();
  const add = (entry, historical) => {
    if (!entry || typeof entry !== 'object' || entry.recalled) return;
    const mid = validReactionMessageId(entry.mid);
    if (mid !== null && !targets.has(mid)) targets.set(mid, Object.freeze({
      messageId: mid, historical, sender: entry.self ? '我' : String(entry.senderName || '未知'),
      senderId: String(entry.senderId || ''), ts: Number(entry.ts) || null
    }));
  };
  const current = Array.isArray(triggerEntries) ? triggerEntries : [];
  if (!current.length) return Object.freeze([]);
  for (const entry of current) add(entry, false);
  for (const entry of (Array.isArray(previousEntries) ? previousEntries : []).slice(-REACTION_HISTORY_LIMIT)) add(entry, true);
  return Object.freeze([...targets.values()]);
}

export function captureReactionTargets({ triggerEntries = [], store, chatKey }) {
  const current = Array.isArray(triggerEntries) ? triggerEntries : [];
  const localIds = current.map((entry) => Number(entry?.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
  const previous = localIds.length && typeof store?.recentBefore === 'function'
    ? store.recentBefore(chatKey, localIds.reduce((a, b) => Math.min(a, b)), { limit: REACTION_HISTORY_LIMIT }) : [];
  return reactionTargets(current, previous);
}

export function validateMessageReaction({ targets = [], messageId, emojiId, set = true }) {
  const mid = validReactionMessageId(messageId);
  if (mid === null) throw new Error('消息 ID 必须是非零整数（可为负数）');
  if (!targets.some((target) => target.messageId === mid)) {
    throw new Error(`只能给本轮消息及之前 10 条窗口内的消息贴表情。可用消息 ID：${targets.map((target) => target.messageId).join('、') || '无'}；不可使用窗口外或其他会话的 ID，也不能改贴给发指令的人来替代指定对象`);
  }
  const emoji = REACTION_EMOJIS.find((item) => item.id === String(emojiId));
  if (!emoji) throw new Error(`请选择支持的 QQ 表情：${REACTION_EMOJIS.map((item) => `${item.id}=${item.label}`).join('、')}`);
  if (typeof set !== 'boolean') throw new Error('set 必须为布尔值');
  return { messageId: mid, emojiId: emoji.id, label: emoji.label, set };
}
