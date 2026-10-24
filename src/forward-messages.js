import { forwardIdFromData } from './onebot.js';
import { imageMessageSegments } from './image-commands.js';

function assertMessageScope(message, mid, chatKey, selfId) {
  if (message?.message_id != null && String(message.message_id) !== String(mid)) throw new Error('读取到的消息 ID 与目标不一致');
  const [kind, id] = String(chatKey || '').split(':');
  if (!kind) return;
  if (message?.message_type && message.message_type !== kind) throw new Error('转发消息不属于当前会话');
  if (kind === 'group' && message?.group_id != null && String(message.group_id) !== id) throw new Error('转发消息不属于当前群聊');
  if (kind === 'private') {
    if (Number(message?.group_id)) throw new Error('转发消息不属于当前私聊');
    const sender = String(message?.sender?.user_id ?? message?.user_id ?? '');
    if (sender && sender !== id && sender !== String(selfId)) throw new Error('转发消息不属于当前私聊');
    if (sender === String(selfId) && message?.target_id != null && String(message.target_id) !== id) throw new Error('转发消息不属于当前私聊');
  }
}

/**
 * 统一读取合并转发。SnowLuma 的 message_id 路径对负数 ID 不能解析资源 ID，
 * 所以优先使用真实 forward 段；旧占位符先 get_msg 取段，最后兼容仅认 message_id 的实现。
 * message 仅由真实入站事件提供；模型只能传当前会话存档的消息 ID。
 */
export async function readForwardMessage({ onebot, messageId, message, chatKey }) {
  const raw = String(messageId ?? '');
  const mid = Number(raw);
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(mid) || mid === 0) throw new Error('转发消息 ID 必须是非零整数（可为负数）');
  const tried = new Set();
  const failures = [];
  const getNodes = async (params) => {
    try {
      const result = await onebot.call('get_forward_msg', params);
      const nodes = result?.messages ?? result?.data?.messages;
      if (Array.isArray(nodes) && nodes.length) return nodes;
      failures.push('接口返回空的转发节点');
    } catch (error) { failures.push(String(error?.message ?? error)); }
    return null;
  };
  const fromSegments = async (source) => {
    for (const seg of imageMessageSegments(source)) {
      if (seg?.type !== 'forward') continue;
      const id = forwardIdFromData(seg.data || {});
      if (!id || tried.has(id)) continue;
      tried.add(id);
      const nodes = await getNodes({ id });
      if (nodes) return nodes;
    }
    return null;
  };
  const immediate = await fromSegments(message);
  if (immediate) return immediate;

  let current = null;
  try { current = await onebot.getMsg(mid); }
  catch (error) { failures.push(`读取转发卡片失败：${String(error?.message ?? error)}`); }
  if (current) {
    // 校验失败必须直接拒绝，不能通过 message_id 回退绕过。
    assertMessageScope(current, mid, chatKey, onebot.selfId);
    const refreshed = await fromSegments(current.message ?? current.raw_message);
    if (refreshed) return refreshed;
  }
  const fallback = await getNodes({ message_id: mid });
  if (fallback) return fallback;
  throw new Error(`无法读取该合并转发：${[...new Set(failures)].join('；') || '没有可用内容'}`);
}
