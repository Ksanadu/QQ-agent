// 表情库管家（LLM 型 / skills/）
//
// 给模型两个"管理自己表情库"的工具（注册后模型看到的名字带技能前缀）：
//   sticker-librarian__audit           盘点家底：总数、用了多少次、哪些没备注、哪些重复
//   sticker-librarian__delete_sticker  从 QQ 收藏里真删（先预览、确认后才删）
//
// 为什么是技能而不是插件：要不要整理、什么时候整理、哪些算"重复/不合适"，
// 全靠模型理解用户的自然语言（"把你表情库清一清"）才能判断，规则写不死 ——
// 按项目判据属于 LLM 型。分类整理（补 tags/usage）不另造工具，直接用核心
// 已有的 sticker_note，避免同一件事两套写法。
//
// ── 三个关键机制（不按这个来会静默失效或出事）──────────────────────────────
// ① 删除必须真删 QQ：本地 stickers.json 只是"认知层"，每轮都会和 QQ
//    (fetch_custom_face_detail) 同步，且 stickers.js 的 mergeStickerLibrary
//    会把"本地没有、QQ 还在"的表情**重新加回来**。所以只删本地 = 几十秒后
//    原地复活。这里调 delete_custom_face 删 QQ，成功后同步清本地条目。
// ② 表情的 QQ 身份是 emojiId，不是 id：delete_custom_face 只认 emojiId。
//    没进 QQ 收藏的条目（纯本地/僵尸条目）没有 emojiId，删不掉 QQ，
//    这种情况如实返回，不假装删成功。
// ③ 删除先预览后执行：第一次调用只出清单，模型必须拿去问用户，拿到明确同意
//    才允许传 confirm=true。危险操作的责任边界放在用户这边。
//    （对比：collect_sticker 是"收藏"，错了无害；删除不可恢复，必须多一道闸。）

// ⚠️ 相对导入层级：本文件在 <app>/skills/<id>/index.js，核心模块在 <app>/src/，
//    所以到 src 是 **../../src/**（skills/ 与 plugins/ 在 app/ 下同级）。
//    层级数错 = import 直接抛 ERR_MODULE_NOT_FOUND，技能页显示"加载失败"。
import { findSticker, loadStickerStore, saveStickerStore } from '../../src/stickers.js';

/** 出厂默认值（与 skill.json 的 settings 对齐）。 */
const DEFAULTS = {
  enabled: true,
  maxAuditList: 120,
  unlabeledSample: 10,
  maxDeletePerCall: 20
};

let api = null;

/** 读取本技能设置（缺省值兜底）。 */
function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

/** 展示名：QQ 备注优先，其次本地笔记，最后退回 id。 */
function labelOf(e) {
  return String(e?.desc || e?.localNote || '').trim() || `(无备注 id=${e?.id ?? '?'})`;
}

/** 这些条目用于运行的窗口里禁止复活（对齐本轮同步口径，避免刚删完又被合回来）。 */
const deletedThisRun = new Set();

/** 从运行上下文取表情库条目：优先管理器（最新、带 URL 自愈），失败退回磁盘快照。 */
async function loadEntries(ctx, { force = false } = {}) {
  let note = '';
  let entries = [];
  try {
    const synced = await ctx.stickers.sync(force);
    entries = Array.isArray(synced?.entries) ? synced.entries : [];
    if (synced?.error) note = `（同步 QQ 失败，用的是本地缓存：${synced.error}）`;
    else if (synced?.disabled) note = '（表情包功能已在设置里关闭，下面是本地缓存）';
  } catch (error) {
    note = `（读取表情库失败，已退回本地快照：${error?.message ?? error}）`;
  }
  if (!entries.length) {
    try {
      entries = loadStickerStore().filter((e) => !deletedThisRun.has(String(e.id)));
      if (entries.length) note = `${note}（已退回磁盘快照）`;
    } catch { /* 彻底拿不到就当空库，下面的报告会说明 */ }
  }
  return { entries, note };
}

/**
 * 重复判定键。
 * ① md5 相同 = 同一张图（最可靠）；
 * ② 没有 md5 时退回"备注完全相同"——会误报少许（两张不同图被写了同一句备注），
 *    所以报告里明确写了这层口径，由模型自己再判断，不当作硬结论。
 */
function dupKeyOf(e) {
  const md5 = String(e?.md5 || '').trim().toUpperCase();
  if (md5) return `md5:${md5}`;
  const text = String(e?.desc || e?.localNote || '').trim();
  return text ? `desc:${text}` : '';
}

/** 僵尸条目：只剩一条会过期的直链（没本地转存、也没进 QQ 收藏）。 */
function isZombie(e) {
  if (e?.emojiId) return false;
  if (String(e?.url || '').toLowerCase().startsWith('file:///')) return false;
  return e?.persistFailed === true;
}

function toItem(e, { withUrl = false } = {}) {
  const item = {
    id: e.id,
    label: labelOf(e),
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    usage: e.usage || '',
    useCount: e.useCount || 0,
    lastUsedAt: e.lastUsedAt || 0,
    inQQ: Boolean(e.emojiId),
    localCopy: Boolean(e.localFile)
  };
  if (withUrl) item.url = e.url || '';
  if (isZombie(e)) item.warning = '这条只剩一条会过期的直链（QQ 图床约 1 小时失效），可能已经发不出去了';
  return item;
}

/** 生成给模型看的人话报告（模型照抄给用户，避免它自己瞎统计）。 */
function buildReport(stats, { total, withId, unlabeledSample }) {
  const lines = [];
  const mb = (n) => `${Math.round(n / 1024 / 1024 * 10) / 10} MB`;
  lines.push(`【表情库盘点】总共 ${total} 张：有备注 ${stats.labeled} 张，没备注 ${stats.unlabeled} 张。`);
  if (stats.inQQ) lines.push(`其中已在 QQ 收藏里的 ${stats.inQQ} 张（这些才能真正删掉）；纯本地/无 QQ 身份的 ${stats.notInQQ} 张。`);
  if (stats.zombie) lines.push(`僵尸条目 ${stats.zombie} 张：只剩会过期的直链，很可能已经发不出去（建议重收藏或删掉）。`);
  lines.push(`使用情况：从来没用过的 ${stats.neverUsed} 张；用过 1 次以上 ${stats.used} 张。`);
  lines.push(`重复情况：疑似重复 ${stats.dupGroups} 组、涉及 ${stats.dupEntries} 张。`
    + (stats.dupBasis === 'desc' ? '（这批没有 md5，是按「备注完全相同」判的，可能误报，请再核对一下）' : '（按图片 md5 判定，可靠）'));

  const tagEntries = Object.entries(stats.tagCount).sort((a, b) => b[1] - a[1]);
  if (tagEntries.length) {
    lines.push(`现有分类标签：${tagEntries.map(([t, c]) => `${t}(${c})`).join('、')}`);
  } else {
    lines.push('现有分类标签：一个都没有——也就是说表情库还没按用途分过类。');
  }

  if (stats.top?.length) {
    lines.push(`用得最多的几张：${stats.top.map((e) => `${labelOf(e)}×${e.useCount || 0}`).join('、')}`);
  }

  // 待办提示：让模型知道下一步该干什么，而不是把报告念一遍就完事
  const todo = [];
  if (stats.unlabeled) todo.push(`${stats.unlabeled} 张没备注（可先 get_sticker_image 看图再 sticker_note 补上）`);
  if (!tagEntries.length && total) todo.push('整体还没分类（建议先和用户约定一套用途标签，再批量补 tags）');
  if (stats.dupGroups) todo.push(`${stats.dupGroups} 组疑似重复（要删的话走 delete_sticker 预览 → 用户确认）`);
  if (stats.zombie) todo.push(`${stats.zombie} 张僵尸条目`);
  if (todo.length) lines.push(`待处理：${todo.join('；')}。`);

  if (unlabeledSample.length) {
    lines.push(`抽查 ${unlabeledSample.length} 张没备注的：${unlabeledSample.map((e) => `id=${e.id}`).join('、')}`
      + '（想看内容就用 get_sticker_image 逐个看）。');
  }

  if (withId.length) {
    lines.push('');
    lines.push(`全部清单（id 可直接用于 sticker_note / delete_sticker）：\n${withId.join('\n')}`);
  } else if (total) {
    lines.push('（本次没附完整清单；要清单就再调一次并让 includeList 不为 false。）');
  }
  return lines.join('\n');
}

export function setup(a) {
  api = a;

  // ① 盘点家底
  api.registerTool({
    id: 'audit', readOnly: true,
    name: '盘点表情库',
    description: '查清表情库的家底：总共多少张、哪些没备注、哪些是重复的、哪些没用过、按用途分了几类。想整理表情库、或用户问"你表情库里都有什么/有多少张"时先用它。返回里带现成的清单文字，直接照着告诉用户即可，不要自己另算。',
    category: 'sticker',
    icon: '📊',
    parameters: {
      type: 'object',
      properties: {
        includeList: { type: 'boolean', description: '是否附上完整清单（默认 true）。只想要数量统计时传 false，省 token。' },
        limit: { type: 'integer', description: '清单最多列几张（默认取设置里的值，上限 300）' },
        onlyUnlabeled: { type: 'boolean', description: '只看没备注的表情（默认 false）' },
        onlyDuplicates: { type: 'boolean', description: '只看疑似重复的表情（默认 false）' }
      }
    },
    async execute(ctx, args) {
      try {
        if (settings().enabled === false) return err('表情库管家已被关闭（可在设置 → 技能 里打开）');
        const { entries, note } = await loadEntries(ctx, { force: true });
        if (!entries.length) {
          return ok({ total: 0, report: `【表情库盘点】表情库现在是空的${note}。` + (note ? '' : '（如果 QQ 里明明有收藏，检查一下设置里的「启用表情包」是否开启）') });
        }

        const s = settings();
        const listLimit = Math.max(1, Math.min(300, Math.round(num(args.limit, num(s.maxAuditList, DEFAULTS.maxAuditList)))));
        const sampleLimit = Math.max(0, Math.min(50, Math.round(num(s.unlabeledSample, DEFAULTS.unlabeledSample))));

        const unlabeled = entries.filter((e) => !String(e.desc || e.localNote || '').trim());
        const labelSet = (e) => {
          const tags = Array.isArray(e.tags) ? e.tags.filter(Boolean) : [];
          const usage = String(e.usage || '').trim();
          return usage && !tags.includes(usage) ? [...tags, usage] : tags;
        };
        const tagged = entries.filter((e) => labelSet(e).length > 0);

        const groups = new Map();
        for (const e of entries) {
          const key = dupKeyOf(e);
          if (!key) continue;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(e);
        }
        const dupGroupsAll = [...groups.values()].filter((g) => g.length > 1);
        const dupBasis = dupGroupsAll.length && dupGroupsAll.every((g) => g[0].md5) ? 'md5' : 'desc';
        const dupIds = new Set(dupGroupsAll.flat().map((e) => String(e.id)));

        // 僵尸：没有 QQ 身份、也没有本地副本
        const zombies = entries.filter(isZombie);
        const inQQ = entries.filter((e) => e.emojiId);

        const stats = {
          labeled: entries.length - unlabeled.length,
          unlabeled: unlabeled.length,
          tagged: tagged.length,
          inQQ: inQQ.length,
          notInQQ: entries.length - inQQ.length,
          zombie: zombies.length,
          neverUsed: entries.filter((e) => !(e.useCount > 0)).length,
          used: entries.filter((e) => e.useCount > 0).length,
          dupGroups: dupGroupsAll.length,
          dupEntries: dupIds.size,
          dupBasis,
          tagCount: [...new Set(entries.flatMap(labelSet))].reduce((acc, t) => {
            acc[t] = entries.filter((e) => labelSet(e).includes(t)).length;
            return acc;
          }, {})
        };

        // 清单排序：用得多的、用得近的排前面（模型最需要先看到这些）
        let pool = entries;
        if (args.onlyUnlabeled === true) pool = unlabeled;
        if (args.onlyDuplicates === true) pool = pool.filter((e) => dupIds.has(String(e.id)));
        const sorted = [...pool].sort((a, b) =>
          (b.useCount || 0) - (a.useCount || 0) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0)
        );
        const shown = sorted.slice(0, listLimit);
        const item = (e) => `- id=${e.id}${e.desc ? ` QQ备注「${e.desc}」` : ''}`
          + (e.localNote && e.localNote !== e.desc ? ` 笔记「${e.localNote}」` : '')
          + (labelSet(e).length ? ` [${labelSet(e).join('/')}]` : '')
          + ` 用过${e.useCount || 0}次`
          + (e.emojiId ? '' : '（无QQ身份，删不掉QQ侧）');
        const withId = shown.map(item);

        // 抽查没备注的（模型可以顺手看图补备注）
        const sample = unlabeled.slice(0, sampleLimit).map((e) => toItem(e));

        const report = buildReport(stats, { total: entries.length, withId: args.includeList === false ? [] : withId, unlabeledSample: sample });
        return ok({
          total: entries.length,
          labeled: stats.labeled,
          unlabeled: stats.unlabeled,
          inQQ: stats.inQQ,
          zombie: stats.zombie,
          neverUsed: stats.neverUsed,
          duplicateGroups: dupGroupsAll.map((g) => ({
            basis: g[0].md5 ? 'md5' : '同上备注',
            ids: g.map((e) => e.id),
            labels: g.map(labelOf)
          })),
          unlabeledSample: sample,
          listTruncated: sorted.length > shown.length,
          ...(note ? { note } : {}),
          report
        });
      } catch (error) {
        return err(`盘点表情库失败：${error?.message ?? error}`);
      }
    }
  });

  // ② 删除表情（真删 QQ 收藏，先预览后执行）
  api.registerTool({
    id: 'delete_sticker',
    name: '删除表情',
    description: '把表情从 QQ 收藏里删除（不可恢复）。必须两步走：第一次只传 stickerIds（不传 confirm）拿到预览清单，把这批要删的用大白话说给用户听、等用户明确同意；用户明确同意后，带同一批 stickerIds 和 confirm=true 执行删除。用户没同意就绝不要传 confirm。id 从 sticker_audit 或 list_stickers 拿。',
    category: 'sticker',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        stickerIds: {
          description: '要删的表情 id，可传一个字符串或字符串数组（照抄 sticker_audit / list_stickers 返回的 id，不要自己编）',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
        },
        reason: { type: 'string', description: '为什么删（一句话，会写进记录，也提醒你自己复核）' },
        confirm: { type: 'boolean', description: '是否确认执行。默认 false = 只预览不删；true = 用户确认后执行删除' }
      },
      required: ['stickerIds']
    },
    async execute(ctx, args) {
      try {
        if (settings().enabled === false) return err('表情库管家已被关闭（可在设置 → 技能 里打开）');

        const raw = Array.isArray(args.stickerIds) ? args.stickerIds : [args.stickerIds];
        const wanted = raw.map((x) => String(x ?? '').trim()).filter(Boolean);
        if (!wanted.length) return err('没有给 stickerIds。先从 sticker_audit 或 list_stickers 里拿到 id 再传进来。');
        if (wanted.length > 200) return err('一次给了太多 id（上限 200），请分批处理。');

        const { entries, note } = await loadEntries(ctx, { force: true });
        if (!entries.length) return err(`读不到表情库条目，无法删除${note}`);

        const resolved = [];
        const unknown = [];
        for (const ref of wanted) {
          const hit = findSticker(entries, ref);
          if (!hit) { unknown.push(ref); continue; }
          if (!resolved.some((e) => e.id === hit.id)) resolved.push(hit);
        }
        if (!resolved.length) {
          return err(`这些 id 在表情库里都找不到：${unknown.join('、')}。请先用 sticker_audit 拿准确 id（id 要照抄，不要改）。`);
        }

        const maxDel = Math.max(1, Math.round(num(settings().maxDeletePerCall, DEFAULTS.maxDeletePerCall)));
        if (resolved.length > maxDel) {
          return err(`一次要删 ${resolved.length} 张，超过上限 ${maxDel} 张（设置 → 技能 → 表情库管家 可调）。请让用户分批确认，或先删最确定的那几张。`);
        }

        const preview = resolved.map((e) => toItem(e));

        // 预览：只出清单，绝不删
        if (args.confirm !== true) {
          const lines = resolved.map((e, i) => `${i + 1}. ${labelOf(e)}`
            + (e.desc ? `（QQ备注「${e.desc}」）` : '')
            + ` id=${e.id} 用过${e.useCount || 0}次`
            + (e.emojiId ? '' : ' ⚠️无QQ身份'));
          return ok({
            dryRun: true,
            count: resolved.length,
            stickers: preview,
            ...(unknown.length ? { unknownIds: unknown } : {}),
            next: '这是预览，还什么都没删。请把这批表情用大白话说给用户听（说名字，不要丢 id），明确问"这几张确定删掉吗"，等用户同意后再带同一批 stickerIds 调一次并传 confirm=true。',
            previewText: `准备删除这 ${resolved.length} 张（还没删）：\n${lines.join('\n')}`
          });
        }

        const results = [];
        for (const entry of resolved) {
          if (!entry.emojiId) {
            results.push({ id: entry.id, deleted: false, error: '没有 QQ 收藏身份，无法删除' });
            continue;
          }
          try {
            ctx.assertEffectAllowed?.();
            await ctx.onebot.call('delete_custom_face', { emoji_id: String(entry.emojiId) }, null, { beforeSend: ctx.assertEffectAllowed });
            deletedThisRun.add(String(entry.id));
            ctx.stickers.entries = (ctx.stickers.entries || entries).filter((e) => e.id !== entry.id && String(e.emojiId) !== String(entry.emojiId));
            results.push({ id: entry.id, deleted: true });
          } catch (error) {
            results.push({ id: entry.id, deleted: false, error: error.message });
          }
        }
        let cleanupWarning;
        if (results.some((r) => r.deleted)) {
          try { saveStickerStore(ctx.stickers.entries); }
          catch (error) { cleanupWarning = `QQ 已删除，本地缓存保存失败：${error.message}`; }
        }
        return ok({ deleted: results.filter((r) => r.deleted).length, results, ...(cleanupWarning ? { cleanupWarning } : {}), ...(unknown.length ? { unknownIds: unknown } : {}) });
      } catch (error) {
        return err(`删除表情失败：${error?.message ?? error}`);
      }
    }
  });
}

/** 技能是否生效：设置里 enabled 没关就生效。 */
export function available() {
  return settings().enabled !== false;
}

export function activate() {
  api?.log?.('表情库管家已启用：模型可盘点表情库（audit）并从 QQ 收藏中删除表情（delete_sticker，需用户确认）');
}

export function deactivate() {
  deletedThisRun.clear();
}
