import { shareBiliVideo } from './bilibili-card.js';
import { registerTool } from './tool-registry.js';
import fs from 'node:fs';
import { transcribeQQVoice } from './qq-speech.js';
import { findMessageWithReply } from './message-replies.js';
const ok = value => ({ content: typeof value === 'string' ? value : JSON.stringify(value) });
const fail = e => ({ content: `错误：${e.message || e}`, isError: true });

export function registerChatFeatureTools() {
  registerTool({
    id: 'share_bilibili_video', name: '发送B站视频卡片', category: 'messaging',
    description: '把一个真实 B站视频以可点击的 QQ 视频卡片发到当前聊天。输入 BV号、av号或完整视频链接，标题/UP主/封面由程序查询；关键词先用现有 B站搜索工具找到 BV号。不要声称裸链接就是视频卡片。',
    parameters: { type: 'object', properties: { video: { type: 'string' } }, required: ['video'] },
    async execute(ctx, args) { try { return ok(await shareBiliVideo(ctx, args.video)); } catch (e) { return fail(e); } }
  });
  registerTool({
    id: 'collect_chat_image', name: '收藏聊天图片', category: 'query',
    description: '把当前会话指定消息里的图片单独收藏到本群图库，保存原图和名称/内容标签，以后可搜索并取回。不是 QQ 表情收藏。先看图再按实际画面写标签，不要猜图内容；同消息多图用 imageIndex（从1开始）。',
    parameters: { type: 'object', properties: { messageId: { type: ['integer','string'] }, imageIndex: { type: 'integer' }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['messageId','title','tags'] },
    async execute(ctx, args) { try {
      const m = findMessageWithReply(ctx, args.messageId); if (!m || m.recalled) throw new Error('当前会话找不到该图片消息');
      return ok(await ctx.imageAlbum.collect(ctx.chatKey, m, args));
    } catch (e) { return fail(e); } }
  });
  registerTool({
    id: 'search_saved_images', name: '搜索收藏图片', category: 'query',
    description: '按名称和内容标签搜索当前会话的收藏图库；空关键词列出最近收藏。聊天历史图片请用 search_chat_history(imagesOnly=true)，图库尚未收藏的图片不会在这里出现。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    async execute(ctx, args) { try { return ok(ctx.imageAlbum.search(ctx.chatKey, args.query, args.limit)); } catch (e) { return fail(e); } }
  });
  registerTool({
    id: 'get_saved_image', name: '查看收藏图片', category: 'query', requiresVision: true,
    description: '查看图库中一张图片，id 从 search_saved_images 获取。QQ 大图优先看已缓存的中等压缩图。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async execute(ctx, args) { try {
      const item = ctx.imageAlbum.get(ctx.chatKey, args.id);
      if (fs.statSync(item.previewPath).size > 8 * 1024 * 1024) throw new Error('预览过大，可用 send_saved_image 取回原图');
      const bytes = fs.readFileSync(item.previewPath);
      return { content: [{ type: 'text', text: '收藏图片：' + item.title }, { type: 'image_url', image_url: { url: 'data:' + (item.previewMime || item.mime) + ';base64,' + bytes.toString('base64') } }] };
    } catch (e) { return fail(e); } }
  });
  registerTool({
    id: 'send_saved_image', name: '发送收藏图片', category: 'messaging',
    description: '把当前会话图库里的一张原图发回当前聊天，id 从 search_saved_images 获取。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async execute(ctx, args) { try {
      const item = ctx.imageAlbum.get(ctx.chatKey, args.id);
      const result = await ctx.sender.sendImage(ctx.chatKey, { file: item.path }, { note: item.title });
      return ok({ sent: true, messageId: result.message_id });
    } catch (e) { return fail(e); } }
  });
  registerTool({
    id: 'transcribe_voice_message', name: 'QQ语音转文字', category: 'query',
    description: '用 QQ 自带语音识别读取当前会话某条语音。新语音会自动转写；历史语音未识别时可按实际消息 ID 重试，不能猜内容。',
    parameters: { type: 'object', properties: { messageId: { type: ['integer','string'] } }, required: ['messageId'] },
    async execute(ctx, args) { try {
      const m = findMessageWithReply(ctx, args.messageId);
      if (!m || m.recalled || !(m.media?.some(x => x.kind === 'record') || String(m.text).includes('[语音'))) throw new Error('当前会话找不到该语音消息');
      return ok({ messageId: m.mid, text: await transcribeQQVoice(ctx.onebot, m.mid) });
    } catch (e) { return fail(e); } }
  });
  registerTool({
    id: 'search_chat_history', name: '搜索历史聊天', category: 'query',
    description: '搜索当前会话所有保留的历史记录，不限提示词窗口。可组合关键词（空格分隔且全部命中）、发送者 QQ/昵称、北京时间日期。返回真实消息 ID，可用 get_message_detail / get_message_images 深入读取；不要编造未找到的原话。',
    parameters: { type: 'object', properties: {
      query: { type: 'string' }, sender: { type: 'string', description: 'QQ号/昵称，机器人自己填 self' },
      from: { type: 'string', description: 'YYYY-MM-DD 或含时区的 ISO 时间' }, to: { type: 'string' },
      imagesOnly: { type: 'boolean' }, limit: { type: 'integer' }, offset: { type: 'integer' }
    }, required: ['query'] },
    async execute(ctx, args) { try { return ok(ctx.store.search(ctx.chatKey, args)); } catch (e) { return fail(e); } }
  });
  registerTool({
    id: 'set_task_context', name: '保存当前任务对象', category: 'query',
    description: '需要后续继续比较、排序、改写或分步处理时，保存任务摘要和有序的当前会话消息 ID；第二张/第二条按这个数组定位。同一批有多个请求者时必须填写 actorId，不能替换别人的任务；新引用优先，话题变化应保存新任务。',
    parameters: { type: 'object', properties: { summary: { type: 'string' }, messageIds: { type: 'array', items: { type: ['integer','string'] } }, actorId: { type: 'string' } }, required: ['summary','messageIds'] },
    async execute(ctx, args) { try {
      const actors = [...new Set((ctx.triggerEntries || []).filter(m => !m.self).map(m => String(m.senderId)))];
      const actor = args.actorId || (actors.length === 1 ? actors[0] : '');
      if (!actors.includes(actor)) throw new Error('请指定本轮真实请求者的 QQ 号，不能修改其他人的任务');
      if (!ctx.tasks) throw new Error('连续任务存储不可用');
      if (!Array.isArray(args.messageIds) || args.messageIds.length > 12) throw new Error('任务对象最多 12 条');
      const saved = ctx.tasks.save(ctx.chatKey, actor, args.summary, args.messageIds, ctx.store);
      ctx.taskContextExplicit = true; return ok(saved);
    } catch (e) { return fail(e); } }
  });
}
