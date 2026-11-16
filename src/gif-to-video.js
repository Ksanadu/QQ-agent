// GIF → 视频转换：有人发动态表情（GIF）时，把它转成模型可读的 mp4。
//
// ── 为什么需要这个模块 ────────────────────────────────────────────────
// "支持图片输入"和"能读 GIF"是两回事，"支持视频输入"和"能读 GIF"也是两回事：
//   · 多数视觉 API 对 GIF 要么按第一帧处理、要么直接拒收；
//   · 全模态模型多数能读 mp4，却读不了 GIF。
// 所以当用户在设置里勾了「视频输入」(api.video) 时，看图工具拿到 GIF 不再按
// 图片原样发，而是先用 ffmpeg 转成 mp4，再按 video 部件发给模型
// （llm.js 的 specializedModelFor 会自动切到 videoModel）。
//
// ── 防"压缩炸弹"（decompression bomb）────────────────────────────────
// GIF 是无损索引色格式，一个几 MB 的 GIF 解开可能是上万帧超大画布，
// 转出来的 mp4 会大到把模型 token 预算炸穿（甚至拖垮网关）。
// 强约束（写死，不做成配置 —— 这是安全上限，不是口味）：
//   · 转换后长宽的最大边 ≤ 480 像素
//   · 最多接受 600 帧；超限拒绝转换，不截断或降低原始帧率。
// 转换前只扫描 GIF 容器计帧，不解压像素；转换时保留每帧时间戳，
// 只播放一个循环，仍限制输出尺寸、体积和处理时间。
//
// ── 与项目其它 ffmpeg 用法的关系 ─────────────────────────────────────
// 项目里已有三处各自探测 ffmpeg（video-reader / image-compress / video-frames 插件），
// 各有各的缓存与超时口径。这里是第四处，但刻意**不共享**探测结果：
// 各处传参方式不同（有的要 stdout、有的只看退出码），耦合它们会让"改一处超时、
// 另一处悄悄跟着变"这种事发生。重复的是 20 行探测样板，换来的是互相独立。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { detectImageType } from './image-type.js';

/** 转换后最大边（像素）。 */
export const GIF_VIDEO_MAX_DIM = 480;
/** 可转换的原始帧数上限；超限拒转，而不是截断动画。 */
export const GIF_VIDEO_MAX_FRAMES = 600;

/** 扫描 GIF 块计帧，不解压 LZW 数据。格式异常返回 null。 */
function countGifFrames(buffer) {
  if (buffer.length < 13) return null;
  let pos = 13 + (buffer[10] & 0x80 ? 3 * (1 << ((buffer[10] & 7) + 1)) : 0);
  let frames = 0;
  function skipBlocks() {
    while (pos < buffer.length) {
      const size = buffer[pos++];
      if (!size) return true;
      pos += size;
      if (pos > buffer.length) return false;
    }
    return false;
  }
  while (pos < buffer.length) {
    const block = buffer[pos++];
    if (block === 0x3b) return frames || null;
    if (block === 0x21) {
      if (pos >= buffer.length) return null;
      pos++; // extension label; its payload is a chain of sub-blocks
    } else if (block === 0x2c) {
      if (pos + 9 > buffer.length) return null;
      const flags = buffer[pos + 8];
      pos += 9 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
      if (pos >= buffer.length) return null;
      pos++; // LZW minimum code size
      if (++frames > GIF_VIDEO_MAX_FRAMES) return frames;
    } else {
      return null;
    }
    if (!skipBlocks()) return null;
  }
  return null;
}

/** 调外部命令，只看退出码；失败/超时返回 false（不抛）。 */
function runOk(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

/** ffmpeg 探测（成功长期缓存；没找到 60 秒后允许重探——用户装好后不用重启）。 */
let _ffmpeg = null;
let _checked = false;
let _checkedAt = 0;
const FFMPEG_RETRY_MS = 60000;
async function findFfmpeg() {
  if (_checked && _ffmpeg) return _ffmpeg;
  if (_checked && Date.now() - _checkedAt < FFMPEG_RETRY_MS) return _ffmpeg;
  _checked = true;
  _checkedAt = Date.now();
  _ffmpeg = null;
  for (const name of ['ffmpeg', 'ffmpeg.exe']) {
    if (await runOk(name, ['-version'], 5000)) { _ffmpeg = name; break; }
  }
  return _ffmpeg;
}

/** 测试用：清空探测缓存。 */
export function __resetFfmpegCache() {
  _ffmpeg = null;
  _checked = false;
  _checkedAt = 0;
}

/** 这段字节是 GIF 吗（魔数 GIF87a / GIF89a）。 */
export function isGifBuffer(buf) {
  const head = buf?.length >= 6 ? buf.toString('ascii', 0, 6) : '';
  return head === 'GIF87a' || head === 'GIF89a';
}

/**
 * 把 GIF 字节转成 mp4 data URL。
 *
 * @param {Buffer} buffer GIF 原始字节（已由调用方下载并校验过魔数）
 * @returns {Promise<{dataUrl: string, frames: number, width: number, height: number} | null>}
 *   失败（没 ffmpeg / 转换出错 / 产出异常）返回 null，调用方回退到按图片发送。
 */
export async function gifToVideoDataUrl(buffer) {
  const type = detectImageType(buffer);
  if (!type || type.mime !== 'image/gif') return null;
  const frames = countGifFrames(buffer);
  if (!frames || frames > GIF_VIDEO_MAX_FRAMES) return null;
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;

  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `qqa_gif_in_${stamp}.gif`);
  const tmpOut = path.join(os.tmpdir(), `qqa_gif_out_${stamp}.mp4`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // 不再使用 fps 滤镜或固定 -r；GIF 的时间单位为 1/100 秒，
    // passthrough + 相同编码/封装时基保留非均匀帧延时。关闭 B 帧，
    // 避免编码重排让 MP4 尾帧时长被缩短。ignore_loop=1 只转一个循环。
    // force_divisible_by=2 保证奇数尺寸也能用 yuv420p 编码。
    const okRun = await runOk(ffmpeg, [
      '-y',
      '-ignore_loop', '1',
      '-i', tmpIn,
      '-vf', `scale='min(${GIF_VIDEO_MAX_DIM},iw)':'min(${GIF_VIDEO_MAX_DIM},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-fps_mode', 'passthrough',
      '-enc_time_base', '1:100',
      '-video_track_timescale', '100',
      '-bf', '0',
      '-frames:v', String(frames),
      '-an',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      tmpOut
    ], 45000);
    if (!okRun || !fs.existsSync(tmpOut)) return null;
    const out = fs.readFileSync(tmpOut);
    // 仍限制输出体积；超限拒转，不通过减帧改变动画。
    if (!out.length || out.length > 8 * 1024 * 1024) return null;
    const dims = await probeVideoSize(tmpOut);
    return {
      dataUrl: `data:video/mp4;base64,${out.toString('base64')}`,
      frames,
      width: dims?.width || 0,
      height: dims?.height || 0
    };
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

/** ffprobe 读输出视频的宽高；读不出返回 null。 */
async function probeVideoSize(file) {
  const txt = await runStdout('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', file
  ], 10000);
  if (!txt) return null;
  try {
    const s = (JSON.parse(txt).streams || []).find((x) => x.codec_type === 'video');
    return s?.width ? { width: Number(s.width), height: Number(s.height) } : null;
  } catch {
    return null;
  }
}

/** 调外部命令并收集 stdout；失败/超时返回 null。 */
function runStdout(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(out || null); });
  });
}

/**
 * 当前配置下 GIF 应该走哪条路。**纯函数**，便于测试。
 *
 * 规则矩阵（2026-09-19 按用户定稿重写；vision = api.vision，video = api.video）：
 *   vision=F, video=F → 'image'      所有图片（含动图）按 [图片] 占位符（看图工具整体不存在）
 *   vision=T, video=F → 'gif-image'  GIF 直接按图片发（读不了 GIF 的模型报错时，由调用方取首帧重试）
 *   vision=F, video=T → 'image'      图片输入没开：视频输入只管视频，图片一律占位符
 *   vision=T, video=T → 'video'      GIF 转 mp4 按 video 部件发（llm.js 自动切 videoModel）
 *
 * @returns {'video'|'gif-image'|'image'}
 */
export function resolveGifRoute({ vision = true, video = false } = {}) {
  if (!vision) return 'image';        // 看图工具不存在，谈不上 GIF 选路
  if (video) return 'video';          // 图片+视频都开：动图转视频
  return 'gif-image';                 // 只开图片：动图按图发，报错降级到首帧
}

/**
 * GIF 首帧提取：把动图的第一帧转成静态 PNG/JPEG 的 dataUrl。
 * 用途：resolveGifRoute 走 'gif-image' 时，模型/网关读不了 GIF 报错的**降级重试**——
 * "报错则取首帧输入模型，此流程写进代码而不靠模型调用"（用户定稿）。
 * 提取失败（没 ffmpeg / 文件异常）返回 null，调用方退回原样发送。
 */
export async function gifFirstFrameDataUrl(buffer) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `qqa_gif1_in_${stamp}.gif`);
  const tmpOut = path.join(os.tmpdir(), `qqa_gif1_out_${stamp}.png`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // -frames:v 1 只解码第一帧；scale 压到 ≤768px（静态帧没必要更大，省 token）
    const okRun = await runOk(ffmpeg, [
      '-y',
      '-ignore_loop', '0',
      '-i', tmpIn,
      '-vf', "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
      '-frames:v', '1',
      '-an',
      tmpOut
    ], 20000);
    if (!okRun || !fs.existsSync(tmpOut)) return null;
    const out = fs.readFileSync(tmpOut);
    if (!out.length || out.length > 4 * 1024 * 1024) return null;
    return `data:image/png;base64,${out.toString('base64')}`;
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}
