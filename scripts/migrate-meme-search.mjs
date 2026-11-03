import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RETIRED = ['trendy-memes', 'knowledge-memes', 'hot-trends', 'hot-trend-tracker'];
const BILI_WHEN = '查询网络梗、新词、缩写的含义/出处，或查询分享 B站视频、UP主、字幕、搜索结果、热榜时';

function inside(root, relative) {
  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative);
  if (!target.toLowerCase().startsWith(base.toLowerCase() + path.sep)) throw new Error('Target escaped root');
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Refusing linked migration target');
    const actual = fs.realpathSync(target);
    if (!actual.toLowerCase().startsWith(base.toLowerCase() + path.sep)) throw new Error('Resolved target escaped root');
  }
  return target;
}

export function migrateMemeSearch(root, { apply = false, dataDir = null } = {}) {
  root = fs.realpathSync(root);
  const biliDir = inside(root, 'skills/bilibili');
  const manifestFile = inside(root, 'skills/bilibili/skill.json');
  const guideFile = inside(root, 'skills/bilibili/QUICK_REFERENCE.md');
  if (!fs.existsSync(manifestFile) || !fs.existsSync(guideFile)) throw new Error('Install the existing bilibili skill before removing meme skills');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.id !== 'bilibili') throw new Error('Unexpected Bilibili manifest');
  const section = fs.readFileSync(inside(root, 'doc/bilibili-meme-search.md'), 'utf8').trim();
  let guide = fs.readFileSync(guideFile, 'utf8').replaceAll('\r\n', '\n');
  const marker = '## 网络梗查询：先 B站，资料不足再 Web';
  const previous = guide.indexOf(marker);
  if (previous >= 0) guide = guide.slice(0, previous).trimEnd() + '\n';
  guide = guide.replace(/读取时机：[^\n]*/, `读取时机：${BILI_WHEN}。`)
    .replace('- 一次请求查一次就够，别连环刷；查不到（工具报错）就直说没查到，别编视频标题和数据。',
      '- 普通查询避免重复请求；查梗按下述搜索与阅读步骤执行。查不到或报错如实说明，别编视频标题和数据。');
  guide = guide.trimEnd() + '\n\n' + section + '\n';
  manifest.prompt = { ...(manifest.prompt || {}), guide: { ...(manifest.prompt?.guide || {}), file: 'QUICK_REFERENCE.md', when: BILI_WHEN } };

  const removals = [];
  for (const base of ['skills', 'plugins']) for (const id of RETIRED) {
    const target = inside(root, `${base}/${id}`);
    if (fs.existsSync(target)) removals.push(target);
  }
  const data = path.resolve(dataDir || process.env.QQ_AGENT_DATA_DIR || path.join(root, 'data'));
  let configFile = null, config = null;
  if (fs.existsSync(data)) {
    for (const name of ['trendy-memes', 'knowledge-memes', 'hot-trends', 'hot-trends.json', 'hot-trends.json.tmp']) {
      const target = inside(data, name);
      if (fs.existsSync(target)) removals.push(target);
    }
    configFile = inside(data, 'config.json');
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      for (const id of RETIRED) if (config.skills) delete config.skills[id];
    }
  }
  if (apply) {
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(guideFile, guide);
    if (config) fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    for (const target of removals) {
      // Revalidate the absolute target immediately before recursive deletion.
      const base = target.startsWith(root + path.sep) ? root : fs.realpathSync(data);
      inside(base, path.relative(base, target));
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  return { apply, bilibili: path.relative(root, biliDir), removed: removals.map(p => path.relative(root, p)),
    updated: [path.relative(root, manifestFile), path.relative(root, guideFile)], configUpdated: !!config };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv.find(a => a.startsWith('--root='))?.slice(7) || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(migrateMemeSearch(root, { apply: process.argv.includes('--apply') }), null, 2));
}
