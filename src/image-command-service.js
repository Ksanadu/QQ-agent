import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const IMAGE_MODEL = 'gemini-3.1-flash-image';
export const ADMIN_QQ = '2456214815';
export const DAY_MS = 86400000;
export function beijingDay(time) { return new Date(time + 8 * 3600000).toISOString().slice(0, 10); }

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export class ImageCommandService {
  constructor({ stateFile, preparePrompt, generateImage, saveImage, now = Date.now, log = () => {},
    commandName = 'generate', model = IMAGE_MODEL, dailyLimit = 3, maxActive = 2, maxPending = 12 }) {
    Object.assign(this, { stateFile, preparePrompt, generateImage, saveImage, now, log, commandName, model, dailyLimit, maxActive, maxPending });
    this.queue = []; this.active = new Set(); this.stopped = false;
  }

  readState() {
    if (!fs.existsSync(this.stateFile)) return { version: 2, users: {}, events: {} };
    const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    if (!state.users || !state.events
        || typeof state.users !== 'object' || Array.isArray(state.users)
        || typeof state.events !== 'object' || Array.isArray(state.events)
        || Object.values(state.events).some((t) => !Number.isFinite(t) || t <= 0)) {
      throw new Error('生图限额记录损坏，请管理员检查；未清空记录。');
    }
    if (state.version === 1) {
      // Keep prior reservations while migrating the hourly schema; never reset on upgrade.
      if (Object.values(state.users).some((t) => !Number.isFinite(t) || t <= 0)) throw new Error('旧生图限额记录损坏');
      const users = {};
      for (const [actor, at] of Object.entries(state.users)) users[actor] = { day: beijingDay(at), entries: [{ id: `legacy-${actor}-${at}`, at }] };
      return { version: 2, users, events: state.events };
    }
    if (state.version !== 2 || Object.values(state.users).some((u) => !u || typeof u !== 'object' || Array.isArray(u)
        || !/^\d{4}-\d{2}-\d{2}$/.test(u.day) || !Array.isArray(u.entries)
        || u.entries.some((e) => !e || typeof e.id !== 'string' || !e.id || !Number.isFinite(e.at) || e.at <= 0)
        || new Set(u.entries.map((e) => e.id)).size !== u.entries.length)) throw new Error('每日生图限额记录损坏；未清空记录');
    return state;
  }

  reserve(command, chatKey) {
    const now = this.now(), day = beijingDay(now), state = this.readState();
    const eventKey = command.messageId == null ? '' : `${chatKey}:${command.actorId}:${command.messageId}`;
    if (eventKey && state.events[eventKey] && now - state.events[eventKey] < 2 * DAY_MS) return { duplicate: true };
    let usage = state.users[command.actorId];
    if (!usage || usage.day !== day) usage = { day, entries: [] };
    const limited = this.dailyLimit != null && command.actorId !== ADMIN_QQ;
    if (limited && usage.entries.length >= this.dailyLimit) return { exhausted: true };
    for (const [key, time] of Object.entries(state.events)) if (now - time >= 2 * DAY_MS) delete state.events[key];
    for (const [key, user] of Object.entries(state.users)) if (user.day !== day) delete state.users[key];
    const reservationId = randomUUID();
    if (limited) { usage.entries.push({ id: reservationId, at: now }); state.users[command.actorId] = usage; }
    if (eventKey) state.events[eventKey] = now;
    atomicJson(this.stateFile, state); // Synchronous durable reservation before any await.
    return { reservationId, reservedDay: day };
  }

  releaseUnused(job) {
    if (job.imageCreated || this.dailyLimit == null || job.command.actorId === ADMIN_QQ) return;
    try {
      const state = this.readState();
      const usage = state.users[job.command.actorId];
      if (usage?.day !== job.reservedDay) return;
      const entries = usage.entries.filter((e) => e.id !== job.reservationId);
      if (entries.length !== usage.entries.length) {
        if (entries.length) usage.entries = entries; else delete state.users[job.command.actorId];
        atomicJson(this.stateFile, state);
      }
    } catch (error) { this.log(`[${this.commandName}] 限额释放失败：${error.message}`); }
  }

  reply(ctx, command, text) {
    return ctx.sender.sendTextBatch(ctx.chatKey, [text], {
      replyToMessageId: command.messageId, atUserId: ctx.kind === 'group' ? command.actorId : null,
      dedupeKey: `${this.commandName}:${command.actorId}:${command.messageId ?? randomUUID()}`,
      signal: ctx.controller?.signal, canSend: ctx.canSend
    });
  }

  handle(ctx) {
    const { command } = ctx;
    if (!command || command.name !== this.commandName || !/^\d+$/.test(command.actorId) || !/^(group|private):\d+$/.test(ctx.chatKey)) throw new Error('缺少匹配的真实命令上下文');
    const respond = (text) => ({ handled: true, completion: this.reply(ctx, command, text) });
    if (this.stopped) return respond('生图功能正在重新加载，请稍后再试。');
    if (command.inputError) return respond(command.inputError);
    if (!command.request) return respond(`用法：/${this.commandName} 图片要求，例如 /${this.commandName} 一只在月球上喝茶的橘猫`);
    if (command.request.length > 3000) return respond('图片要求太长，请控制在 3000 字以内。');
    if (this.active.size + this.queue.length >= this.maxPending) return respond('当前生图队列已满，请稍后再试；本次未占用额度。');
    let reservation;
    try { reservation = this.reserve(command, ctx.chatKey); }
    catch (error) { this.log(`[${this.commandName}] 无法记录请求：${error.message}`); return respond('生图请求记录暂时不可用，请联系管理员；本次未提交生成。'); }
    if (reservation.duplicate) return { handled: true, completion: Promise.resolve() };
    if (reservation.exhausted) return respond(`你今天的 API 生图额度已用完（每天 ${this.dailyLimit} 张），北京时间零点恢复；也可以用 /comfy 本地生图。`);
    let resolve;
    const completion = new Promise((r) => { resolve = r; });
    const job = { ...ctx, ...reservation, controller: new AbortController(), resolve, attempted: false, imageCreated: false };
    // Start the acknowledgement immediately, even when the image queue is occupied.
    const label = this.commandName === 'comfy' ? '本地生图' : 'API 生图';
    job.ack = this.reply(job, command, `收到，已受理一张${label}，正在准备生成；完成后会发回这里。`);
    job.ack.catch(() => {}); // Handled by run(), including queued acknowledgements.
    this.queue.push(job);
    this.pump();
    return { handled: true, completion };
  }

  pump() {
    while (!this.stopped && this.queue.length && this.active.size < this.maxActive) {
      const job = this.queue.shift();
      this.active.add(job);
      this.run(job).catch((error) => this.log(`[${this.commandName}] 未交付：${error.message}`))
        .finally(() => { this.active.delete(job); job.resolve(); this.pump(); });
    }
  }

  assertReady(job) {
    job.controller.signal.throwIfAborted();
    if (this.stopped || !job.canSend()) throw new Error('请求已停止或目标会话不再允许发送');
  }

  async run(job) {
    const started = this.now();
    try {
      await job.ack; // Never spend image quota before the acknowledgement was delivered.
      this.assertReady(job);
      const references = this.commandName === 'generate' && job.loadImageReferences
        ? await job.loadImageReferences(job.controller.signal) : [];
      this.assertReady(job);
      const prepared = await this.preparePrompt(job.command.request, job.controller.signal, { referenceCount: references.length });
      this.assertReady(job);
      job.attempted = true;
      const image = await this.generateImage({ ...prepared, referenceImages: references }, job.controller.signal);
      job.imageCreated = true;
      const { images: _images, ...commandMetadata } = job.command;
      const saved = await this.saveImage(image, { command: commandMetadata, chatKey: job.chatKey, referenceImageCount: references.length, ...prepared });
      this.assertReady(job);
      await job.sender.sendImage(job.chatKey, saved, {
        note: '按你的要求生成', replyToMessageId: job.command.messageId,
        atUserId: job.kind === 'group' ? job.command.actorId : null,
        signal: job.controller.signal, canSend: job.canSend
      });
      this.log(`[${this.commandName}] 完成 model=${this.model} actor=${job.command.actorId} elapsed=${Math.round((this.now() - started) / 1000)}s`);
    } catch (error) {
      this.releaseUnused(job);
      this.log(`[${this.commandName}] 失败 actor=${job.command.actorId} stage=${job.imageCreated ? 'save-or-delivery' : job.attempted ? 'generation' : 'prepare'}: ${error.message}`);
      if (!job.controller.signal.aborted && job.canSend()) {
        const counted = this.dailyLimit != null && job.command.actorId !== ADMIN_QQ;
        const hint = !job.imageCreated && typeof error.userMessage === 'string' ? error.userMessage : job.imageCreated
          ? `图片已生成，但保存或发送失败，请联系管理员。${counted ? '这张已计入今天的 3 张额度。' : ''}`
          : `本次未能生成图片，请稍后再试。${counted ? '本次未消耗每日额度。' : ''}`;
        await this.reply(job, job.command, hint);
      }
    }
  }

  stop() {
    this.stopped = true;
    for (const job of this.active) job.controller.abort(new Error('生图技能已停用'));
    for (const job of this.queue.splice(0)) {
      job.controller.abort(); this.releaseUnused(job); job.resolve();
    }
  }

  status() { return { command: `/${this.commandName}`, model: this.model, dailyLimit: this.dailyLimit,
    quotaTimezone: 'Asia/Shanghai', active: this.active.size, queued: this.queue.length, stopped: this.stopped }; }
}
