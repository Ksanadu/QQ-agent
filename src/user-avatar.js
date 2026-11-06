import { safeFetchBinary } from './safe-fetch.js';
import { detectMime } from './image-type.js';

const qqId = value => /^[1-9]\d{4,9}$/.test(String(value ?? '')) ? String(value) : '';
const leadingMention = /^\uE000(\d{5,10})\uE001\s*/;
const politePrefix = /^(?:请(?:你)?|麻烦(?:你)?|能不能|可不可以|可以|你能|帮我|给我|你)\s*/u;
const request = /^(?:看(?:看|一下|下|一眼)?|瞧(?:瞧|一下|一眼)?|查看|评价(?:一下|下)?|点评(?:一下|下)?|分析(?:一下|下)?|描述(?:一下|下)?|识别(?:一下|下)?)[\s：:]*/u;
const subject = /^(.*?)\s*(?:QQ\s*)?头像\s*(是谁|是什么(?:图|角色|人物)?|是哪个(?:角色|人物)|长什么样|怎么样|好不好看|好看吗)?[吧呀啊嘛呗吗么]*[？?！!。．.]*$/iu;
const selfWords = /^(?:我(?:自己)?|本人)(?:的)?$/u;
const replyWords = /^(?:他|她|TA|这人|那人|这个人|那个人|被引用的人|引用消息的作者|这位|那位)(?:的)?$/iu;
const directMention = /^\uE000(\d{5,10})\uE001\s*的?$/;

// Match direct requests only, using the actual text/mention segments. Quote
// bodies, forwarded content and nicknames never supply the request or a QQ ID.
export function bindAvatarRequest({ segments, senderId, botId, reply }) {
  if (!Array.isArray(segments)) return null;
  let body = '';
  const quoteIds = [];
  for (const seg of segments) {
    if (seg?.type === 'text') {
      body += String(seg.data?.text ?? '').replace(/[\uE000\uE001]/g, '\uFFFD');
    } else if (seg.type === 'at') {
      const id = qqId(seg.data?.qq);
      if (!id) return null;
      body += `\uE000${id}\uE001`;
    } else if (seg?.type === 'reply') {
      quoteIds.push(String(seg.data?.id ?? ''));
    } else {
      return null;
    }
  }
  body = body.trim();
  if (body.length > 256) return null;
  const leading = new Set();
  for (let m; (m = leadingMention.exec(body)); body = body.slice(m[0].length)) {
    if (m[1] !== String(botId)) leading.add(m[1]);
  }
  // Also allow a direct question about a clearly named target's avatar.
  let directive = body;
  for (let i = 0; i < 8 && politePrefix.test(directive); i++) directive = directive.replace(politePrefix, '');
  const verb = request.exec(directive);
  const m = subject.exec(verb ? directive.slice(verb[0].length) : body);
  // Use the same question match for recognition and parsing, so direct
  // questions cannot be dropped by a separate, narrower allowlist.
  if (!m || (!verb && !m[2])) return null;
  const target = m[1].trim();
  const id = selfWords.test(target) ? qqId(senderId)
    : /^你(?:的)?$/u.test(target) ? qqId(botId)
    : directMention.exec(target)?.[1];
  if (id) return id;
  if (target && !replyWords.test(target) && !(target === '的' && leading.size)) return null;
  if (quoteIds.length && (quoteIds.length !== 1 || !reply?.resolved || String(reply.messageId) !== quoteIds[0])) return null;
  const quoted = quoteIds.length ? qqId(reply.senderId) : '';
  if (quoted) leading.add(quoted);
  return leading.size === 1 ? [...leading][0] : null;
}

export function avatarTargetForMessage(entries, requestMessageId) {
  if (!['number', 'string'].includes(typeof requestMessageId) || !/^-?\d+$/.test(String(requestMessageId)) || !Number.isSafeInteger(Number(requestMessageId))) return null;
  const matches = (entries || []).filter(e => !e.self && !e.recalled && String(e.mid) === String(requestMessageId));
  return matches.length === 1 ? qqId(matches[0].avatarTargetId) || null : null;
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
