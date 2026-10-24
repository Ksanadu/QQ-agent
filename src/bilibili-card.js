import { safeFetchBinary } from './safe-fetch.js';
async function fetchVideoMetadata(url) {
  const cap = 2 * 1024 * 1024;
  const { buffer } = await safeFetchBinary(url, cap);
  if (buffer.length >= cap) throw new Error('B站视频资料超过大小上限');
  return { statusCode: 200, body: buffer.toString('utf8'), truncated: false };
}

export function biliVideoId(value) {
  const text = String(value).trim();
  if (/^BV[a-zA-Z0-9]{10}$/.test(text)) return { bvid: text };
  if (/^av[1-9]\d*$/i.test(text)) return { aid: text.slice(2) };
  let url; try { url = new URL(text); } catch { throw new Error('请输入 BV号、av号或完整 B站视频链接'); }
  if (!['https:','http:'].includes(url.protocol) || !['www.bilibili.com','bilibili.com','m.bilibili.com'].includes(url.hostname) || url.username || url.password) throw new Error('不是有效的 B站视频链接');
  const id = /^\/video\/(BV[a-zA-Z0-9]{10}|av[1-9]\d*)\/?$/.exec(url.pathname)?.[1];
  if (!id) throw new Error('链接中没有有效的视频号；短链接请先查询视频拿到 BV号');
  return biliVideoId(id);
}

export async function getBiliVideo(value, fetcher = fetchVideoMetadata) {
  const id = biliVideoId(value);
  const result = await fetcher('https://api.bilibili.com/x/web-interface/view?' + new URLSearchParams(id));
  if (result.statusCode !== 200 || result.truncated) throw new Error('B站视频资料请求失败');
  const response = JSON.parse(result.body), data = response.data;
  if (response.code !== 0 || !data?.title || !/^BV[a-zA-Z0-9]{10}$/.test(data.bvid) || (id.bvid && data.bvid !== id.bvid) || (id.aid && String(data.aid) !== id.aid)) throw new Error('B站视频不存在或资料不可用');
  let cover = ''; try { const u = new URL(data.pic); if (['http:','https:'].includes(u.protocol) && /(^|\.)hdslb\.com$/.test(u.hostname)) cover = u.href; } catch { /* optional preview */ }
  return { bvid: data.bvid, title: String(data.title).slice(0, 200), author: String(data.owner?.name || '').slice(0, 80), cover, url: 'https://www.bilibili.com/video/' + data.bvid };
}

export function fallbackBiliCard(video) {
  return { app: 'com.tencent.structmsg', desc: '新闻', view: 'news', ver: '0.0.0.1', prompt: '[分享] ' + video.title,
    config: { type: 'normal', forward: 1 }, meta: { news: { tag: '哔哩哔哩', title: video.title, desc: video.author, preview: video.cover, jumpUrl: video.url } } };
}

export async function shareBiliVideo(ctx, value, lookup = getBiliVideo) {
  const video = await lookup(value);
  let card;
  try {
    const result = await ctx.onebot.call('get_mini_app_ark', { type: 'bili', title: video.title, desc: video.author, picUrl: video.cover, jumpUrl: video.url });
    const raw = result?.ark ?? result?.json ?? result?.data ?? result;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed?.app || !parsed?.meta) throw new Error('QQ 卡片格式无效');
    card = parsed;
  } catch { card = fallbackBiliCard(video); }
  const sent = await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'json', data: { data: JSON.stringify(card) } }],
    { label: `[B站视频卡片] ${video.title} ${video.url}`, dedupeKey: 'bilibili:' + video.bvid });
  return { sent: true, messageId: sent.message_id, video };
}
