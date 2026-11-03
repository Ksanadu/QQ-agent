import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateMemeSearch } from '../scripts/migrate-meme-search.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-meme-migration-'));
const root = path.join(temp, 'app');
const write = (file, value) => {
  const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
};
write('skills/bilibili/skill.json', { id: 'bilibili', settings: { timeoutSec: 40 }, prompt: { guide: { file: 'QUICK_REFERENCE.md', when: '原说明', priority: 45 } } });
write('skills/bilibili/index.js', '// Preserve the existing read-only Bilibili tools');
write('skills/bilibili/QUICK_REFERENCE.md', '# B站查询\n\n读取时机：原说明。\n\n普通视频用法。\n- 一次请求查一次就够，别连环刷；查不到（工具报错）就直说没查到，别编视频标题和数据。\n');
write('doc/bilibili-meme-search.md', fs.readFileSync(new URL('../doc/bilibili-meme-search.md', import.meta.url), 'utf8'));
write('skills/trendy-memes/kb/memes.json', { entries: [{ title: '旧梗' }] });
write('plugins/hot-trend-tracker/plugin.json', { id: 'hot-trend-tracker' });
write('skills/knowledge-memes/skill.json', { id: 'knowledge-memes' });
write('skills/hot-trends/skill.json', { id: 'hot-trends' });
write('data/trendy-memes/user-added.json', { entries: [{ title: '旧自学习' }] });
write('data/hot-trends.json', { topics: [{ title: '旧热点' }] });
write('data/messages/keep.json', { messages: ['历史聊天保持原样'] });
write('data/image-album/keep.json', { images: ['图库保持原样'] });
const config = { api: { model: 'keep-model', apiKey: 'test-key' }, persona: { roleText: '保留人设' },
  skills: { 'trendy-memes': { enabled: true }, 'hot-trend-tracker': { enabled: false }, bilibili: { timeoutSec: 50 }, 'tts-say': { enabled: true } } };
write('data/config.json', config);
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
try {
  const dry = migrateMemeSearch(root);
  assert.equal(dry.removed.length, 6);
  assert.ok(fs.existsSync(path.join(root, 'skills/trendy-memes')));
  assert.deepEqual(JSON.parse(read('data/config.json')), config);
  assert.ok(!read('skills/bilibili/QUICK_REFERENCE.md').includes('先 B站'));
  console.log('PASS dry-run lists only retired extensions/state and changes nothing');

  const result = migrateMemeSearch(root, { apply: true });
  for (const relative of result.removed) assert.equal(fs.existsSync(path.join(root, relative)), false);
  const after = JSON.parse(read('data/config.json'));
  assert.deepEqual(after.api, config.api); assert.deepEqual(after.persona, config.persona);
  assert.deepEqual(after.skills.bilibili, config.skills.bilibili); assert.deepEqual(after.skills['tts-say'], config.skills['tts-say']);
  assert.equal(after.skills['trendy-memes'], undefined); assert.equal(after.skills['hot-trend-tracker'], undefined);
  assert.match(read('data/messages/keep.json'), /历史聊天保持原样/);
  assert.match(read('data/image-album/keep.json'), /图库保持原样/);
  assert.match(read('skills/bilibili/index.js'), /Preserve/);
  console.log('PASS only meme libraries/collectors are removed; unrelated settings, history, album and Bilibili tools survive');

  const manifest = JSON.parse(read('skills/bilibili/skill.json'));
  assert.match(manifest.prompt.guide.when, /网络梗/); assert.equal(manifest.prompt.guide.priority, 45);
  const guide = read('skills/bilibili/QUICK_REFERENCE.md');
  assert.match(guide, /bilibili__search/); assert.match(guide, /want:"comments"/);
  assert.match(guide, /不再调用 `web_search` 或 `web_fetch`/);
  assert.ok(!guide.includes('一次请求查一次就够'));
  migrateMemeSearch(root, { apply: true });
  assert.equal(read('skills/bilibili/QUICK_REFERENCE.md'), guide);
  console.log('PASS Bilibili-first guide replaces the conflicting one-call advice and migration is idempotent');

  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  fs.symlinkSync(outside, path.join(root, 'skills/trendy-memes'), 'junction');
  assert.throws(() => migrateMemeSearch(root, { apply: true }), /linked|escaped/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
  fs.unlinkSync(path.join(root, 'skills/trendy-memes'));
  console.log('PASS linked targets outside the application are rejected before deletion');

  fs.renameSync(path.join(root, 'skills/bilibili/skill.json'), path.join(root, 'skills/bilibili/disabled.json'));
  write('skills/trendy-memes/keep', 'keep');
  assert.throws(() => migrateMemeSearch(root, { apply: true }), /Install the existing bilibili/);
  assert.ok(fs.existsSync(path.join(root, 'skills/trendy-memes/keep')));
  console.log('PASS missing Bilibili installation stops migration before removing the old provider');
} finally {
  const actual = fs.realpathSync(temp), parent = fs.realpathSync(os.tmpdir());
  assert.ok(actual.toLowerCase().startsWith(parent.toLowerCase() + path.sep));
  fs.rmSync(actual, { recursive: true, force: true });
}
