import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Installed extensions are intentionally excluded from Git. Patch only the
// existing NetEase album card, leaving song cards and user configuration intact.
export function migrateNeteaseAlbumSource(root, { apply = false } = {}) {
  const base = fs.realpathSync(root);
  const file = fs.realpathSync(path.join(base, 'skills/netease-music/index.js'));
  const relative = path.relative(base, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Skill path escaped installation');
  const source = fs.readFileSync(file, 'utf8');
  const album = /(type: 'music',\s*data: \{\s*type: ')(custom|163)(',\s*url: `https:\/\/y\.music\.163\.com\/m\/album\?id=\$\{id\}`)/g;
  if ([...source.matchAll(album)].length !== 1) throw Error('Expected exactly one supported album card; no files changed');
  let next = source.replace(album, (_, before, type, after) => `${before}163${after}`);
  next = next.replace('· album：music custom 段', '· album：music 163 自定义段（不传歌曲 id）');
  next = next.replace(/ \*    QQ 对这张卡显示的来源标签固定是"QQ音乐"，网易云没有官方专辑卡片通道，\r?\n \*    Ksanadu 已接受（2026-10-08：推专辑就发这张，不配解释文字）。/, ' *    SnowLuma 将无 id 的标题/链接等字段透传给签名服务；type=163 生成网易云来源名称与图标。');
  next = next.replace('专辑卡片（custom 段）', '专辑卡片（网易云来源的自定义信息）');
  const changed = next !== source;
  let backup = null;
  if (apply && changed) {
    backup = `${file}.${Date.now()}.bak`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(file, next);
  }
  return { file, changed, applied: apply && changed, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArg = process.argv.find(arg => arg.startsWith('--root='));
  console.log(JSON.stringify(migrateNeteaseAlbumSource(rootArg ? rootArg.slice(7) : process.cwd(), { apply: process.argv.includes('--apply') }), null, 2));
}
