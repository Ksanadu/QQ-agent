// Parse only the actual OneBot message, never rendered quotes/history/LLM arguments.
export const MAX_REFERENCE_IMAGES = 4;
const decodeCQ = (value) => String(value).replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');

export function imageMessageSegments(message) {
  if (Array.isArray(message)) return message;
  const text = String(message ?? ''), segments = [];
  let cursor = 0;
  for (const match of text.matchAll(/\[CQ:([a-zA-Z_]+)(?:,([^\]]*))?\]/g)) {
    if (match.index > cursor) segments.push({ type: 'text', data: { text: decodeCQ(text.slice(cursor, match.index)) } });
    const data = Object.fromEntries((match[2] || '').split(',').filter(Boolean).map((item) => {
      const pos = item.indexOf('=');
      return pos < 0 ? [item, ''] : [item.slice(0, pos), decodeCQ(item.slice(pos + 1))];
    }));
    segments.push({ type: match[1], data }); cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ type: 'text', data: { text: decodeCQ(text.slice(cursor)) } });
  return segments;
}

export function imageSourcesFromMessage(message) {
  return imageMessageSegments(message).filter((s) => s?.type === 'image').map((s) => Object.freeze({
    file: String(s.data?.file ?? '').slice(0, 2048), url: String(s.data?.url ?? '').slice(0, 8192)
  }));
}

export function parseImageCommand(event, selfId) {
  if (event?.post_type !== 'message') return null;
  const actorId = String(event.user_id ?? event.sender?.user_id ?? '');
  if (!/^\d+$/.test(actorId) || actorId === String(selfId)) return null;
  if (event.sender?.user_id != null && String(event.sender.user_id) !== actorId) return null;
  let text = '', replyId = null, inputError = '';
  const segments = imageMessageSegments(event.message ?? event.raw_message ?? '');
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') return null;
    if (segment.type === 'text') text += String(segment.data?.text ?? '');
    else if (segment.type === 'reply') {
      const id = String(segment.data?.id ?? '');
      if (replyId != null || !/^-?\d+$/.test(id) || !Number.isSafeInteger(Number(id))) inputError = '引用消息无效，请重新引用一条图片消息。';
      else replyId = id;
    }
    else if (segment.type === 'image') continue;
    else if (segment.type === 'at' && selfId && String(segment.data?.qq) === String(selfId)) continue;
    else return null; // Forwarded commands, voice and @someone else never trigger generation.
  }
  const match = /^\/(generate|comfy)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const images = Object.freeze(imageSourcesFromMessage(segments));
  if (images.length > MAX_REFERENCE_IMAGES) inputError = `一次最多输入 ${MAX_REFERENCE_IMAGES} 张参考图。`;
  if (match[1] === 'comfy' && images.length) inputError = '参考图目前仅支持 /generate，/comfy 仍使用文字生图。';
  return Object.freeze({ name: match[1], actorId, request: (match[2] || '').trim(), messageId: event.message_id ?? null,
    images, replyId, inputError });
}

export function parseGenerateCommand(event, selfId) {
  const command = parseImageCommand(event, selfId);
  return command?.name === 'generate' ? command : null;
}

// The provider claims the command synchronously and owns its background job.
export function dispatchImageCommand({ command, providers, ctx, log = () => {} }) {
  const reply = (text) => ctx.sender.sendTextBatch(ctx.chatKey, [text], {
    replyToMessageId: command.messageId, atUserId: ctx.kind === 'group' ? command.actorId : null,
    dedupeKey: `${command.name}:${command.actorId}:${command.messageId ?? Date.now()}`
  }).catch((error) => log(`[${command.name}] 回复失败：${error.message}`));
  const provider = providers[0];
  if (!provider) { void reply('生图功能暂未启用，请联系管理员。'); return; }
  if (!ctx.canSend()) { void reply('机器人当前暂停或暂时无法回复，请稍后再试。'); return; }
  try {
    const result = provider.fn({ ...ctx, command });
    if (!result?.handled) throw new Error('生图能力没有接管命令');
    result.completion?.catch((error) => log(`[${command.name}] 后台任务失败：${error.message}`));
  } catch (error) {
    log(`[${command.name}] 受理失败：${error.message}`);
    void reply('生图功能暂时不可用，请稍后再试。');
  }
}
