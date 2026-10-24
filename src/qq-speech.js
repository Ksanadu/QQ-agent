// Use QQ's own speech recognition. No downloaded audio or local ASR model.
const pendingByClient = new WeakMap();
export async function transcribeQQVoice(onebot, messageId) {
  const id = String(messageId ?? '');
  if (!/^-?[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('语音消息 ID 无效');
  if (!onebot?.call) throw new Error('QQ 接口未连接');
  let cache = pendingByClient.get(onebot);
  if (!cache) { cache = new Map(); pendingByClient.set(onebot, cache); }
  const old = cache.get(id);
  if (old && old.until > Date.now()) return old.promise;
  const promise = (async () => {
    const result = await onebot.call('fetch_ptt_text', { message_id: Number(id) }, 20000);
    const text = String(result?.text ?? '').trim();
    if (!text) throw new Error('QQ 未返回语音识别文本');
    return text.slice(0, 12000);
  })();
  cache.set(id, { promise, until: Date.now() + 5 * 60 * 1000 });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  try { return await promise; } catch (e) { cache.delete(id); throw e; }
}
