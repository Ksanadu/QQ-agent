import { hasMessageId } from './text-delivery.js';

// Only confirmed current-chat text with no incomplete batch grants completion.
const states = new WeakMap();
function state(ctx) {
  if (!states.has(ctx)) states.set(ctx, {});
  return states.get(ctx);
}
export function beginReplyCompletion(ctx) {
  states.delete(ctx);
  ctx.session.completion = {requiredTool: 'send_message', delivered: false, recoveryUsed: false};
}
export function advanceReplyCompletion(ctx) {
  const current = state(ctx);
  delete current.partial;
  delete current.delivered;
  ctx.session.completion.delivered = false;
  delete ctx.session.completion.pendingParts;
}
export function confirmedTextReceipts(receipts) {
  return (receipts || []).filter(r => r && !r.deduped && hasMessageId(r.messageId) && String(r.text || '').trim());
}
export function pendingTextDelivery(ctx) {
  return state(ctx).partial || null;
}
export function recordSendMessageDelivery(ctx, receipts, partial = null) {
  const current = state(ctx);
  if (confirmedTextReceipts(receipts).length) current.delivered = { version: ctx.modelVersion };
  current.partial = partial;
  ctx.session.completion = {
    ...ctx.session.completion, requiredTool: 'send_message', delivered: hasSendMessageDelivery(ctx),
    ...(partial && { pendingParts: partial.indices.map(i => i + 1) })
  };
  if (!partial) delete ctx.session.completion.pendingParts;
}
export function hasSendMessageDelivery(ctx) {
  const current = state(ctx);
  return !!current.delivered && current.delivered.version === ctx.modelVersion && !current.partial && !ctx.session.deliveryUnconfirmed;
}
export const DELIVERY_REQUIRED = '本次会话尚未通过 send_message 向当前聊天实际发送成功，不能完结。贴表情、拍一拍、发图、跨会话发送和普通输出均不能替代。请用 send_message 回复当前请求；依据不足时如实说明，不编造结论。';
export const DELIVERY_UNCONFIRMED = 'QQ 未能确认文字送达，已停止本轮发送，避免重复。';
export const TEXT_PARTS_PENDING = '这批文字仍有分段明确发送失败。请调用 send_message，传 retryFailed:true，仅补发失败分段，不要重发已送达的文字。';
export function deliveryRequired(ctx) {
  return ctx.session.deliveryUnconfirmed ? DELIVERY_UNCONFIRMED : pendingTextDelivery(ctx) ? TEXT_PARTS_PENDING : DELIVERY_REQUIRED;
}
