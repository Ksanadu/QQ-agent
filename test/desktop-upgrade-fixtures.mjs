import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Usage: node test/desktop-upgrade-fixtures.mjs prepare|verify <.../desktop-qa/install-dir>
// Run prepare on the old installed version, install the candidate, then run verify.
const mode = process.argv[2];
if (!['prepare', 'verify'].includes(mode) || !process.argv[3]) throw Error('Specify prepare|verify and an isolated desktop-qa install directory');
const dir = fs.realpathSync(path.resolve(process.argv[3]));
if (!dir.split(path.sep).some(part => part.toLowerCase() === 'desktop-qa')) throw Error('Fixture writes are restricted to an explicit desktop-qa directory');
const record = path.join(path.dirname(dir), path.basename(dir) + '-fixture-hashes.json');
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
if (mode === 'prepare') {
  const fixtures = {
    'data/config.json': JSON.stringify({ api: { provider: 'qa', model: 'desktop-qa', baseUrl: 'https://example.test/v1', apiKey: '' }, server: { port: 3399, autoStart: false, closeToTray: true }, snowluma: { autoLaunch: false, wsUrl: 'ws://127.0.0.1:39801', httpUrl: 'http://127.0.0.1:39800', dir: '' }, allow: { groups: ['900001'], private: [] }, persona: { botName: '验收机器人', roleText: '升级后应保留的人设' }, store: { keywords: ['验收', 'hello'] }, skills: { 'qa-upgrade-plugin': { enabled: false }, 'qa-upgrade-skill': { enabled: false } } }),
    'data/memory/group_900001.json': JSON.stringify({ chatKey: 'group:900001', members: {} }),
    'data/messages/group_900001.json': JSON.stringify({ chatKey: 'group:900001', nextLocalId: 2, messages: [{ id: 1, mid: 42, ts: Date.now(), senderId: '900002', senderName: '验收群友', text: '升级后应保留的存档', read: true }] }),
    'data/stickers.json': '[]',
    'data/dependencies/snowluma-fixture/config/login.json': '{"qaLogin":"sample-not-real"}',
    'resources/app/plugins/qa-upgrade-plugin/plugin.json': '{"id":"qa-upgrade-plugin","name":"升级验收插件","version":"1.0.0","apiVersion":1}',
    'resources/app/plugins/qa-upgrade-plugin/index.js': 'export function setup() {}',
    'resources/app/skills/qa-upgrade-skill/skill.json': '{"id":"qa-upgrade-skill","name":"升级验收技能","version":"1.0.0","apiVersion":1}',
    'resources/app/skills/qa-upgrade-skill/index.js': 'export function setup() {}',
    'resources/app/skills/bilibili/data/upgrade-sample.json': '{"qaCookie":"sample-not-real"}'
  };
  const hashes = {};
  for (const [file, content] of Object.entries(fixtures)) { const target = path.join(dir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); hashes[file] = hash(target); }
  const builtin = 'resources/app/skills/bilibili/index.js';
  fs.appendFileSync(path.join(dir, builtin), '\n// OLD BUILTIN MUST NOT WIN\n');
  hashes[builtin] = hash(path.resolve('dist/win-unpacked/resources/app/skills/bilibili/index.js'));
  fs.writeFileSync(record, JSON.stringify(hashes, null, 2)); console.log(`Prepared ${Object.keys(hashes).length} isolated fixtures`);
} else {
  const hashes = JSON.parse(fs.readFileSync(record)); const failed = [];
  for (const [file, expected] of Object.entries(hashes)) { const target = path.join(dir, file); if (!fs.existsSync(target) || hash(target) !== expected) failed.push(file); }
  console.log(JSON.stringify({ version: JSON.parse(fs.readFileSync(path.join(dir, 'resources/app/package.json'))).version, checked: Object.keys(hashes).length, failed }));
  if (failed.length) process.exitCode = 1;
}
