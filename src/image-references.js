import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectImageType } from './image-type.js';
import { safeFetchBinary, browseLockState } from './safe-fetch.js';
import { imageSourcesFromMessage, MAX_REFERENCE_IMAGES } from './image-commands.js';

export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_REFERENCE_BYTES = 24 * 1024 * 1024;
const failure = (message) => Object.assign(new Error(message), { userMessage: message + ' 本次未消耗每日额度。' });

function assertReplyScope(message, chatKey, selfId, knownHere) {
  const [kind, id] = chatKey.split(':');
  if (message?.message_type && message.message_type !== kind) throw failure('引用图片不属于当前会话。');
  if (kind === 'group' && message?.group_id != null) {
    if (String(message.group_id) !== id) throw failure('引用图片不属于当前群聊。');
    return;
  }
  if (kind === 'private') {
    if (message?.group_id != null) throw failure('不能在私聊中读取群聊引用图片。');
    const sender = String(message?.sender?.user_id ?? message?.user_id ?? '');
    const target = String(message?.target_id ?? '');
    if (sender === id && message?.message_type === 'private') return;
    if (sender === String(selfId) && target === id) return;
    if (target && target !== String(selfId) && target !== id) throw failure('引用图片不属于当前私聊。');
  }
  if (!knownHere) throw failure('无法确认引用图片来自当前会话，请把图片和 /generate 命令一起发送。');
}

async function boundedLocalImage(file) {
  let local = String(file || '');
  if (local.startsWith('file:')) local = fileURLToPath(local);
  if (!path.isAbsolute(local)) return null;
  const fd = await fs.open(local, 'r');
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || !stat.size) return null;
    if (stat.size > MAX_REFERENCE_BYTES) throw failure('参考图超过单张 10 MB 的限制。');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await fd.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > stat.size) throw failure('参考图读取时发生变化，请重新发送。');
    return buffer.subarray(0, size);
  } finally { await fd.close(); }
}

async function loadOneImage(source, onebot, signal, download) {
  signal?.throwIfAborted();
  const urls = [];
  if (source.url) urls.push(source.url);
  if (/^https?:\/\//i.test(source.file)) urls.push(source.file);
  // Only opaque OneBot file IDs may reach get_image. Never pass user-supplied disk paths.
  if (source.file && !/[\\/:]/.test(source.file) && !source.file.includes('..')) {
    try {
      const info = await onebot.call('get_image', { file: source.file });
      signal?.throwIfAborted();
      if (info?.url) urls.unshift(String(info.url));
      const cached = info?.file || info?.filename;
      if (cached) {
        try { const buffer = await boundedLocalImage(cached); if (buffer) return buffer; }
        catch (error) { if (error.userMessage) throw error; }
      }
    } catch (error) { if (signal?.aborted || error.userMessage) throw error; }
  }
  for (const url of new Set(urls)) {
    signal?.throwIfAborted();
    try {
      const { buffer } = await download(url, MAX_REFERENCE_BYTES, { browseLocked: browseLockState().enabled });
      signal?.throwIfAborted();
      return buffer;
    } catch (error) { if (signal?.aborted) throw error; }
  }
  throw failure('参考图读取失败或链接已过期，请重新发送图片。');
}

export async function loadImageReferences({ command, chatKey, onebot, knownMessage, signal, download = safeFetchBinary }) {
  let sources = [...(command.images || [])];
  if (command.replyId != null) {
    signal?.throwIfAborted();
    const known = knownMessage?.(command.replyId);
    let message;
    try { message = await onebot.getMsg(command.replyId); }
    catch {
      if (!known) throw failure('引用消息读取失败，请重新发送参考图。');
      message = {}; // Local history already binds this message ID to the current chat.
    }
    signal?.throwIfAborted();
    assertReplyScope(message, chatKey, onebot.selfId, Boolean(known));
    let quoted = imageSourcesFromMessage(message?.message ?? message?.raw_message);
    if (!quoted.length && known) quoted = (known.media || []).filter((m) => m.kind === 'image').map(({ file, url }) => ({ file, url }));
    if (!quoted.length) throw failure('引用的消息没有可用图片，请引用图片消息或直接附图。');
    sources.push(...quoted);
  }
  sources = sources.filter((source, index) => sources.findIndex((other) =>
    other === source || (source.file && source.file === other.file) || (source.url && source.url === other.url)) === index);
  if (sources.length > MAX_REFERENCE_IMAGES) throw failure(`一次最多输入 ${MAX_REFERENCE_IMAGES} 张参考图（含引用图片）。`);
  const images = []; let total = 0;
  for (const source of sources) {
    const buffer = await loadOneImage(source, onebot, signal, download);
    const type = detectImageType(buffer);
    if (!type || !['image/png', 'image/jpeg', 'image/webp'].includes(type.mime)) throw failure('参考图只支持 PNG、JPEG 或 WebP，请转换后重新发送。');
    if (buffer.length > MAX_REFERENCE_BYTES) throw failure('参考图超过单张 10 MB 的限制。');
    total += buffer.length;
    if (total > MAX_TOTAL_REFERENCE_BYTES) throw failure('参考图总大小超过 24 MB，请压缩后重新发送。');
    images.push({ buffer, ...type });
  }
  signal?.throwIfAborted();
  return images;
}
