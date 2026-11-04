// 纯离线普通话 Kokoro / 粤语 VITS / Windows SAPI。交付记录由核心发送器负责。
import { chatAllowed } from '../../src/chat-policy.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveSpeechLanguage } from './speech-language.js';
const BUILD_TAG = 'v1.3.0-local-bilingual';
const NEURAL_VOICES = Array.from({ length: 8 }, (_, n) => `zf_${String(n + 1).padStart(3, '0')}`);
const LANGUAGE_PARAM = { type: 'string', enum: ['auto', 'zh', 'yue'], description: 'auto=自动按朗读文字/本轮要求选择；zh=普通话；yue=粤语。明确要求语言时指定，默认 auto。' };
let neuralQueue = Promise.resolve();

/** 注入标记。⚠️ 必须与 api-beggar 的「【触发】」区分开 ——
 *  两个技能的注入幂等判据都靠"内容里已有自己的标记"，共用一个会让对方误以为已注入。 */
const INJECT_TAG = '【语音触发】';

/** 跨会话（转达给别人）用另一个标记：闸门要能分辨"当前会话语音"和"转达语音"。 */
const CROSS_TAG = '【语音转达】';

/** 核心 user prompt 的分段标记（prompt.js:855）。 */
const UNREAD_MARKER = '【未读信息】';
const CORE_SECTION_RE = /\n【(?:记忆|已读信息|新已读信息|未读信息|新加入成员|当前时间|角色设定|表情包|引导说明)/;

const DEFAULT_KEYWORDS = '发语音,说语音,语音回复,用语音,念一下,读出来,发个语音,语音说,发条语音,能语音吗,發語音,語音回覆,用語音,讀出嚟,读出嚟,講語音,讲语音,發條語音,讀出來';

/** 转达意图词：只有它和语音词**同时**出现才走跨会话（宁可少发，绝不误发给别人）。 */
const DEFAULT_CROSS_KEYWORDS = '发给,发到,转告,告诉,私聊,语音发给,发语音给,帮我转告,替我告诉';

/** 中文 TTS 大约每秒 4.5 个字（rate=0），用来估算时长、决定要不要截断。 */
const CHARS_PER_SEC = 4.5;

// SAPI silence checks use its PCM byte rate; neural bridges validate samples.
const BYTES_PER_SEC = { sapi: 32000 };


const SYNTH_TIMEOUT_MS = 30000;

let cfg = () => ({});
let log = () => {};
let warn = () => (() => {});

let stateLoaded = false;
let statePath = '';
let cacheDir = '';
let dataDir = '';
/** 记住上次哪种投递方式成功过，避免每条都先撞一次失败。 */
let deliveryMemory = '';
let state = { lastSaidAt: 0, lastChatKey: '', targets: {} };

export async function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  // setup 是 async（plugin-loader.js:368 会 await）：先把 core 配置读到手，
  // 这样 say_to 的描述能反映真实的开关状态，而不是永远写"未开启"。
  await warmCoreConfig();

  api.registerTool({
    id: 'say',
    name: '发语音',
    description:
      '把要说的话合成成一条语音消息发出去，用来代替打字。'
      + '普通话和粤语按文字内容自动切换，也可通过 language 明确指定。'
      + '只在用户明确要求「发语音/念一下/用语音说」时调用；平时不要调。'
      + '调用它就不要再调 send_message —— 语音回复不需要文字。'
      + '返回第一行是 status：ok=已发出语音 / cooling=刚说过、这次算了 / dry-run=演练，没真发 / error=失败。',
    category: 'media',
    icon: '🔊',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要用语音念出来的内容（原样念，不要加"我要说"之类的前缀）' },
        language: LANGUAGE_PARAM
      },
      required: ['text']
    },

    async execute(ctx, args) {
      const text = String(args?.text ?? '').trim();
      try {
        const result = await doSay(ctx, text, args?.language);
        if (ctx.session && (result.isError || /^status: (?:error|cooling)/.test(result.content || ''))) ctx.session.ttsTextFallback = true;
        return result;
      } catch (error) {
        if (ctx.session) ctx.session.ttsTextFallback = true;
        warn(`语音合成异常：${describe(error)}`);
        return fail(`${humanize(error)}。改用 send_message 打字回复吧。`);
      }
    }
  });

  // ── 跨会话语音：把一句话念给**别的**群/私聊 ────────────────────────────
  //
  // ⚠️ 安全边界：core 的"跨会话发送"管控是**硬编码 send_to 这个 id** 的
  //   （tool-registry.js:186），管不到我们这个工具；执行层那四道校验
  //   （tools.js:220-241）也只写在 send_to 里。所以这里**逐条复刻**一遍，
  //   属于有意的第二道边界（纵深防御），不是重复劳动。
  //   读不到全局配置时 fail-closed：宁可不发，也不做一次没有白名单校验的发送。
  api.registerTool({
    id: 'say_to',
    name: '发语音给指定会话',
    // 描述随开关状态变化（照搬 send_to 的策略：关闭时明确说没权限，
    // 省得模型白试一次）。setup 阶段读一次即可 —— 真正的边界在 execute 里。
    description: (() => {
      const base = '把要说的话合成成语音，发送到另一个群/私聊（不在当前会话里说，而是发去别处）。'
        + '适用于：有人明确让你用语音转告某人/某群。';
      return crossGateState(readSettings(), coreConfig()).open
        ? `${base}先用 get_chats 查目标 chatKey（形如 group:123 / private:456），再传 targetChatKey。只在有明确理由时用，不要骚扰别人。`
        : `${base}（当前未开启：需要「设置 → 工具与技能」的「允许跨会话发送」和本技能的「跨会话语音」两个开关都打开。）`;
    })(),
    category: 'media',
    icon: '📨',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要念给对方听的内容（原样念，不要加"我要告诉TA"之类的前缀）' },
        targetChatKey: { type: 'string', description: '目标会话：group:群号 / private:QQ号（用 get_chats 查，不要自己编）' },
        language: LANGUAGE_PARAM
      },
      required: ['text', 'targetChatKey']
    },

    async execute(ctx, args) {
      const text = String(args?.text ?? '').trim();
      const target = String(args?.targetChatKey ?? '').trim();
      try {
        const result = await doSayTo(ctx, text, target, args?.language);
        if (ctx.session && (result.isError || /^status: (?:error|cooling)/.test(result.content || ''))) ctx.session.ttsTextFallback = true;
        return result;
      } catch (error) {
        if (ctx.session) ctx.session.ttsTextFallback = true;
        warn(`跨会话语音异常：${describe(error)}`);
        return fail(`跨会话语音失败：${humanize(error)}。改用 send_to 发文字，或在当前会话用 say。`);
      }
    }
  });

  api.registerTool({
    id: 'list_voices',
    name: '列出可用音色',
    description:
      '列出当前本地引擎的可用音色真名，不访问在线音色服务。'
      + '用户问"你能用什么声音说话"、或要换一个音色时调用 —— 拿这里的真名去填「音色」设置，别自己编。',
    category: 'media',
    icon: '🎙️',
    parameters: {
      type: 'object',
      properties: {

      },
      required: []
    },

    async execute(ctx, args) {
      try {
        return await doListVoices();
      } catch (error) {
        warn(`音色列举失败：${describe(error)}`);
        return fail(`列举音色失败：${humanize(error)}`);
      }
    }
  });

  log(`语音回复技能已加载（${BUILD_TAG}，引擎=${readSettings().engine}；纯本地合成，不访问在线语音服务）`);
}

/** 可用性自检：同步返回，绝不做 IO（manager.js:187-199 只认 false / {ok:false}）。 */
export function available() {
  return { ok: process.platform === 'win32', reason: process.platform === 'win32' ? '' : '当前离线语音需要 Windows' };
}

// ── 钩子：关键词注入 + 文字闸门 ──────────────────────────────────────────

export const hooks = {
  /** 命中关键词才注入指令；不命中什么都不做（零成本）。 */
  'before-llm-messages': async (payload) => {
    try {
      // 跨会话分支要看 core 开关，这里保证配置引用已就绪（读不到 = 按关闭处理）
      if (!coreCfgRef) await warmCoreConfig();
      injectTrigger(payload);
    } catch (error) {
      warn(`语音触发判定失败（本次不注入）：${describe(error)}`);
    }
  },

  /**
   * 语音闸门：本轮是语音模式时，把**文字**发送拦下来。
   * 没有它的话，模型很可能又打字又发语音，就不是"代替"了。
   * 判据 = 本轮消息里有没有我们的注入标记（inputMessages 是注入后的快照，
   * orchestrator.js:876 → 882，写入时机在工具执行之前）。
   *
   * 跨会话模式（转达）下额外拦 send_to：同一句话不该又发文字给别人。
   */
  'before-tool': async (payload) => {
    try {
      const name = payload?.toolName;
      if (name !== 'send_message' && name !== 'send_to') return;   // 只拦文字发送
      if (payload?.session?.ttsTextFallback) return;
      if (!voiceModeThisTurn(payload?.session)) return;            // 本轮不是语音模式 → 不碰
      return {
        block: true,
        reason: name === 'send_to'
          ? '用户要求用语音转达：请改用 tts-say__say_to 把内容念给对方，不要用文字发。'
          : '用户要求只用语音回复：请立刻改用 say 工具把刚才要说的内容念出来，不要发文字。'
      };
    } catch (error) {
      warn(`语音闸门异常（本次不拦）：${describe(error)}`);
    }
  }
};

function injectTrigger(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages) || !messages.length) return;

  const msg = messages[messages.length - 1];
  if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') return;
  if (msg.content.includes(INJECT_TAG) || msg.content.includes(CROSS_TAG)) return;   // 幂等

  const s = readSettings();
  const tail = unreadTail(msg.content);
  const hit = pickKeyword(tail, s.triggerKeywords);
  if (!hit) return;
  const request = speechRequest(msg.content, s);
  const language = resolveSpeechLanguage('', { mode: s.languageMode, context: request });
  const languageHint = s.engine === 'kokoro'
    ? `本轮语音语言用${language === 'yue' ? '粤语' : '普通话'}（language="${language}"）。回答问题时用该语言组织答案；若是朗读原文，保留原文措辞并按原文语言选择。`
    : '';

  // 转达意图：只有"语音词 + 转达词"同时出现才走跨会话。
  // 宁可少发 —— 单纯说"发语音"永远只在当前会话，绝不莫名发到别人那里。
  const to = pickKeyword(tail, s.crossKeywords);
  if (to) {
    const gate = crossGateState(s, coreConfig());
    if (!gate.open) {
      msg.content = `${msg.content}\n\n${CROSS_TAG}用户要求「${hit}」并想转达给「${to}」，但跨会话语音当前未开启`
        + '（需要「设置 → 工具与技能」的「允许跨会话发送」和本技能的「跨会话语音」两个开关都打开）。'
        + '请直接告诉用户这个功能没开，不要发送任何内容。';
      return;
    }
    msg.content = `${msg.content}\n\n${CROSS_TAG}用户要求用语音转达（触发词「${hit}」+ 转达词「${to}」）：`
      + '① 先用 get_chats 查清楚目标会话的 chatKey（group:群号 / private:QQ号，不要自己编）；'
      + '② 再调用 tts-say__say_to，把要说的话原样放进 text、目标放进 targetChatKey；'
      + `③ 目标必须在白名单内，且本轮最多 ${s.crossMaxPerRun} 条、同一目标 ${s.crossCooldownSec} 秒内不重复。`
      + '④ 不要用 send_message / send_to 发文字（会被拦），转达完就结束这一轮。' + languageHint;
    return;
  }

  msg.content = `${msg.content}\n\n${INJECT_TAG}用户明确要求「${hit}」，这一轮改用语音回复：`
    + '调用 tts-say__say，把你要说的话**原样**放进 text 参数念出来。'
    + '三条硬规矩：① 不要调用 send_message（不要打字）；② 一次只发一条，别拆成多条；'
    + '③ 念完不要再调其它工具，直接结束。'
    + `（若用户是在提问，先想好答案再念，念的就是答案本身。语音上限 ${s.maxChars} 字 / 约 ${s.maxSeconds} 秒，超了会自动截断。）` + languageHint;
}

/** 本轮是不是语音模式（当前会话或跨会话转达都算）。字段缺失返回 false = 放行。 */
function voiceModeThisTurn(session) {
  const list = session?.inputMessages;
  if (!Array.isArray(list) || !list.length) return false;
  const last = list[list.length - 1];
  if (typeof last?.content !== 'string') return false;
  return last.content.includes(INJECT_TAG) || last.content.includes(CROSS_TAG);
}

function unreadTail(content) {
  const i = content.lastIndexOf(UNREAD_MARKER);
  if (i < 0) return '';
  const rest = content.slice(i + UNREAD_MARKER.length);
  const cut = rest.search(CORE_SECTION_RE);
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

function pickKeyword(tail, rawKeywords) {
  if (!tail) return '';
  const hay = tail.toLowerCase();
  for (const kw of splitKeywords(rawKeywords)) {
    if (hay.includes(kw.toLowerCase())) return kw;
  }
  return '';
}

function splitKeywords(raw) {
  const out = [];
  const seen = new Set();
  for (const piece of String(raw ?? '').split(/[,，、;；|\s]+/)) {
    const kw = piece.trim();
    if (!kw || seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
  }
  return out;
}

function speechRequest(content, s) {
  // Only this turn's actual message bodies: exclude history, speaker names,
  // reply blocks, later core sections and our own injected instructions.
  const tail = unreadTail(String(content ?? '')).split(/\n\n【语音(?:触发|转达)】/u)[0];
  const entries = tail.split(/(?=^\[\d{2}-\d{2} \d{2}:\d{2}\])/mu).map(entry => entry
    .replace(/^\[\d{2}-\d{2} \d{2}:\d{2}\][^\n]*?：/u, '')
    .replace(/\[引用(?:[^\[\]]|\[[^\[\]]*\])*\]/gu, '')
    .trim()).filter(Boolean);
  return entries.findLast(entry => pickKeyword(entry, s.triggerKeywords)) || entries.at(-1) || '';
}

function speechSettings(ctx, text, language) {
  const s = readSettings();
  const last = ctx?.session?.inputMessages?.filter(m => m?.role === 'user').at(-1);
  return { ...s, language: resolveSpeechLanguage(text, {
    language, mode: s.languageMode, context: speechRequest(last?.content, s),
  }) };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function doSay(ctx, text, language) {
  const s = speechSettings(ctx, text, language);
  await loadState();

  if (!text) return tell('error', '没有要念的内容。给 text 传要说的话。');
  if (!ctx?.sender || typeof ctx.sender.sendMedia !== 'function') {
    return fail('这个环境没有发送能力（ctx.sender.sendMedia 不存在），改用文字回复。');
  }
  const chatKey = String(ctx.chatKey || '');
  if (!/^(group|private):\S+$/.test(chatKey)) {
    return fail('拿不到会话信息（chatKey 异常），改用文字回复。');
  }

  // 冷却：同一会话刚念过就别连发
  const left = cooldownLeftMs(s.cooldownSec, chatKey);
  if (left > 0) {
    return tell('cooling',
      `${Math.ceil(left / 1000)} 秒内刚发过语音，这次就不重复了 —— 直接用 send_message 打字回复。`);
  }

  const { text: spoken, truncated, dropped } = fitText(text, s);
  if (!spoken) return tell('error', '要念的内容太短了，一句话都不剩。');

  let audio;
  try {
    audio = await synthesize(spoken, s);
  } catch (error) {
    log(`合成失败：${describe(error)}`);
    return fail(`${synthFailMessage(s, error)}。改用 send_message 打字回复。`);
  }

  const seconds = estimateSeconds(spoken, s);
  const secText = oneDecimal(seconds);
  if (s.dryRun) {
    await cleanupFile(audio.file);
    return tell('dry-run',
      `【演练模式】已合成 ${spoken.length} 字（约 ${secText} 秒，${audio.engine} / ${audio.voice}），`
      + '但**没有发送**。确认音色和内容没问题后，把「演练模式」关掉。');
  }

  let sent;
  try {
    sent = await deliver(ctx, audio, s, spoken);
  } catch (error) {
    await cleanupFile(audio.file);
    log(`发送失败：${describe(error)}`);
    return fail(`语音发送失败：${humanize(error)}。改用 send_message 打字回复。`);
  }
  // 发完即删：onebot 已经收完并上传完（sendMedia 是 await 的），留着只会一天天堆文件。
  // 必须 await —— 发射后不管会和下一次合成抢目录，测试也抓不到残留。
  await cleanupFile(audio.file);

  markSaid(chatKey);
  const tail = truncated ? `（原文 ${text.length} 字，已截掉末尾 ${dropped} 字）` : '';
  return tell('ok',
    `已发出语音（${secText} 秒，${audio.engine} / ${audio.voice}${tail}）。`
    + '接下来什么都别做，直接结束这一轮 —— 不要再补文字。');
}

/** 先按设定的投递方式发，失败再退到另一种；把成功的记下来。 */
async function deliver(ctx, audio, s, spoken, targetChatKey = null) {
  const chatKey = String(targetChatKey || ctx.chatKey);
  const order = [];
  if (s.delivery === 'record') order.push('record', 'file');
  else if (s.delivery === 'file') order.push('file', 'record');
  else order.push(deliveryMemory === 'file' ? 'file' : 'record', deliveryMemory === 'file' ? 'record' : 'file');

  let firstErr = null;
  for (const kind of order) {
    const fileRef = `file://${audio.file.replace(/\\/g, '/')}`;
    const segments = [{ type: kind, data: { file: fileRef } }];
    try {
      const r = await ctx.sender.sendMedia(chatKey, segments, {
        label: kind === 'record' ? '[语音]' : `[语音文件 ${audio.file.split('.').pop()}]`,
        // 每分钟一个桶：同一分钟内的重复内容会被去重挡掉（防误双发），
        // 过了一分钟同样的内容又能再发（防误伤正常重复）。
        dedupeKey: `tts:${kind}:${hashLite(spoken)}:${Math.floor(Date.now() / 60000)}`
      });
      deliveryMemory = kind;
      log(`语音已发送：${kind} → ${chatKey}（${audio.file}）→ message_id=${r?.message_id ?? '?'}`);
      return r;
    } catch (error) {
      firstErr = firstErr || error;
      log(`投递方式 ${kind} 失败：${describe(error)}`);
    }
  }
  throw firstErr || new Error('所有投递方式都失败了');
}

// ── 跨会话语音 ────────────────────────────────────────────────────────────

/**
 * core 全局配置。getConfig 是**进程内单例**（config.js:542），和核心读同一份，
 * UI 改完设置立刻生效，不用重启也不用刷新技能。
 * 读不到时一律 fail-closed —— 没有白名单校验的跨会话发送是不能接受的。
 */
let coreCfgRef = null;

async function warmCoreConfig() {
  if (coreCfgRef) return coreCfgRef;
  try {
    coreCfgRef = await import('../../src/config.js');
  } catch (error) {
    coreCfgRef = null;
  }
  return coreCfgRef;
}

function coreConfig() {
  try {
    return typeof coreCfgRef?.getConfig === 'function' ? coreCfgRef.getConfig() : null;
  } catch (error) {
    return null;
  }
}

/**
 * 跨会话闸门。判定口径**逐条对齐** tools.js:220-241 的 send_to，
 * 外加本技能自己那道开关（纵深防御：两个开关都开才允许）。
 */
function crossGateState(s, coreCfg) {
  if (!s.crossEnabled) {
    return { open: false, reason: '本技能的「跨会话语音」开关没打开（技能设置 → 跨会话语音）' };
  }
  if (!coreCfg) {
    return { open: false, reason: '读不到全局配置，无法校验白名单，已按关闭处理' };
  }
  if (coreCfg.tools?.crossChatSend !== true) {
    return { open: false, reason: '「允许跨会话发送」未开启（设置 → 工具与技能）' };
  }
  return { open: true, reason: '' };
}

/** 目标是否在白名单内。口径与 send_to 一致：空名单 + allowAllWhenEmpty 才放行。 */
function targetAllowed(coreCfg, targetChatKey) {
  const [kind, id] = targetChatKey.split(':');
  return chatAllowed(kind, id, coreCfg);
}

/**
 * 跨会话语音主流程。校验顺序与 send_to 一致
 * （开关 → 格式 → 非当前会话 → 白名单），再加本技能两道：单轮配额、目标冷却。
 */
async function doSayTo(ctx, text, targetChatKey, language) {
  const s = speechSettings(ctx, text, language);
  await loadState();
  await warmCoreConfig();

  if (!text) return tell('error', '没有要念的内容。给 text 传要说的话。');
  if (!ctx?.sender || typeof ctx.sender.sendMedia !== 'function') {
    return fail('这个环境没有发送能力（ctx.sender.sendMedia 不存在）。');
  }

  const coreCfg = coreConfig();
  const gate = crossGateState(s, coreCfg);
  if (!gate.open) return fail(`跨会话语音未开启：${gate.reason}`);

  if (!/^(group|private):\d+$/.test(targetChatKey)) {
    return fail('targetChatKey 格式应为 group:群号 或 private:QQ号（先用 get_chats 查，不要自己编）。');
  }
  if (targetChatKey === String(ctx.chatKey || '')) {
    return tell('error', `目标 ${targetChatKey} 就是当前会话 —— 用 say 在当前会话发语音就行，别用 say_to。`);
  }
  if (!targetAllowed(coreCfg, targetChatKey)) {
    return fail(`目标 ${targetChatKey} 不在白名单内，不能发送。`);
  }

  // 单轮配额挂在 ctx 上（每轮新建天然隔离，照抄 send_image 的 ctx.xxxState 范式）
  ctx.ttsCrossState = ctx.ttsCrossState || { sent: 0 };
  const cap = Math.max(0, Math.floor(s.crossMaxPerRun));
  if (ctx.ttsCrossState.sent >= cap) {
    return tell('error', `本次运行已经发了 ${ctx.ttsCrossState.sent} 条跨会话语音，达到上限（设置里可调）。`);
  }

  // 目标冷却：sender 的限频是**按会话**算的，跨会话目标之间不共享配额，
  // 所以这里自己记一份"最近给谁发过"。
  const left = targetCooldownLeftMs(s.crossCooldownSec, targetChatKey);
  if (left > 0) {
    return tell('cooling', `${Math.ceil(left / 1000)} 秒内刚给 ${targetChatKey} 发过语音，这次别重复了。`);
  }

  const { text: spoken, truncated, dropped } = fitText(text, s);
  if (!spoken) return tell('error', '要念的内容太短了，一句话都不剩。');

  let audio;
  try {
    audio = await synthesize(spoken, s);
  } catch (error) {
    log(`跨会话合成失败：${describe(error)}`);
    return fail(`${synthFailMessage(s, error)}。`);
  }

  const secText = oneDecimal(estimateSeconds(spoken, s));
  if (s.dryRun) {
    await cleanupFile(audio.file);
    return tell('dry-run',
      `【演练模式】已合成 ${spoken.length} 字（约 ${secText} 秒，${audio.engine} / ${audio.voice}），`
      + `本该发给 ${targetChatKey}，但**没有发送**。确认无误后把「演练模式」关掉。`);
  }

  try {
    await deliver(ctx, audio, s, spoken, targetChatKey);
  } catch (error) {
    await cleanupFile(audio.file);
    log(`跨会话发送失败：${describe(error)}`);
    return fail(`语音发送失败：${humanize(error)}。`);
  }
  await cleanupFile(audio.file);

  ctx.ttsCrossState.sent += 1;
  markTargetSaid(targetChatKey);
  // 跨会话发送必须手动留档：收尾状态判的是 session.sent.length
  // （orchestrator.js:1259），不记就会被算成 noreply，UI 会话卡片也不显示。
  if (!ctx.sender.recordsDeliveries && Array.isArray(ctx.session?.sent)) {
    ctx.session.sent.push({ type: 'text', text: '[语音]', to: targetChatKey });
    try { ctx.emit?.('session-update', ctx.session.id); } catch { /* 通知失败不影响发送结果 */ }
  }

  const tail = truncated ? `（原文 ${text.length} 字，已截掉末尾 ${dropped} 字）` : '';
  return tell('ok', `已把语音发到 ${targetChatKey}（${secText} 秒，${audio.engine} / ${audio.voice}${tail}）。不要再补文字，直接结束。`);
}

// ── 合成 ──────────────────────────────────────────────────────────────────

async function synthesize(text, s) {
  const out = await ensureCacheDir();
  const wav = out + '/tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.wav';
  try {
    if (s.engine === 'kokoro') {
      // Serialize model loads to bound CPU/RAM use when several chats request speech.
      const job = neuralQueue.then(() => runNeural(text, s, wav));
      neuralQueue = job.catch(() => {});
      await job;
    } else {
      if (s.language === 'yue') throw new Error('Windows SAPI 未配置粤语音色；请选本地神经语音引擎');
      await runSapi(text, s, wav);
      await assertNotSilent(wav, text, s, BYTES_PER_SEC.sapi);
    }
    if (!(await fileOk(wav, 1024))) throw new Error('离线合成没有产出音频');
    return { file: wav, engine: s.engine === 'kokoro' && s.language === 'yue' ? 'vits-cantonese' : s.engine,
      voice: s.engine === 'kokoro' ? (s.language === 'yue' ? 'xiaomaiiwn' : s.neuralVoice) : s.voice };
  } catch (error) { await cleanupFile(wav); throw error; }
}

async function runNeural(text, s, outFile) {
  const cantonese = s.language === 'yue';
  const engine = cantonese ? 'vits-cantonese' : 'kokoro';
  const voice = cantonese ? 'xiaomaiiwn' : s.neuralVoice;
  if (!cantonese && !NEURAL_VOICES.includes(voice)) throw new Error(`本地音色不在清单，可选：${NEURAL_VOICES.join('、')}`);
  const runtime = path.join(dataDir, 'tts-neural');
  const python = s.neuralPython || path.join(runtime, '.venv', 'Scripts', 'python.exe');
  const modelDir = cantonese
    ? s.cantoneseModelDir || path.join(runtime, 'vits-cantonese-hf-xiaomaiiwn')
    : s.neuralModelDir || path.join(runtime, 'kokoro-multi-lang-v1_1');
  const modelFile = cantonese ? 'vits-cantonese-hf-xiaomaiiwn.onnx' : 'model.onnx';
  if (!(await fileOk(python)) || !(await fileOk(path.join(modelDir, modelFile), 1024 * 1024))) {
    throw new Error(`本地神经语音未就绪：请检查 Python 环境和 ${cantonese ? '粤语 VITS' : 'Kokoro'} 模型路径`);
  }
  const requestFile = outFile + '.json';
  try {
    const fs = await import('node:fs/promises');
    await fs.writeFile(requestFile, JSON.stringify({
      text, voice, modelDir, output: outFile,
      speed: Math.min(2, Math.max(0.5, rateFactor(s.rate))),
      volume: s.volume, threads: s.neuralThreads,
    }), { encoding: 'utf8', flag: 'wx' });
    const script = fileURLToPath(new URL(cantonese ? './cantonese_synth.py' : './kokoro_synth.py', import.meta.url));
    const result = await runProcess(python, ['-I', '-X', 'utf8', script, '--request', requestFile, '--deny-network'], 90000);
    if (result.code !== 0) {
      warn(`${engine} 本地合成失败：${String(result.stderr).trim().slice(-1200)}`);
      throw new Error('本地神经语音合成失败，请检查本地运行日志');
    }
    const meta = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    if (meta.engine !== engine || meta.voice !== voice || meta.provider !== 'cpu'
      || !(meta.duration > 0) || !(meta.rms >= 0.0001)) {
      throw new Error('本地神经语音返回了无效音频');
    }
    log(`本地神经语音已合成：${engine} / ${voice}，语言=${s.language}，${meta.duration.toFixed(1)} 秒音频，耗时 ${meta.elapsedSeconds.toFixed(1)} 秒（CPU）`);
  } finally {
    await cleanupFile(requestFile);
  }
}
function synthFailMessage(_s, error) { return '离线语音合成失败：' + humanize(error); }
async function doListVoices() {
  const s = readSettings();
  if (s.engine === 'kokoro') {
    return tell('ok', '本地 Kokoro 中文神经女声：\n' + NEURAL_VOICES.join('\n')
      + `\n普通话：${s.neuralVoice}；粤语：VITS / xiaomaiiwn；语言模式：${s.languageMode}（CPU、离线）`);
  }
  const voices = await listSapiVoices();
  if (!voices.length) return fail('读不到本机离线音色，请检查 Windows 语音组件。');
  return tell('ok', '本机离线音色：\n' + voices.join('\n') + '\n当前：' + readSettings().voice);
}

async function runSapi(text, s, outFile) {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  // ⚠️ 这里必须自己 try/catch + exit 1：**PowerShell 遇到方法调用异常时退出码仍是 0**
  // （实测 SelectVoice 音色不存在 → 退出码 0，而且照样写出一个 59KB 的空 wav）。
  // 只看退出码会把"静音语音"当成合成成功发出去。$ErrorActionPreference='Stop'
  // 让非终止性错误也进 catch，catch 里明确 exit 1。
  const script = [
    "$ErrorActionPreference='Stop'",
    'try {',
    '  Add-Type -AssemblyName System.Speech',
    '  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `  $s.SelectVoice(${q(s.voice)})`,
    `  $s.Rate = ${clampInt(s.rate, -10, 10)}`,
    `  $s.Volume = ${clampInt(s.volume, 0, 100)}`,
    `  $s.SetOutputToWaveFile(${q(outFile)})`,
    `  $s.Speak(${q(text)})`,
    '  $s.SetOutputToNull()',
    '  $s.Dispose()',
    `  if(-not (Test-Path ${q(outFile)})){ Write-Error '没有产出音频文件'; exit 2 }`,
    '  exit 0',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { code, stderr, stdout } = await runProcess('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    SYNTH_TIMEOUT_MS);

  if (code !== 0) {
    const err = String(stderr || stdout || '').trim();
    // 音色不存在时 SAPI 的报错很难懂，换成一句能照着改的提示
    if (/voice|音色|SelectVoice|未安装匹配/i.test(err) || /找不到|cannot find/i.test(err)) {
      const voices = await listSapiVoices();
      throw new Error(`系统里没有「${s.voice}」这个音色。可用的：${voices.join('、') || '(一个都没有)'}`);
    }
    throw new Error(err.slice(0, 200) || `PowerShell 退出码 ${code}`);
  }
}

async function listSapiVoices() {
  try {
    const { stdout } = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }'
    ], 10000);
    return String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ESM 里没有 require，child_process 只能动态 import；
// 模块有缓存，每次 await 一次几乎零开销，换来的是"不碰核心、不引第三方依赖"。
async function runProcess(cmd, args, timeoutMs = 20000, opts = {}) {
  let spawn;
  try {
    const cp = await import('node:child_process');
    spawn = (cp.default || cp).spawn;
  } catch (error) {
    throw new Error(`拿不到子进程模块：${error?.message || error}`);
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (error) {
      reject(new Error(`启动 ${cmd} 失败：${error?.message || error}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`${cmd} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`启动 ${cmd} 失败：${error?.message || error}`));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 静音兜底。⚠️ bytesPerSec 必须按引擎给：sapi 是 wav(32000 B/s)，
 * edge 是 mp3(≈6000 B/s)。用错单位会把 edge 的正常音频判成静音。
 * 实测：sapi 的空 wav 恰好约 59KB（≈1.9 秒，与文本长度无关）。
 * 判据：实际时长明显短于预估的 40% → 判定为没念出来，抛错。
 */
async function assertNotSilent(file, text, s, bytesPerSec) {
  let bytes = 0;
  try {
    const m = await import('node:fs');
    bytes = (m.default || m).statSync(file).size;
  } catch { return; /* 读不到大小就算了，上面已经查过文件存在 */ }

  const actualSec = bytes / bytesPerSec;
  const expectSec = estimateSeconds(text, s);
  if (actualSec < expectSec * 0.4) {
    log(`合成结果疑似静音：${bytes} 字节 ≈ ${actualSec.toFixed(1)} 秒，预估 ${expectSec.toFixed(1)} 秒`);
    throw new Error('合成结果是静音（时长对不上），已拦下不发送');
  }
}

async function fileOk(path, minBytes = 1) {
  try {
    const fs = await import('node:fs');
    const st = fs.statSync(path);
    return st.isFile() && st.size >= minBytes;
  } catch {
    return false;
  }
}

async function cleanupFile(path) {
  if (!path) return;
  try {
    const m = await import('node:fs');
    const fs = m.default || m;
    fs.unlinkSync(path);
  } catch { /* 已经没了 / 没权限就算了，缓存目录本来就该是临时的 */ }
}

async function ensureCacheDir() {
  if (cacheDir) return cacheDir;
  await loadState();
  return cacheDir || `${process.env.TEMP || 'C:/Windows/Temp'}`;
}

// ── 截断与时长估算 ────────────────────────────────────────────────────────

/** 超字数/超时长就在最近的标点处断开，截不出标点才硬切。 */
function fitText(text, s) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const byChars = Math.max(1, Math.floor(s.maxChars));
  const bySeconds = Math.max(1, Math.floor(s.maxSeconds * CHARS_PER_SEC * rateFactor(s.rate)));
  const limit = Math.min(byChars, bySeconds);

  if (clean.length <= limit) return { text: clean, truncated: false, dropped: 0 };

  let cut = clean.slice(0, limit);
  const punct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
    cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf('；'), cut.lastIndexOf('. '));
  if (punct > limit * 0.5) cut = cut.slice(0, punct + 1);
  return { text: cut.trim(), truncated: true, dropped: clean.length - cut.trim().length };
}

function rateFactor(rate) {
  // SAPI 的 Rate 每 +1 约提速 10%，与估算对齐
  return Math.max(0.4, 1 + (Number(rate) || 0) / 10);
}

/** 一位小数就够了 —— 5.333333333333333 秒这种数字给模型看纯属浪费 token。 */
function oneDecimal(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

function estimateSeconds(text, s) {
  return Math.max(0.5, text.length / (CHARS_PER_SEC * rateFactor(s.rate)));
}

// ── 状态落盘 ──────────────────────────────────────────────────────────────

/** 冷却：只看同一个会话（换个群就该能立刻发）。 */
function cooldownLeftMs(cooldownSec, chatKey) {
  if (!(cooldownSec > 0) || !state.lastSaidAt) return 0;
  if (state.lastChatKey && state.lastChatKey !== chatKey) return 0;
  const end = state.lastSaidAt + cooldownSec * 1000;
  return end > Date.now() ? end - Date.now() : 0;
}

/** 跨会话：按**目标**记冷却（sender 的限频是按会话算的，跨会话不共享配额）。 */
function targetCooldownLeftMs(cooldownSec, targetChatKey) {
  if (!(cooldownSec > 0)) return 0;
  const at = Number(state.targets?.[targetChatKey]) || 0;
  if (!at) return 0;
  const end = at + cooldownSec * 1000;
  return end > Date.now() ? end - Date.now() : 0;
}

function markTargetSaid(targetChatKey) {
  // 只留最近 20 个目标，防止状态文件无限增长
  const targets = { ...(state.targets || {}), [targetChatKey]: Date.now() };
  const keys = Object.keys(targets).sort((a, b) => targets[b] - targets[a]).slice(0, 20);
  state.targets = Object.fromEntries(keys.map((k) => [k, targets[k]]));
  saveState();
}

function markSaid(chatKey) {
  state.lastSaidAt = Date.now();
  state.lastChatKey = chatKey;
  saveState();
}

/**
 * 音频目录 + 状态文件都放 DATA_DIR（核心 config.js 的真实数据目录）。
 * 绝不能放技能目录：skills/ 被 fs.watch 递归监听（plugin-loader.js:565），
 * 自己写文件 → 触发热重载 → 内存清零，自激循环。
 */
async function loadState() {
  if (stateLoaded) return;
  stateLoaded = true;

  let fs = null;
  let pathMod = null;
  try { const m = await import('node:fs'); fs = m.default || m; } catch { fs = null; }
  try { const m = await import('node:path'); pathMod = m.default || m; } catch { pathMod = null; }

  let dir = '';
  try {
    const { DATA_DIR } = await import('../../src/config.js');
    dir = DATA_DIR;
  } catch (error) {
    try { const os = await import('node:os'); dir = (os.default || os).tmpdir(); } catch { dir = ''; }
  }
  if (!dir || !fs || !pathMod) {
    warn('拿不到可用目录，语音音频只能落系统临时目录（冷却只在内存里记）');
    cacheDir = process.env.TEMP || 'C:/Windows/Temp';
    return;
  }

  cacheDir = pathMod.join(dir, 'tts-cache');
  statePath = pathMod.join(dir, 'tts-say-state.json');
  dataDir = dir;
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* 建不了就用临时目录 */ }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      state.lastSaidAt = Number(raw.lastSaidAt) || 0;
      state.lastChatKey = String(raw.lastChatKey || '');
      state.targets = (raw.targets && typeof raw.targets === 'object') ? raw.targets : {};
      deliveryMemory = String(raw.delivery || '');
    }
  } catch { /* 新文件 / 半截文件：按默认值继续 */ }
}

function saveState() {
  if (!statePath) return;
  import('node:fs').then((m) => {
    const fs = m.default || m;
    try {
      fs.writeFileSync(statePath, JSON.stringify({
        lastSaidAt: state.lastSaidAt,
        lastChatKey: state.lastChatKey,
        targets: state.targets,
        delivery: deliveryMemory
      }), 'utf8');
    } catch (error) {
      warn(`状态落盘失败（下次重启冷却重置）：${describe(error)}`);
    }
  }).catch(() => { /* ignore */ });
}

// ── 配置与小工具 ──────────────────────────────────────────────────────────

/** 每次执行现读（用户改完设置立刻生效）。脏值一律回退默认，绝不抛错。 */
function readSettings() {
  const c = cfg() || {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, n));
  };
  return {
    engine: c.engine === 'sapi' ? 'sapi' : 'kokoro',
    voice: String(c.voice ?? '').trim() || 'Microsoft Huihui Desktop',
    neuralVoice: String(c.neuralVoice ?? '').trim() || 'zf_001',
    neuralPython: String(c.neuralPython ?? '').trim(),
    neuralModelDir: String(c.neuralModelDir ?? '').trim(),
    neuralThreads: Math.round(num(c.neuralThreads, 2, 1, 4)),
    languageMode: ['zh', 'yue'].includes(c.languageMode) ? c.languageMode : 'auto',
    cantoneseModelDir: String(c.cantoneseModelDir ?? '').trim(),
    rate: num(c.rate, 0, -10, 10),
    volume: num(c.volume, 100, 0, 100),
    maxChars: num(c.maxChars, 300, 1, 5000),
    maxSeconds: num(c.maxSeconds, 60, 1, 600),
    cooldownSec: num(c.cooldownSec, 60, 0, 86400),
    delivery: c.delivery === 'file' ? 'file' : 'record',
    triggerKeywords: String(c.triggerKeywords ?? '').trim() || DEFAULT_KEYWORDS,
    // 跨会话：默认**关**。两道开关（core 的 crossChatSend + 这个）都开才允许转达。
    crossEnabled: c.crossEnabled === true,
    crossKeywords: String(c.crossKeywords ?? '').trim() || DEFAULT_CROSS_KEYWORDS,
    crossMaxPerRun: num(c.crossMaxPerRun, 2, 0, 20),
    crossCooldownSec: num(c.crossCooldownSec, 300, 0, 86400),
    dryRun: c.dryRun !== false
  };
}

function tell(status, text) {
  return { content: `status: ${status}\n${text}` };
}

/** 失败一律走 isError（不抛错）—— 抛错会被上层兜成通用错误，模型拿不到有用信息。 */
function fail(message) {
  return { content: message, isError: true };
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function hashLite(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function describe(error) {
  if (!error) return '未知错误';
  return String(error?.message || error);
}

/** 给模型看的错误文案：去掉 PowerShell 之类的内部噪声。 */
function humanize(error) {
  const text = describe(error);
  if (/本地神经语音/.test(text)) return text;
  if (/静音/.test(text)) return '合成结果是静音，已拦下（不会发出去）';
  if (/超时/.test(text)) return '合成超时了（文本可能太长）';
  // 音色错误后面跟着"可选：xxx / 你是不是想用"这类可照抄的清单，必须原样透出
  if (/音色/.test(text) && /(可选|是不是想用|不在清单)/.test(text)) return text;
  if (/读不到音色清单/.test(text)) return text;
  if (/音色/.test(text) && /可用的：/.test(text)) return text;
  if (/音色|voice/i.test(text)) return '音色不对或系统里没装';
  if (/系统找不到指定的文件|不是内部或外部命令|spawn .* ENOENT/i.test(text)) return '调不起系统语音引擎';
  if (/拒绝访问|denied/i.test(text)) return '系统拒绝了这次调用';
  return '合成过程出错';
}
