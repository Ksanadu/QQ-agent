import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runShutdown } from './shutdown-plan.js';

const ps = fileURLToPath(new URL('./shutdown-processes.ps1', import.meta.url));
const pageDir = fileURLToPath(new URL('../ui/shutdown/', import.meta.url));
const pageAssets = new Map([['/', ['index.html', 'text/html']], ['/shutdown.js', ['shutdown.js', 'text/javascript']], ['/shutdown.css', ['shutdown.css', 'text/css']]]);
const token = crypto.randomBytes(32).toString('hex');
let config, file, server, expiry, status = 'ready';
const logs = [];
function log(text) {
  const line = { at: Date.now(), text };
  logs.push(line);
  fs.appendFileSync(file, `[${new Date(line.at).toISOString()}] ${text}\n`, 'utf8');
}
function callPS(input) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', ps], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(Error('进程检查超时')); }, 25000);
    p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { err += b; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('exit', code => { clearTimeout(timer); if (code !== 0) return reject(Error(err.trim() || `进程管理退出码 ${code}`)); try { resolve(JSON.parse(out.replace(/^\uFEFF/, ''))); } catch { reject(Error('进程检查返回格式无效')); } });
    p.stdin.end(JSON.stringify(input));
  });
}
function command(name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.off('message', onMessage); reject(Error(`${name} 超时，未继续强制停机`)); }, 20000);
    const onMessage = m => { if (m.type !== name) return; clearTimeout(timer); process.off('message', onMessage); m.error ? reject(Error(m.error)) : resolve(); };
    process.on('message', onMessage);
    if (!process.connected) { clearTimeout(timer); process.off('message', onMessage); reject(Error('QQ-Agent 控制连接已断开')); return; }
    process.send({ type: name });
  });
}
process.once('message', async m => {
  config = { ...m.config, helperPid: process.pid };
  fs.mkdirSync(config.logDir, { recursive: true });
  file = path.join(config.logDir, `shutdown-${Date.now()}.log`);
  log('停机助手已就绪。');
  server = http.createServer((req, res) => {
    const ownHost = `127.0.0.1:${server.address().port}`;
    const ownOrigin = `http://${ownHost}`;
    if (req.headers.host !== ownHost || (req.headers.origin && req.headers.origin !== ownOrigin)) {
      res.writeHead(403); res.end(); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const asset = pageAssets.get(req.url);
    if (asset && req.method === 'GET') {
      res.setHeader('Content-Type', asset[1] + '; charset=utf-8');
      res.end(fs.readFileSync(path.join(pageDir, asset[0]))); return;
    }
    if (req.headers['x-shutdown-token'] !== token) { res.writeHead(403); res.end(); return; }
    if (req.url === '/run' && req.method === 'POST' && status === 'ready') {
      status = 'running'; clearTimeout(expiry);
      expiry = setTimeout(() => process.exit(1), 180000);
      void runShutdown({ config,
        inspect: () => callPS({ action: 'inspect', ports: [...config.snowPorts, config.agentPort] }),
        terminate: p => callPS({ action: 'stop', processes: [{ pid: p.pid, started: p.started }] }),
        prepare: () => command('prepare'), stopCore: () => command('stop-core'), log
      }).then(() => { status = 'done'; }).catch(e => { status = 'failed'; log(`停机失败：${e.message}`); }).finally(() => {
        clearTimeout(expiry); expiry = setTimeout(() => { server.close(); process.exit(status === 'done' ? 0 : 1); }, status === 'done' ? 10000 : 60000);
      });
    } else if (!(req.url === '/status' && req.method === 'GET') && !(req.url === '/run' && req.method === 'POST')) {
      res.writeHead(404); res.end(); return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ status, logs, logFile: file }));
  });
  server.listen(0, '127.0.0.1', () => {
    expiry = setTimeout(() => process.exit(0), 60000);
    process.send({ type: 'ready', url: `http://127.0.0.1:${server.address().port}`, token });
  });
});
