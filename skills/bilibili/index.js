// bilibili skill —— 通过本机 bili CLI（uv tool 安装的 bilibili-cli）查 B 站
//
// 设计要点：
//   · 只读白名单：video / search / user / hot 四个工具，CLI 的交互类能力
//     （like/coin/triple/dynamic-post）刻意不暴露 —— 机器人不许动账号。
//   · CLI 非 TTY 默认输出 YAML envelope（ok/schema_version/data/error），
//     原样截断后交给模型转述；失败时 envelope 里就是结构化错误。
//   · 无登录状态时大部分查询照常可用；登录态缺失只影响字幕/收藏/动态。

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { getSkillConfig } from '../../src/skills/config.js';

const execFileP = promisify(execFile);
const SKILL_ID = 'bilibili';
const DEFAULT_BILI = path.join(process.env.USERPROFILE || '', '.local', 'bin', 'bili.exe');

let log = () => {};

function cfgFallback() {
  return { enabled: true, biliPath: '', maxChars: 4000, timeoutSec: 40 };
}

async function cfg() {
  try {
    const c = await getSkillConfig(SKILL_ID);
    return { ...cfgFallback(), ...(c || {}) };
  } catch {
    return cfgFallback();
  }
}

/** 跑一次 bili 子命令，返回 stdout（YAML）。非零退出时优先透传 CLI 的结构化错误。 */
async function runBili(args, conf) {
  const exe = String(conf.biliPath || '').trim() || DEFAULT_BILI;
  const timeoutMs = Math.max(5, Number(conf.timeoutSec) || 40) * 1000;
  try {
    const { stdout } = await execFileP(exe, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8'
    });
    return stdout;
  } catch (error) {
    // bilibili-cli 失败时 stdout 里也有 YAML envelope（ok:false + error.message），优先用它
    const envelope = String(error?.stdout || '').trim();
    if (envelope) throw new Error(envelope.split('\n').slice(0, 12).join('\n'));
    if (error?.killed) throw new Error(`查询超时（${Math.round(timeoutMs / 1000)}s），B站接口这会儿可能慢`);
    if (error?.code === 'ENOENT') throw new Error(`找不到 bili 可执行文件（${exe}）`);
    throw new Error(String(error?.message ?? error).slice(0, 200));
  }
}

function clip(text, maxChars) {
  const s = String(text ?? '').trim();
  if (!s) throw new Error('bili 没有返回内容');
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}\n…（已截断，原始输出 ${s.length} 字符——给用户摘要时用已显示的部分就够）`;
}

function fail(message) {
  return { content: `错误：${message}`, isError: true };
}

// ─────────────────────────────────────────────── 工具实现

async function doVideo(args) {
  const conf = await cfg();
  if (conf.enabled === false) return fail('B站查询技能已被关掉。');
  const query = String(args?.query ?? '').trim();
  if (!query) return fail('要给一个 BV 号或视频链接。');
  const want = String(args?.want ?? 'info');
  const extra = { subtitle: '--subtitle', comments: '--comments', related: '--related', ai: '--ai' }[want];
  if (want !== 'info' && !extra) return fail(`want 只能是 info/subtitle/comments/related/ai，收到「${want}」`);
  const out = await runBili(['video', query, ...(extra ? [extra] : []), '--yaml'], conf);
  const cap = want === 'subtitle' || want === 'comments' ? Math.max(Number(conf.maxChars) || 4000, 6000) : (Number(conf.maxChars) || 4000);
  return { content: clip(out, cap) };
}

async function doSearch(args) {
  const conf = await cfg();
  if (conf.enabled === false) return fail('B站查询技能已被关掉。');
  const keyword = String(args?.keyword ?? '').trim();
  if (!keyword) return fail('要给一个搜索关键词。');
  const type = args?.type === 'user' ? 'user' : 'video';
  const max = Math.min(10, Math.max(1, Number(args?.max) || 5));
  const out = await runBili(['search', keyword, '--type', type, '--max', String(max), '--yaml'], conf);
  return { content: clip(out, Number(conf.maxChars) || 4000) };
}

async function doUser(args) {
  const conf = await cfg();
  if (conf.enabled === false) return fail('B站查询技能已被关掉。');
  const user = String(args?.user ?? '').trim();
  if (!user) return fail('要给 UP 主的 UID 或名字。');
  const out = await runBili(['user', user, '--yaml'], conf);
  return { content: clip(out, Number(conf.maxChars) || 4000) };
}

async function doHot(args) {
  const conf = await cfg();
  if (conf.enabled === false) return fail('B站查询技能已被关掉。');
  const max = Math.min(15, Math.max(1, Number(args?.max) || 8));
  const out = await runBili(['hot', '--max', String(max), '--yaml'], conf);
  return { content: clip(out, Number(conf.maxChars) || 4000) };
}

// ─────────────────────────────────────────────── 注册

export async function setup(api) {
  log = api.log || (() => {});

  api.registerTool({
    id: 'video', readOnly: true,
    name: '查B站视频',
    description:
      '查一个 Bilibili 视频的详情：标题/UP主/时长/播放点赞投币数据，可加字幕、热门评论、相关视频、AI摘要。'
      + '群里出现 BV 号或 b23.tv 链接、有人聊具体视频时用。返回 YAML，转述时说人话别贴原文。',
    category: 'media',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'BV 号（如 BV1ABcsztEcY）或完整视频链接' },
        want: { type: 'string', enum: ['info', 'subtitle', 'comments', 'related', 'ai'], description: 'info=详情（默认）；subtitle=字幕（问「讲了什么」时用）；comments=热评；related=相关视频；ai=官方AI摘要' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      try { return await doVideo(args); }
      catch (error) { return fail(String(error?.message ?? error).slice(0, 300)); }
    }
  });

  api.registerTool({
    id: 'search', readOnly: true,
    name: '搜B站',
    description:
      '按关键词搜 Bilibili 的视频或用户。有人让你「搜下XX」「B站有没有XX」时用。默认返回 5 条，别自己编结果。',
    category: 'media',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        type: { type: 'string', enum: ['video', 'user'], description: 'video=搜视频（默认），user=搜用户' },
        max: { type: 'number', description: '返回条数，1~10，默认 5' }
      },
      required: ['keyword']
    },
    async execute(_ctx, args) {
      try { return await doSearch(args); }
      catch (error) { return fail(String(error?.message ?? error).slice(0, 300)); }
    }
  });

  api.registerTool({
    id: 'user', readOnly: true,
    name: '查UP主',
    description: '查一个 Bilibili UP 主的资料（UID 或名字都行）：粉丝数、获赞、简介等。聊到某个 UP 主时用。',
    category: 'media',
    icon: '👤',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'UP 主的 UID（纯数字）或名字' }
      },
      required: ['user']
    },
    async execute(_ctx, args) {
      try { return await doUser(args); }
      catch (error) { return fail(String(error?.message ?? error).slice(0, 300)); }
    }
  });

  api.registerTool({
    id: 'hot', readOnly: true,
    name: '看B站热榜',
    description: '看 Bilibili 当前的热门视频。有人问「B站最近什么火」「今天有什么好看的」时用。默认 8 条。',
    category: 'media',
    icon: '🔥',
    parameters: {
      type: 'object',
      properties: {
        max: { type: 'number', description: '返回条数，1~15，默认 8' }
      },
      required: []
    },
    async execute(_ctx, args) {
      try { return await doHot(args); }
      catch (error) { return fail(String(error?.message ?? error).slice(0, 300)); }
    }
  });

  log('B站查询技能已加载（bili CLI，只读：video/search/user/hot；未登录态下字幕/收藏类查询会报需要登录）');
}

/** 可用性自检：同步返回，绝不做 IO。 */
export function available() {
  return { ok: true };
}
