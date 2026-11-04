// 离线自测：不联网，用假的 Bangumi 响应把所有工具真跑一遍。
// 目的：确认「不按规范做的产物会静默失效」这件事不会发生在本技能上。
//
// 跑法：node skills/bangumi-lookup/selftest.mjs
// （非必需文件，删掉不影响技能运行。改完 index.js 想回归一下再跑它。）
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');

const dow = (new Date().getDay() + 6) % 7; // 0=周一（放送表口径）

const SEARCH = {
  total: 2,
  data: [
    { id: 400602, type: 2, name: '葬送のフリーレン', name_cn: '葬送的芙莉莲', date: '2023-09-29', platform: 'TV', eps: 28, rating: { rank: 31, score: 8.6, total: 12345 }, images: { large: 'https://lain.bgm.tv/pic/cover/l/ab/cd/400602.jpg' }, summary: '魔法使芙莉莲在勇者辛美尔死后，为了理解人类而踏上旅途。', nsfw: false },
    { id: 999999, type: 2, name: 'R18 Sample', name_cn: '', date: '2020-01-01', platform: 'OVA', eps: 2, rating: { rank: 0, score: 6.0, total: 10 }, images: {}, summary: 'x', nsfw: true }
  ]
};
const LEGACY_SEARCH = {
  results: 1,
  list: [
    { id: 400602, type: 2, name: '葬送のフリーレン', name_cn: '葬送的芙莉莲', air_date: '2023-09-29', images: { large: 'https://lain.bgm.tv/pic/cover/l/ab/cd/400602.jpg' }, rating: { score: 8.6, total: 12345 }, rank: 31, eps: 28 }
  ]
};
const CHAR_SEARCH = { data: [{ id: 9, name: 'フリーレン', type: 1, relation: '葬送のフリーレン', actors: [{ id: 8, name: '種﨑敦美' }] }] };
const PERSON_SEARCH = { data: [{ id: 8, name: '種﨑敦美', type: 1, career: ['声优', '演员'] }] };
const SUBJECT = {
  id: 400602, type: 2, name: '葬送のフリーレン', name_cn: '葬送的芙莉莲', date: '2023-09-29', platform: 'TV',
  eps: 28, total_episodes: 28, rating: { rank: 31, score: 8.6, total: 12345 },
  collection: { wish: 9000, doing: 3000, collect: 20000 },
  tags: [{ name: '奇幻', count: 5000 }, { name: '冒险', count: 3000 }, { name: '漫画改', count: 2000 }],
  images: { large: 'https://lain.bgm.tv/pic/cover/l/ab/cd/400602.jpg' },
  summary: '魔法使芙莉莲在勇者辛美尔死后，为了理解人类而踏上旅途。'.repeat(30)
};
const PERSONS = { data: [
  { id: 3, name: '山田鐘人', relation: '原作' },
  { id: 2, name: '斎藤圭一郎', relation: '导演' },
  { id: 4, name: '鈴木智尋', relation: '系列构成' },
  { id: 1, name: 'MADHOUSE', relation: '动画制作' },
  { id: 5, name: 'Evan Call', relation: '音乐' }
] };
const CHARS = { data: [
  { id: 11, name: 'ヒンメル', type: 2, actors: [{ id: 12, name: '岡本信彦' }] },
  { id: 9, name: 'フリーレン', type: 1, actors: [{ id: 8, name: '種﨑敦美' }] }
] };
const CHAR_DETAIL = { id: 9, name: 'フリーレン', type: 1, career: [], summary: '本作主角。' };
const PERSON_DETAIL = { id: 8, name: '種﨑敦美', career: ['声优'], summary: '日本女性声优。' };
const EPISODES = { total: 29, data: [
  { id: 1, ep: 1, sort: 1, name: '冒険の終わり', airdate: '2023-09-29' },
  { id: 2, ep: 2, sort: 2, name: '別に魔法じゃなくたって', airdate: '2023-10-06' },
  { id: 28, ep: 28, sort: 28, name: 'また会える', airdate: '2024-03-22' },
  { id: 29, ep: 29, sort: 29, name: '未定', airdate: '2099-01-01' }
] };
const CALENDAR = Array.from({ length: 7 }, (_, i) => ({
  weekday: { en: 'Mon', cn: `星期${i + 1}`, ja: '' },
  items: i === dow
    ? [{ id: 501, name: '新番A', name_cn: '新番甲', rating: { score: 7.2 }, nsfw: false }, { id: 502, name: '新番B', name_cn: '', rating: {}, nsfw: false }]
    : []
}));

const jsonRes = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => '' });
const errRes = (status) => ({ ok: false, status, json: async () => ({}), text: async () => 'boom' });

/** 记录请求时把源前缀抹掉，断言里只看路径 */
const stripBase = (u) => String(u).replace(/^https?:\/\/(api\.bangumi\.vip|api\.bgm\.tv)/, '');

const calls = [];
function makeFetch(mode = 'ok') {
  return async (url, opts = {}) => {
    const u = String(url);
    calls.push(`${opts.method || 'GET'} ${stripBase(u)}`);
    if (mode === 'fail429') return errRes(429);
    if (mode === 'noauth' && u.includes('/v0/')) return errRes(403);
    if (mode === 'v0down' && u.includes('/v0/search/subjects')) return errRes(500);
    if (mode === 'empty' && u.includes('/v0/search/subjects')) return jsonRes({ total: 0, data: [] });
    if (mode === 'empty' && u.includes('/search/subject/')) return jsonRes({ results: 0, list: [] });
    if (u.includes('/v0/search/subjects')) return jsonRes(SEARCH);
    if (u.includes('/v0/search/characters')) return jsonRes(CHAR_SEARCH);
    if (u.includes('/v0/search/persons')) return jsonRes(PERSON_SEARCH);
    if (u.includes('/v0/subjects/400602/persons')) return jsonRes(PERSONS);
    if (u.includes('/v0/subjects/400602/characters')) return jsonRes(CHARS);
    if (u.endsWith('/v0/subjects/400602')) return jsonRes(SUBJECT);
    if (u.includes('/v0/characters/9')) return jsonRes(CHAR_DETAIL);
    if (u.includes('/v0/persons/8')) return jsonRes(PERSON_DETAIL);
    if (u.includes('/v0/episodes')) return jsonRes(EPISODES);
    if (u.includes('/calendar')) return jsonRes(CALENDAR);
    if (u.includes('/search/subject/')) return jsonRes(LEGACY_SEARCH);
    return errRes(404);
  };
}

function makeApi(configObj, fetchImpl) {
  const tools = [];
  const api = {
    registerTool: (d) => { tools.push(d); return `bangumi-lookup__${d.id}`; },
    config: () => configObj,
    fetch: fetchImpl,
    isSkillActive: () => true,
    capability: () => undefined,
    hasCapability: () => false,
    log: (...a) => console.log('  [log]', ...a),
    warn: (...a) => console.log('  [warn]', ...a),
    error: (...a) => console.log('  [error]', ...a),
    utils: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), safeJsonParse: (t, f) => f }
  };
  return { api, tools };
}

const mod = await import(pathToFileURL(SKILL).href + '?t=' + Date.now());

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

/**
 * setup 之外还要清一次"源"状态：activeBase 会跨 setup 粘住，判死的源有 5 分钟
 * 冷却期 —— 都是模块级状态，不清的话用例之间会互相污染（这个自测上一次就是
 * 被"撞缓存"坑过，同一类错别再犯）。
 */
const SETUP = async (api) => { await mod.setup(api); mod.internals.internals_resetBases(); };

// ── 1. 注册契约 ────────────────────────────────────────────────────────
console.log('\n== 1. 工具注册契约 ==');
const CFG = { defaultLimit: 5, allowNsfw: false, timeoutMs: 8000, requestIntervalMs: 0, userAgent: '' };
const { api, tools } = makeApi(CFG, makeFetch('ok'));
await SETUP(api);
ok(tools.length === 4, `注册了 4 个工具（实际 ${tools.length}）`);
const EXPECT = ['search', 'detail', 'episodes', 'calendar'];
ok(JSON.stringify(tools.map((t) => t.id)) === JSON.stringify(EXPECT), `工具 id = ${tools.map((t) => t.id).join(', ')}`);
const CATS = ['messaging', 'sticker', 'query', 'memory', 'web', 'knowledge', 'media', 'system'];
for (const t of tools) {
  const full = `bangumi-lookup__${t.id}`;
  ok(/^[a-zA-Z0-9_-]{1,64}$/.test(full) && full.length <= 64, `加载器前缀后 id 合法：${full}（${full.length} 字符）`);
  ok(typeof t.name === 'string' && t.name.length > 0, `${t.id} 有 name`);
  ok(typeof t.execute === 'function', `${t.id} 有 execute`);
  ok(t.parameters?.type === 'object', `${t.id} 有 parameters schema`);
  ok(CATS.includes(t.category), `${t.id} category=${t.category} 在工具分类表内`);
}
ok(typeof mod.available === 'function' && mod.available().ok === true, 'available() 返回 ok（无 Key 依赖）');

const T = (id) => tools.find((t) => t.id === id).execute;
const ctx = {};   // 本技能不用 ctx

// ── 2. 搜索：NSFW 过滤 + 归一化 + 默认条数 ──────────────────────────────
console.log('\n== 2. search（作品条目）==');
let r = await T('search')(ctx, { keyword: '葬送的芙莉莲', type: 'anime' });
console.log(r.content);
ok(!r.isError, '未报错');
ok(r.content.includes('id=400602'), '拿到 id');
ok(!r.content.includes('999999'), 'NSFW 条目默认被过滤掉');
ok(r.content.includes('8.6'), '评分照抄');

// ── 3. 搜索：角色 / 人物 ────────────────────────────────────────────────
console.log('\n== 3. search（角色 / 人物）==');
r = await T('search')(ctx, { keyword: '芙莉莲', kind: 'character' });
console.log(r.content);
ok(r.content.includes('種﨑敦美'), '角色结果带上声优');
r = await T('search')(ctx, { keyword: '种崎敦美', kind: 'person' });
console.log(r.content);
ok(r.content.includes('职业：声优'), '人物结果带上职业');
r = await T('search')(ctx, { keyword: 'abc', kind: 'weird' });
ok(r.isError === true, '非法 kind 被拒（不当成静默失败）');

// ── 4. 详情：简介截断 + 阵容 + 声优表 ───────────────────────────────────
console.log('\n== 4. detail（作品详情）==');
r = await T('detail')(ctx, { id: 400602, characters: true });
console.log(r.content);
ok(!r.isError, '未报错');
ok(r.content.includes('标签：'), '带标签');
ok(r.content.includes('主要制作阵容：'), '带制作阵容');
ok(r.content.includes('原作：山田鐘人'), '阵容排序（原作在前）生效');
ok(r.content.includes('MADHOUSE'), '制作公司拿到');
ok(r.content.includes('登场角色与声优：'), 'characters=true 时带声优表');
ok(r.content.includes('主角（') || r.content.includes('（主角）'), '角色按主角优先排序');
ok(r.content.includes('简介已截断'), '超长简介被截断（省 token）');
r = await T('detail')(ctx, { id: 'abc' });
ok(r.isError === true, '非数字 id 被拒');
r = await T('detail')(ctx, { id: 9, kind: 'character' });
console.log(r.content);
ok(r.content.includes('角色】'), '角色详情可查');

// ── 5. 剧集与更新进度：日期减法由代码做 ─────────────────────────────────
console.log('\n== 5. episodes（更新进度）==');
r = await T('episodes')(ctx, { subjectId: 400602 });
console.log(r.content);
ok(!r.isError, '未报错');
ok(r.content.includes('已播出 3 集'), '本机日期算出的已播出集数正确（2099 的未播）');
ok(r.content.includes('下一集：第 29 集'), '给出下一集');

// ── 6. 放送表：今天这一栏 ───────────────────────────────────────────────
console.log('\n== 6. calendar（今日放送表）==');
r = await T('calendar')(ctx, { weekday: 'today' });
console.log(r.content);
ok(!r.isError, '未报错');
ok(r.content.includes('新番甲'), '今天是周几就算周几（未被时区/口径带偏）');
r = await T('calendar')(ctx, { weekday: '周三' });
ok(!r.isError, '中文星期也能解析');
r = await T('calendar')(ctx, { weekday: '啥' });
ok(r.isError === true, '非法 weekday 被拒');

// ── 7. 缓存：同一个 key 打两次只请求一次 ────────────────────────────────
console.log('\n== 7. 缓存 ==');
calls.length = 0;
await T('search')(ctx, { keyword: '缓存专用关键词', type: 'anime' });
const firstRound = calls.length;
calls.length = 0;
await T('search')(ctx, { keyword: '缓存专用关键词', type: 'anime' });
ok(firstRound > 0 && calls.length === 0, `重复查询命中缓存（第一次 ${firstRound} 次请求，第二次 ${calls.length} 次）`);

// ── 8. 容错 ─────────────────────────────────────────────────────────────
console.log('\n== 8. 容错 ==');
{
  const { api: a2, tools: t2 } = makeApi(CFG, makeFetch('fail429'));
  await SETUP(a2);
  const r2 = await t2.find((t) => t.id === 'search').execute(ctx, { keyword: 'x' });
  console.log(r2.content);
  ok(r2.isError && r2.content.includes('限流'), '429 → 提示限流而不是「查不到」');
}
{
  const { api: a3, tools: t3 } = makeApi(CFG, makeFetch('noauth'));
  await SETUP(a3);
  // 用一个没被前面缓存过的 id，否则会命中缓存、压根不打网络（第一次就是这么误判的）
  const r2 = await t3.find((t) => t.id === 'detail').execute(ctx, { id: 777001 });
  console.log(r2.content);
  ok(r2.isError && r2.content.includes('403'), '403 → 指向 User-Agent 这个真原因');
}
{
  const { api: a4, tools: t4 } = makeApi(CFG, makeFetch('v0down'));
  await SETUP(a4);
  // 同样换个新关键词，避开缓存
  const r2 = await t4.find((t) => t.id === 'search').execute(ctx, { keyword: '落旧版测试' });
  console.log(r2.content);
  ok(!r2.isError && r2.content.includes('旧接口'), 'v0 搜索挂了 → 自动落到旧版接口');
}
{
  // 所有源都不通 → 如实报错（而不是含糊的"查不到"）；网络恢复后队列不被失败毒化
  let down = true;
  const flaky = async (url, opts = {}) => {
    if (down) throw new Error('socket hang up');
    return makeFetch('ok')(url, opts);
  };
  const { api: a7, tools: t7 } = makeApi(CFG, flaky);
  await SETUP(a7);
  const s = t7.find((t) => t.id === 'search');
  const bad = await s.execute(ctx, { keyword: '队列测试A' });
  console.log(bad.content);
  ok(bad.isError, '所有源都不通 → 如实报错');
  ok(bad.content.includes('连不上'), '报错指向"接口连不上"，而不是含糊的"查不到"');
  down = false;
  mod.internals.internals_resetBases();   // 判死的源有 5 分钟冷却期，这里手动清掉
  const good = await s.execute(ctx, { keyword: '队列测试B' });
  ok(!good.isError, '恢复后串行队列没被毒化，下一次仍能正常执行');
}
{
  // persons/characters 若是裸数组（文档口径）也要能认
  const bare = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/persons')) return jsonRes(PERSONS.data);
    if (u.includes('/subjects/490001/characters')) return jsonRes(CHARS.data);
    if (u.endsWith('/v0/subjects/490001')) return jsonRes({ ...SUBJECT, id: 490001 });
    return makeFetch('ok')(url, opts);
  };
  const { api: a8, tools: t8 } = makeApi(CFG, bare);
  await SETUP(a8);
  const r2 = await t8.find((t) => t.id === 'detail').execute(ctx, { id: 490001, characters: true });
  ok(r2.content.includes('主要制作阵容：') && r2.content.includes('登场角色与声优：'), '裸数组形状（文档口径）同样能解析');
}
{
  const { api: a5, tools: t5 } = makeApi(CFG, async () => { throw new Error('Skill bangumi-lookup 未声明 web_fetch 权限'); });
  await SETUP(a5);
  const r2 = await t5.find((t) => t.id === 'search').execute(ctx, { keyword: 'x' });
  console.log(r2.content);
  ok(r2.isError && r2.content.includes('联网权限'), '缺 web_fetch 权限 → 明确告诉用户缺什么');
}
{
  const { api: a6, tools: t6 } = makeApi(CFG, makeFetch('empty'));
  await SETUP(a6);
  const r2 = await t6.find((t) => t.id === 'search').execute(ctx, { keyword: 'zzzz不存在zzzz' });
  console.log(r2.content);
  ok(!r2.isError && r2.content.includes('web_search'), '查不到 → 引导模型用 web_search 兜底，而不是硬编');
}

// ── 9. 换源：镜像 ↔ 官方 ────────────────────────────────────────────────
console.log('\n== 9. 换源（api.bangumi.vip ↔ api.bgm.tv）==');
{
  // 首选源在网络层挂掉（DNS / TLS / 连接被重置那种，不是 HTTP 错误码）
  const seen = [];
  const mirrorDown = async (url, opts = {}) => {
    const u = String(url);
    seen.push(u);
    if (u.startsWith('https://api.bangumi.vip')) throw new Error('fetch failed');
    return makeFetch('ok')(url, opts);
  };
  const { api: a9, tools: t9 } = makeApi(CFG, mirrorDown);
  await SETUP(a9);
  const s = t9.find((t) => t.id === 'search');
  const r2 = await s.execute(ctx, { keyword: '换源测试' });
  console.log(r2.content);
  ok(!r2.isError && r2.content.includes('id=400602'), '首选源不通 → 自动落到下一个源，查询照常成功');
  ok(seen.some((u) => u.startsWith('https://api.bangumi.vip')) && seen.some((u) => u.startsWith('https://api.bgm.tv')), '确实依次试了两个源');
  ok(mod.internals.internals_getActiveBase() === 'https://api.bgm.tv', '把可用的那个源记住了');

  const before = seen.length;
  await s.execute(ctx, { keyword: '换源测试2' });
  const after = seen.slice(before);
  ok(after.length > 0 && after.every((u) => u.startsWith('https://api.bgm.tv')), '通了就"粘住"，不再重复去撞坏源');
}
{
  // 业务错误（429）不该触发换源 —— 换源也白搭，只会让失败慢一倍
  const seen = [];
  const limiter = async (url) => { seen.push(String(url)); return errRes(429); };
  const { api: a10, tools: t10 } = makeApi(CFG, limiter);
  await SETUP(a10);
  const r2 = await t10.find((t) => t.id === 'search').execute(ctx, { keyword: '限流不换源' });
  console.log(r2.content);
  ok(seen.length === 2, `429 不触发换源（v0 + 旧版各一次 = ${seen.length} 次；若换源会是 4 次）`);
  ok(seen.every((u) => u.startsWith('https://api.bangumi.vip')), '仍只打在首选源上');
  ok(r2.isError && r2.content.includes('限流'), '429 → 提示限流，而不是"接口连不上"');
}
{
  // 封面地址必须跟着当前源走，否则群里发出来是裂图
  const { api: a11, tools: t11 } = makeApi(CFG, makeFetch('ok'));
  await SETUP(a11);
  const r2 = await t11.find((t) => t.id === 'search').execute(ctx, { keyword: '封面镜像' });
  ok(r2.content.includes('lain.bangumi.vip'), '镜像源 → 封面用 lain.bangumi.vip');
  ok(!r2.content.includes('lain.bgm.tv'), '不会漏出大陆拿不到的 lain.bgm.tv');

  const officialOnly = async (url, opts = {}) => {
    if (String(url).startsWith('https://api.bangumi.vip')) throw new Error('fetch failed');
    return makeFetch('ok')(url, opts);
  };
  const { api: a12, tools: t12 } = makeApi(CFG, officialOnly);
  await SETUP(a12);
  const r3 = await t12.find((t) => t.id === 'search').execute(ctx, { keyword: '封面官方' });
  ok(r3.content.includes('lain.bgm.tv'), '官方源 → 封面保持 lain.bgm.tv（不越权改写）');
  ok(mod.internals.cdnHostFor('https://api.bgm.tv') === 'lain.bgm.tv'
    && mod.internals.cdnHostFor('https://api.bangumi.vip') === 'lain.bangumi.vip'
    && mod.internals.cdnHostFor('不是域名') === '', 'CDN 换算规则：api.X → lain.X');
}
{
  // 判定函数：网络层错误换源、业务错误不换 —— 方向判错就会静默失效，值得单独测
  const F = mod.internals.isBaseFailure;
  ok(F({ timeout: true }) && F({ status: 500 }) && F(new Error('x')) && F({ badPayload: true }),
    '超时 / 5xx / 连接被重置 / 非 JSON → 判为源故障');
  ok(F({ status: 403, body: '<html>Just a moment...</html>' }), 'Cloudflare 挑战页（403+HTML）→ 判为源故障，换源');
  ok(!F({ status: 429, body: '{"title":"Too Many Requests"}' }), 'Bangumi 自己的 429 → 业务错误，不换源');
  ok(!F({ status: 404, body: '' }) && !F({ status: 400, body: '' }), '404 / 400 → 业务错误，不换源');
}
{
  // 用户显式指定了接口域名 → 只用它，不再自动兜底
  const seen = [];
  const only = async (url) => { seen.push(String(url)); return errRes(418); };
  const { api: a13, tools: t13 } = makeApi({ ...CFG, apiBase: 'my-own-mirror.test' }, only);
  await SETUP(a13);
  const r2 = await t13.find((t) => t.id === 'search').execute(ctx, { keyword: '指定域名' });
  ok(seen.length > 0 && seen.every((u) => u.startsWith('https://my-own-mirror.test/')),
    `裸域名被补成 https 并优先使用（${stripBase(seen[0]) || '无请求'}）`);
  ok(!seen.some((u) => u.includes('bangumi.vip') || u.includes('bgm.tv/')), '指定域名后不再兜底到内置源');
  ok(r2.isError, '指定源也不通时如实报错');
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
