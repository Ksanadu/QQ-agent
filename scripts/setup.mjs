#!/usr/bin/env node
// Install SnowLuma only. QQ is supplied and managed by the user.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ROOT, DATA_DIR, getConfig, updateConfig } from '../src/config.js';
import { SnowlumaInstaller } from '../src/snowluma-install.js';
const cfg = getConfig();
const dependencies = path.join(DATA_DIR, 'dependencies');
const candidates = [cfg.snowluma?.dir, path.join(ROOT, 'snowluma'),
  ...(fs.existsSync(dependencies) ? fs.readdirSync(dependencies).filter(n => n.startsWith('snowluma-')).map(n => path.join(dependencies, n)) : [])].filter(Boolean);
const current = candidates.find(dir => fs.existsSync(path.join(dir, 'index.mjs')) && fs.existsSync(path.join(dir, 'node.exe')));
if (process.argv.includes('--check')) {
  console.log(current ? `SnowLuma 已就绪：${current}` : '尚未安装 SnowLuma，请运行 npm run setup');
  process.exitCode = current ? 0 : 1;
} else if (current && !process.argv.includes('--force')) {
  console.log(`SnowLuma 已就绪：${current}。QQ 请使用本机已安装的客户端。`);
} else {
  const port = (() => { try { return Number(JSON.parse(fs.readFileSync(path.join(current || '', 'config', 'runtime.json'), 'utf8')).webuiPort) || 5099; } catch { return 5099; } })();
  const running = await new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(800, () => done(false));
  });
  if (running) throw new Error('请先停止 SnowLuma，再安装或更新');
  const installer = new SnowlumaInstaller({ dataDir: DATA_DIR, configure: dir => updateConfig({ snowluma: { dir } }) });
  installer.start(current || '');
  await installer.task;
  const result = installer.snapshot();
  if (result.status !== 'done') throw new Error(result.error || 'SnowLuma 安装失败');
  console.log('SnowLuma 安装完成。启动 QQ Agent，在 SnowLuma 页面接入本机 QQ。');
}
