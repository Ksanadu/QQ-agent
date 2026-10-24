// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    // QQ 原生收藏身份（add_custom_face 的 emoji_id）：入了 QQ 收藏的条目靠它
    // 做幂等补录、备注回写（modify_custom_face）与长效地址回查。
    emojiId: String(entry.emojiId || '').trim(),
    // 消息里的协议端缓存文件 id：转存失败后的重试线索（get_image 认它）。
    qqFile: String(entry.qqFile || '').trim(),
    // 本地转存产物（file:///）。搬家自愈后由 healLocalPaths 重写。
    localFile: String(entry.localFile || '').trim(),
    // 本地转存失败标记：提示这条目当前靠 url 存活（QQ 图床 rkey ~1h，僵尸预警）。
    persistFailed: entry.persistFailed === true,
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      // desc 用 || 而不是 ??：fetch 返回空串时保留本地历史备注（QQ 端某些操作会把
      // 收藏备注清空/不回传，?? 会把空串当有效值抹掉本地认知层）
      desc: String(item.desc || old?.desc || '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  // QQ 收藏是唯一事实源：同步成功后，QQ 侧已不存在的条目一律清掉——
  // 不只 source==='qq' 的，collect_sticker 收来的（source==='ai' 且已入 QQ 收藏，有 emojiId）
  // 用户在 QQ 里删掉后同样要清，否则"精简表情库"在机器人眼里永远不生效。
  // 匹配用 id 或 emojiId 两个身份（collected_ 条目的 id 不在 QQ 列表里，靠 emojiId 认亲）。
  // 只有从未入过 QQ 收藏的纯本地条目（无 emojiId）才豁免。
  return out.filter((e) => {
    if (fetchedIds.has(e.id) || (e.emojiId && fetchedIds.has(e.emojiId))) return true;
    if (e.source === 'qq') return false;
    if (e.emojiId) return false;
    return true;
  });
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    useCount: e.useCount || 0
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/**
 * 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。
 * - 展示去重：同一张图常以"QQ 原生 + collect 收录"两个身份并存（同 md5/同备注），只展示一份。
 * - 展示顺序按小时轮换播种洗牌：列表内容稳定（利于缓存），顺序每小时变一次——
 *   以前按使用次数排死序，模型总挑最前面的，是"反复发同一张"的半个根因。
 * - 默认带 id：模型照抄 id 就能 send_sticker，不用先跑一轮 list_stickers 查号。
 * rotatePeriodMin <= 0 时关闭轮换；now 仅用于测试注入稳定的轮次。
 */
export function buildStickerContext(entries, max = 10, { rotatePeriodMin = 60, now = Date.now(), withId = true } = {}) {
  const list0 = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  // 双索引去重：QQ 原生条目有 md5，收藏副本常无 md5 只有 localNote——
  // 只用单一键会漏掉"同图异身份"（md5 与 label 两个索引都要查/都要登记）。
  const kept = [];
  const byMd5 = new Map();
  const byLabel = new Map();
  const slotOf = new Map();
  const register = (e, idx) => {
    if (e.md5) byMd5.set(e.md5, e);
    const label = e.desc || e.localNote;
    if (label) byLabel.set(label, e);
    slotOf.set(e, idx);
  };
  for (const e of list0) {
    const label = e.desc || e.localNote;
    const hit = (e.md5 && byMd5.get(e.md5)) || (label && byLabel.get(label)) || null;
    if (!hit) {
      register(e, kept.length);
      kept.push(e);
      continue;
    }
    // 同图双身份：优先保留本地转存（file:///）那份
    if ((e.localFile ? 1 : 0) - (hit.localFile ? 1 : 0) > 0) {
      const idx = slotOf.get(hit);
      kept[idx] = e;
      slotOf.delete(hit);
      register(e, idx);
    }
  }
  const list = kept;
  if (!list.length) return '';
  const total = Math.max(1, Math.min(30, Number(max) || 10));
  const byUse = [...list].sort((a, b) =>
    (b.useCount || 0) - (a.useCount || 0)
    || ((b.desc || b.localNote) ? 1 : 0) - ((a.desc || a.localNote) ? 1 : 0)
    || String(a.id).localeCompare(String(b.id))
  );

  const period = Math.max(0, Number(rotatePeriodMin)) * 60000;
  const round = period > 0 ? Math.floor(Number(now) / period) : 0;
  const seededShuffle = (arr, salt) => {
    let seed = (round ^ salt) >>> 0;
    for (const e of arr) for (const ch of String(e.id)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    if (seed === 0) seed = 0x9e3779b9;
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      const j = seed % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  let selected;
  if (list.length > total) {
    const stableCount = Math.max(1, Math.floor(total / 2));
    const stable = byUse.slice(0, stableCount);
    const stableIds = new Set(stable.map((e) => e.id));
    const pool = list.filter((e) => !stableIds.has(e.id)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    selected = [...stable, ...seededShuffle(pool, 0x1234).slice(0, total - stableCount)];
  } else {
    selected = seededShuffle(list, 0x5678);
  }

  const lines = selected.map((e) => {
    const label = e.desc || e.localNote || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    // 不展示使用次数：真实计数每发一次表情就 +1，写进提示词会让【可用表情包】
    // 段每次运行都变（把它后面的全部段落挤出缓存前缀）。模型只需要知道
    // "有哪些表情"（useCount 仍参与排序与轮换挑选，只是不进文本）。
    const id = withId ? ` id=${e.id}` : '';
    return `- ${label}${extra}${id}`;
  });
  return `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个表情（以下为常用/轮换的 ${selected.length} 个，完整列表可用 list_stickers 查询）：\n${lines.join('\n')}`;
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint(level = 1) {
  // 活跃度引导放在系统提示的策略段里（而不是"本次输入"的【表情包用法】）——
  // 同一主题两处引导会左右脑互搏（Kondius 2026-09-07）：策略讲时机、档位讲频率，
  // 合并成一处由档位直接改写频率行。
  // ⚠️ 索引严格对应 0~3 档，与 ui 的 STICKER_LEVELS 一致。
  const freqByLevel = [
    '频率（0 档·不鼓励，<10%）：纯文字回应是绝对常态，绝大多数时候不发表情；只有极其贴切或无话可说时才偶尔单发一张。',
    '频率（1 档·偶尔，约 20%~30%）：绝大多数时候只发纯文字文本（约七八成）；大约每 4~5 轮对话中才偶尔配一张贴切表情包，普通闲聊不要频繁带图。',
    '频率（2 档·适度，约 50%）：约有一半时候只发纯文字，另一半（在有明显情绪起伏、反讽、接梗、卖萌或特别应景时）才配表情包（约 50% 概率）。绝不是每条发言都要配表情，禁止逢发必带。',
    '频率（3 档·积极，约 80%）：你是表情包爱好者，大部分时候可以配图（约 75%~80% 概率），接梗/调侃时多带一张；但普通简短接话时依然允许纯文字，不要机械式每条必发。'
  ][Math.min(3, Math.max(0, Number(level) || 0))];
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    `- ${freqByLevel}`,
    '- 选择：闲聊/玩梗/接梗从备注或标签带「随便发」的万能可爱图里挑；要怼人/回击/对线/阴阳怪气时，从带「怼人」标签的里面挑。两个池子都换着发，别连续两张都是同一个；没有匹配/不确定的表情，先 get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 send_sticker（一条消息只能是一张表情，不能在同一气泡里附带文字）。如果你本轮决定配表情包且同时有话要说，可在同一轮同时调用 send_sticker 和 send_message；如果你决定不发表情，直接只调用 send_message 即可——绝不要把表情包当成发言标配，大部分时候纯文字交流最自然。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
