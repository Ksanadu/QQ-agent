// A successful side effect is not necessarily a delivered answer. Only the
// built-in send_message tool can grant normal completion to this run context.
const delivered = new WeakMap();
export function beginReplyCompletion(ctx) {
  delivered.delete(ctx);
  ctx.session.completion = {requiredTool: 'send_message', delivered: false, recoveryUsed: false};
}
export function recordSendMessageDelivery(ctx, receipts) {
  if (!Array.isArray(receipts) || !receipts.some(r => r && !r.deduped && String(r.text || '').trim())) return false;
  delivered.set(ctx, ctx.modelVersion);
  ctx.session.completion = {...ctx.session.completion, requiredTool: 'send_message', delivered: true};
  return true;
}
export const hasSendMessageDelivery = ctx => delivered.has(ctx) && delivered.get(ctx) === ctx.modelVersion;
export const DELIVERY_REQUIRED = '本次会话尚未通过 send_message 向当前聊天实际发送成功，不能完结。贴表情、拍一拍、发图、跨会话发送和普通输出均不能替代。请用 send_message 回复当前请求；依据不足时如实说明，不编造结论。';
