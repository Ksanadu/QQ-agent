import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { safeFetchBinaryToFile } from './safe-fetch.js';
import { detectImageType } from './image-type.js';

export class ImageAlbum {
  constructor({ dir = path.join(DATA_DIR, 'image-album'), download = safeFetchBinaryToFile } = {}) {
    this.dir = dir; this.download = download; this.chain = Promise.resolve();
    try { this.items = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { this.items = []; }
    if (!Array.isArray(this.items)) this.items = [];
  }
  async collect(chatKey, source, { imageIndex = 1, title = '', tags = [] } = {}) {
    const work = this.chain.then(async () => {
      if (source.recalled) throw new Error('该图片消息已撤回');
      const images = (source.media || []).filter(x => x.kind === 'image' && x.url);
      if (!Number.isInteger(imageIndex) || !images[imageIndex - 1]) throw new Error('图片序号不存在，序号从 1 开始');
      if (this.items.filter(x => x.chatKey === chatKey).length >= 2000) throw new Error('本会话收藏已达 2000 张上限');
      const image = images[imageIndex - 1];
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = path.join(this.dir, randomUUID() + '.tmp');
      const preview = path.join(this.dir, randomUUID() + '.tmp');
      try {
        await this.download(image.url, tmp, 32 * 1024 * 1024);
        const buffer = fs.readFileSync(tmp), type = detectImageType(buffer);
        if (!type) throw new Error('下载内容不是支持的图片');
        const hash = createHash('sha256').update(buffer).digest('hex');
        let item = this.items.find(x => x.chatKey === chatKey && x.sha256 === hash);
        const duplicate = Boolean(item);
        if (!item) {
          const id = randomUUID(), file = id + type.ext;
          fs.renameSync(tmp, path.join(this.dir, file));
          item = { id, chatKey, file, mime: type.mime, sha256: hash, bytes: buffer.length,
            sourceMessageId: source.mid, senderId: source.senderId, savedAt: Date.now(), title: '', tags: [] };
          const url = new URL(image.url);
          if (url.hostname === 'multimedia.nt.qq.com.cn' && url.pathname === '/download') {
            url.searchParams.set('spec', '720');
            try {
              await this.download(url.href, preview, 8 * 1024 * 1024);
              const ptype = detectImageType(fs.readFileSync(preview));
              if (ptype) { item.preview = id + '-preview' + ptype.ext; fs.renameSync(preview, path.join(this.dir, item.preview)); item.previewMime = ptype.mime; }
            } catch { /* 原图已收藏；预览暂不可用不影响取回 */ }
          }
          this.items.push(item);
        }
        if (title) item.title = String(title).slice(0, 200);
        item.tags = [...new Set([...item.tags, ...(Array.isArray(tags) ? tags : []).map(x => String(x).trim().slice(0, 40)).filter(Boolean)])].slice(0, 20);
        const index = path.join(this.dir, 'index.json'), indexTmp = `${index}.${process.pid}.tmp`;
        fs.writeFileSync(indexTmp, JSON.stringify(this.items)); fs.renameSync(indexTmp, index);
        return { ...this.describe(item), duplicate };
      } finally { for (const p of [tmp, preview]) { try { fs.unlinkSync(p); } catch { /* no partial downloads */ } } }
    });
    this.chain = work.catch(() => {}); return work;
  }
  describe(item) { const { id, title, tags, sourceMessageId, senderId, savedAt, bytes } = item; return { id, title, tags, sourceMessageId, senderId, savedAt, bytes }; }
  search(chatKey, query = '', limit = 20) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter(x => x.chatKey === chatKey && words.every(w => `${x.title} ${x.tags.join(' ')}`.toLowerCase().includes(w)))
      .slice().reverse().slice(0, Math.min(50, Math.max(1, Number(limit) || 20))).map(x => this.describe(x));
  }
  get(chatKey, id) {
    const item = this.items.find(x => x.chatKey === chatKey && x.id === id);
    if (!item) throw new Error('当前会话找不到该收藏图片');
    return { ...item, path: path.join(this.dir, path.basename(item.file)), previewPath: path.join(this.dir, path.basename(item.preview || item.file)) };
  }
}
