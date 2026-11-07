import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootApp } from './_harness.mjs';
import { launchLocalQQ, localQQConnected } from '../src/local-qq.js';
import { readSnowlumaLogs } from '../src/snowluma-logs.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-settings-features-'));
fs.mkdirSync(path.join(root, 'logs'));
const logFile = path.join(root, 'logs', 'snowluma-2026-11-05.log');
fs.writeFileSync(logFile, Array.from({ length: 15000 }, (_, i) => `15:00:00 INFO 日志 ${i}`).join('\n'));
try {
  let logs = readSnowlumaLogs(root);
  assert.equal(logs.logs.length, 500); assert.ok(logs.logs.at(-1).text.includes('14999'));
  fs.appendFileSync(logFile, '\n15:01:00 INFO 新日志\n');
  assert.ok(readSnowlumaLogs(root).logs.at(-1).text.includes('新日志'));
  assert.equal(readSnowlumaLogs(root, [{ text: 'child', at: 1 }]).source, 'process');
  console.log('PASS external SnowLuma reads bounded file tail and receives new lines; embedded logs remain supported');

  assert.equal(localQQConnected(true, 'ws://127.0.0.1:3001'), true);
  assert.equal(localQQConnected(true, 'ws://remote.example:3001'), false);
  assert.equal(localQQConnected(false, 'ws://localhost:3001'), false);
  const started = [];
  const launched = await launchLocalQQ({ platform: 'win32', env: {}, exists: () => true,
    run: async () => ({ stdout: JSON.stringify({ paths: ['D:\\测试目录\\QQ.exe'] }) }),
    start: (exe, args, options) => {
      started.push({ exe, args, options }); const proc = new EventEmitter(); proc.pid = 123; proc.unref = () => {};
      queueMicrotask(() => proc.emit('spawn')); return proc;
    } });
  assert.equal(launched.ok, true); assert.deepEqual(started[0].args, []);
  assert.ok(!started[0].options.cwd.includes('qq-portable'));
  assert.equal((await launchLocalQQ({ platform: 'win32', run: async () => ({ stdout: '{"pid":321}' }), start: () => { throw Error('must not spawn'); } })).alreadyRunning, true);
  console.log('PASS local QQ launcher uses installed app without alternate data profile; connection indicator requires local OneBot');

  const cliData = path.join(root, 'cli-data'); fs.mkdirSync(cliData);
  fs.writeFileSync(path.join(root, 'index.mjs'), '// QA fixture'); fs.writeFileSync(path.join(root, 'node.exe'), 'QA fixture');
  fs.writeFileSync(path.join(cliData, 'config.json'), JSON.stringify({ snowluma: { dir: root } }));
  const cli = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url)), '--check'], {
    encoding: 'utf8', env: { ...process.env, QQ_AGENT_DATA_DIR: cliData }, windowsHide: true
  });
  assert.match(cli, /SnowLuma 已就绪/); assert.ok(!fs.existsSync(path.join(root, 'runtime')));
  console.log('PASS source setup checks SnowLuma without creating a portable QQ runtime');

  const env = await bootApp({ config: { snowluma: { dir: root, autoLaunch: false }, chatActive: { enabled: true, ttlMinutes: 30 } } });
  try {
    assert.equal(env.app.getConfig().chatActive, undefined);
    env.app.store.appendIncoming('group:456', { mid: 1, senderId: '900', senderName: '测试', text: '历史内容', ts: Date.now() });
    assert.ok((await env.request('GET', '/api/chats')).data.chats.some(c => c.key === 'group:456'));
    assert.equal((await env.request('DELETE', '/api/chats/group_456')).status, 200);
    assert.ok(!(await env.request('GET', '/api/chats')).data.chats.some(c => c.key === 'group:456'));
    env.app.store.appendIncoming('group:456', { mid: 2, senderId: '900', text: '新消息', ts: Date.now() });
    assert.equal(env.app.store.recent('group:456').length, 1);
    assert.equal((await env.request('GET', '/api/snowluma/logs')).data.logs.length, 500);
    assert.equal((await env.request('POST', '/api/qq-portable/stop', { body: {} })).status, 404);
    console.log('PASS archive deletion persists and new messages recreate it; obsolete active mode and QQ kernel routes removed');

    const { buildToolDefs, executeTool } = await import('../src/tools.js');
    const { formatStickerList } = await import('../src/stickers.js');
    const { loadConfig } = await import('../src/config.js');
    const defs = buildToolDefs();
    const stickers = Array.from({ length: 105 }, (_, i) => ({ id: `sticker-${i}`, desc: i % 2 ? '笑' : '哭' }));
    const lookup = async (args) => JSON.parse((await executeTool(defs, {
      stickers: { list: (query, limit) => formatStickerList(stickers, query, limit) }
    }, 'list_stickers', JSON.stringify(args))).content);
    assert.equal((await lookup({})).stickers.length, 24);
    const result = await env.request('POST', '/api/config', { body: { tools: { listStickersLimit: 36 } } });
    assert.equal(result.data.config.tools.listStickersLimit, 36);
    assert.equal(loadConfig().tools.listStickersLimit, 36);
    const filtered = await lookup({ query: '笑' });
    assert.equal(filtered.stickers.length, 36);
    assert.ok(filtered.stickers.every(s => s.desc === '笑'));
    assert.equal((await lookup({ limit: 50 })).stickers.length, 50);
    assert.equal((await lookup({ limit: 200 })).stickers.length, 100);
    assert.equal((await lookup({ limit: -1 })).stickers.length, 1);
    const clamped = await env.request('POST', '/api/config', { body: { tools: { listStickersLimit: 200 } } });
    assert.equal(clamped.data.config.tools.listStickersLimit, 100);
    assert.equal((await lookup({})).stickers.length, 100);
    console.log('PASS list_stickers default persists, takes effect without rebuilding tools, preserves explicit limits and filters');
  } finally { await env.teardown(); }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
