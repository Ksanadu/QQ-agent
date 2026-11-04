// netease-music skill —— 按操作员网易云曲库推荐音乐（收藏专辑/红心歌单/每日推荐）
//
// 设计要点：
//   · 底层是独立安装的 cloud-music-mcp，但那是
//     stdio MCP server，QQ-agent 不 speaks MCP；scripts/netease-cli.py 用
//     「sys.path 指 src + import api」的方式把它的只读能力包成一次性 JSON CLI。
//   · 只读白名单：recommend / search / album 三个工具。play（唤起本机桌面客户端
//     放歌）、create_playlist、add_to_playlist 刻意不暴露 —— 机器人不许动账号。
//   · 登录态 = cloud-music-mcp/src/cloud_music_mcp/storage/cookies.json（本地），
//     未登录时 CLI 直接报错，skill 原样把错误给模型。
//   · 触发词（推荐音乐/来点音乐…）写在 skill.json 的 prompt 段，由模型判定。

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getSkillConfig } from '../../src/skills/config.js';

const execFileP = promisify(execFile);
const SKILL_ID = 'netease-music';
const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SKILL_DIR, '..', '..');
const MUSIC_ROOT = process.env.CLOUD_MUSIC_MCP_ROOT || path.resolve(ROOT, '..', 'cloud-music-mcp');
const DEFAULT_PY = path.join(MUSIC_ROOT, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const DEFAULT_SCRIPT = path.join(SKILL_DIR, 'scripts', 'netease-cli.py');

let log = () => {};

function cfgFallback() {
  return { enabled: true, pythonPath: '', scriptPath: '', maxChars: 4000, recommendMaxChars: 14000, timeoutSec: 60 };
}

async function cfg() {
  try {
    const c = await getSkillConfig(SKILL_ID);
    return { ...cfgFallback(), ...(c || {}) };
  } catch {
    return cfgFallback();
  }
}

/** 跑一次 CLI 子命令，返回 stdout（JSON 文本）。 */
async function runCli(args, conf) {
  const py = String(conf.pythonPath || '').trim() || DEFAULT_PY;
  const script = String(conf.scriptPath || '').trim() || DEFAULT_SCRIPT;
  const timeoutMs = Math.max(10, Number(conf.timeoutSec) || 60) * 1000;
  try {
    const { stdout } = await execFileP(py, [script, ...args], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1' }
    });
    return stdout;
  } catch (error) {
    // CLI 约定：失败也输出 JSON（ok:false + error），优先透传给人话
    const envelope = String(error?.stdout || '').trim();
    if (envelope) {
      try {
        const parsed = JSON.parse(envelope);
        if (parsed?.error) throw new Error(String(parsed.error).slice(0, 200));
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error(envelope.split('\n').slice(0, 8).join('\n'));
        throw e;
      }
    }
    if (error?.killed) throw new Error(`查询超时（${Math.round(timeoutMs / 1000)}s），网易云接口这会儿可能慢`);
    if (error?.code === 'ENOENT') throw new Error(`找不到 Python（${py}）或 CLI 脚本（${script}）`);
    throw new Error(String(error?.message ?? error).slice(0, 200));
  }
}

function clip(text, maxChars) {
  const s = String(text ?? '').trim();
  if (!s) throw new Error('netease-cli 没有返回内容');
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}\n…（已截断，原始输出 ${s.length} 字符——推荐时挑重点说就够）`;
}

function fail(message) {
  return { content: `错误：${message}`, isError: true };
}

// ─────────────────────────────────────────────── 工具实现

async function doRecommend() {
  const conf = await cfg();
  if (conf.enabled === false) return fail('音乐推荐技能已被关掉。');
  const out = await runCli(['recommend'], conf);
  // 全量曲库（收藏专辑 + 全部红心）体量 ~11KB，单独用更大的截断上限
  const body = clip(out, Math.max(Number(conf.recommendMaxChars) || 14000, Number(conf.maxChars) || 4000));
  // 近因止停：列表巨长，低档模型容易看哪行安利哪行、刹不住车
  return { content: `${body}\n\n（以上是全部曲库。这轮只挑一首最想安利的：用 share 发卡片，再配两三句话，说完就停。不要继续列举别的歌。）` };
}

async function doSearch(args) {
  const conf = await cfg();
  if (conf.enabled === false) return fail('音乐推荐技能已被关掉。');
  const keyword = String(args?.keyword ?? '').trim();
  if (!keyword) return fail('要给一个搜索关键词。');
  const category = ['song', 'album', 'artist', 'playlist'].includes(args?.category) ? args.category : 'song';
  const out = await runCli(['search', keyword, category], conf);
  return { content: clip(out, Number(conf.maxChars) || 4000) };
}

async function doAlbum(args) {
  const conf = await cfg();
  if (conf.enabled === false) return fail('音乐推荐技能已被关掉。');
  const albumId = String(args?.albumId ?? '').trim();
  if (!/^\d+$/.test(albumId)) return fail('要给一个专辑 ID（纯数字，search category=album 的结果里有）。');
  const out = await runCli(['album', albumId], conf);
  return { content: clip(out, Number(conf.maxChars) || 4000) };
}

// ─────────────────────────────────────────────── 音乐分享卡片

/**
 * 发分享卡片，两种模式：
 *  · song（默认）：OneBot 标准 music 段 {type:'music', data:{type:'163', id}}——
 *    协议端自己拉歌曲信息构造官方样式卡片，实测可显示可点开。
 *  · album：music 163 自定义段（不传歌曲 id）（title=专辑名 / content=歌手·年份 / image=封面 /
 *    url=专辑页 / audio=专辑第一首试听，CLI songurl 现拿现用，链接带时效）。
 *    SnowLuma 将无 id 的标题/链接等字段透传给签名服务；type=163 生成网易云来源名称与图标。
 * 伪造 json 卡片（com.tencent.tuwen.lua + meta.news）已被 QQ 风控吞——别回头。
 */
async function doShare(args, ctx) {
  const conf = await cfg();
  if (conf.enabled === false) return fail('音乐推荐技能已被关掉。');
  if (!ctx?.sender || typeof ctx.sender.sendMedia !== 'function') {
    return fail('这个环境没有发送能力（ctx.sender.sendMedia 不存在），改用文字发链接。');
  }
  const chatKey = String(ctx.chatKey || '');
  if (!/^(group|private):\S+$/.test(chatKey)) return fail('拿不到会话信息，改用文字发链接。');

  const category = args?.category === 'album' ? 'album' : 'song';
  const id = String(args?.id ?? args?.songId ?? '').trim();
  if (!/^\d+$/.test(id)) return fail('要给一个 ID（纯数字，search/recommend 的结果里有）。');

  if (category === 'song') {
    let song = { name: '', artist: '' };
    try {
      const detail = JSON.parse(await runCli(['song', id], conf));
      if (detail?.ok && detail.name) song = detail;
    } catch { /* 详情拉不到也能发卡：协议端自己会解析 */ }

    const segments = [{ type: 'music', data: { type: '163', id } }];
    const label = song.name ? `[音乐卡片]${song.name} - ${song.artist}` : `[音乐卡片:song ${id}]`;
    try {
      await ctx.sender.sendMedia(chatKey, segments, {
        label,
        dedupeKey: `netease-card:song:${id}:${Math.floor(Date.now() / 60000)}`
      });
      return {
        content: song.name
          ? `已把《${song.name}》（${song.artist}）发成分享卡片。这轮用户要的是多张的话，继续用 share 发下一首（不同的歌曲 ID）；都发完了就写一句收尾，然后立刻结束。只推一张的话，现在就收尾结束。`
          : `已把歌曲（ID ${id}）发成分享卡片。还发就继续用 share；不发了就立刻收尾结束。`
      };
    } catch (error) {
      return fail(`卡片发送失败：${String(error?.message ?? error)}。改用文字发链接：https://y.music.163.com/m/song?id=${id}`);
    }
  }

  // ── 专辑卡片（网易云来源的自定义信息）──
  let album = {};
  try {
    const detail = JSON.parse(await runCli(['album', id], conf));
    if (detail?.ok && detail.album?.name) album = detail.album;
    else return fail('没查到这张专辑，先用 search category=album 拿 ID。');
  } catch (error) {
    return fail(`查专辑详情失败：${String(error?.message ?? error)}`);
  }
  if (!album.first_song_id) return fail('这张专辑查不到曲目，发不了卡片，改用文字链接。');

  let audioUrl = '';
  try {
    const u = JSON.parse(await runCli(['songurl', String(album.first_song_id)], conf));
    if (u?.ok) audioUrl = u.url || '';
  } catch { /* 拿不到试听也试发：有的协议端允许 audio 为空 */ }

  const year = album.publish_time ? new Date(album.publish_time).getFullYear() : '';
  const card = {
    type: 'music',
    data: {
      type: '163',
      url: `https://y.music.163.com/m/album?id=${id}`,
      audio: audioUrl,
      title: album.name,
      content: year ? `${album.artist} - ${year}` : album.artist,
      image: album.pic_url || ''
    }
  };
  try {
    await ctx.sender.sendMedia(chatKey, [card], {
      label: `[专辑卡片]${album.name} - ${album.artist}`,
      dedupeKey: `netease-card:album:${id}:${Math.floor(Date.now() / 60000)}`
    });
    return { content: `专辑卡片《${album.name}》已发出。这轮用户要的是多张专辑的话，继续用 share（category=album）发下一张；都发完了就立刻结束，不要写解释。只推这张的话，现在就结束。` };
  } catch (error) {
    return fail(`专辑卡片发送失败：${String(error?.message ?? error)}。改用文字发链接：https://y.music.163.com/m/album?id=${id}`);
  }
}

// ─────────────────────────────────────────────── 注册

export async function setup(api) {
  log = api.log || (() => {});

  api.registerTool({
    id: 'recommend',
    name: '推荐音乐',
    description:
      '按我自己的网易云曲库出推荐素材：收藏的专辑（全量）+ 红心歌单（全量），一次拿全。'
      + '有人说「推荐音乐/来点音乐/推点歌/有什么好听的」时用。返回行式列表——挑一首用 share 发卡片即可，不要念列表。',
    category: 'media',
    icon: '🎵',
    parameters: { type: 'object', properties: {} },
    async execute(_ctx) {
      try {
        return await doRecommend();
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    }
  });

  api.registerTool({
    id: 'search',
    name: '搜网易云',
    description: '在网易云音乐按关键词搜歌曲/专辑/歌手/歌单（category=song/album/artist/playlist），配合推荐补货用。',
    category: 'media',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        category: { type: 'string', enum: ['song', 'album', 'artist', 'playlist'], description: '默认 song' }
      },
      required: ['keyword']
    },
    async execute(_ctx, args) {
      try {
        return await doSearch(args);
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    }
  });

  api.registerTool({
    id: 'album',
    name: '查专辑曲目',
    description: '看一张网易云专辑的完整曲目（先 search category=album 拿专辑 ID）。',
    category: 'media',
    icon: '💿',
    parameters: {
      type: 'object',
      properties: {
        albumId: { type: 'string', description: '专辑 ID（纯数字）' }
      },
      required: ['albumId']
    },
    async execute(_ctx, args) {
      try {
        return await doAlbum(args);
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    }
  });

  api.registerTool({
    id: 'share',
    name: '发音乐卡片',
    description:
      '把一首歌或一张专辑发成 QQ 音乐卡片。category=song（默认）走网易云官方样式；'
      + 'category=album 发专辑卡片。一轮只发一张，发完就收尾结束。',
    category: 'media',
    icon: '🎼',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '歌曲或专辑 ID（纯数字）' },
        category: { type: 'string', enum: ['song', 'album'], description: 'song=单曲卡片（默认）；album=专辑卡片（发出后不要配解释文字）' }
      },
      required: ['id']
    },
    async execute(ctx, args) {
      try {
        return await doShare(args, ctx);
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    }
  });

  log('音乐推荐技能已加载（netease-music：收藏专辑/红心歌单全量，只读 + 分享卡片）');
}

export function available() {
  return true;
}
