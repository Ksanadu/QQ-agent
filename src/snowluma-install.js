import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run = promisify(execFile);
const API = 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest';

export class SnowlumaInstaller {
  constructor({dataDir, configure, fetchImpl = fetch, extract = extractArchive}) {
    this.dataDir = dataDir; this.configure = configure; this.fetch = fetchImpl; this.extract = extract;
    this.state = {status:'idle', received:0, total:0, version:'', error:''};
  }
  snapshot() { return {...this.state}; }
  start(previous = '') {
    if (this.state.status === 'installing') return this.snapshot();
    this.state = {status:'installing', phase:'release', received:0, total:0, version:'', error:''};
    this.task = this.install(previous).catch(e => { this.state.status = 'error'; this.state.error = String(e.message).slice(0,500); });
    return this.snapshot();
  }
  async install(previous) {
    if (process.platform !== 'win32') throw Error('此安装入口用于 Windows x64');
    const meta = await this.fetch(API, {headers:{'User-Agent':'QQ-Agent'}, signal:AbortSignal.timeout(30000)});
    if (!meta.ok) throw Error(`GitHub Release HTTP ${meta.status}`);
    const release = await meta.json();
    const asset = release.assets?.find(a => /^SnowLuma-.*-win-x64\.zip$/i.test(a.name) && !/lite/i.test(a.name));
    if (release.draft || release.prerelease || !asset) throw Error('最新稳定版没有 Windows x64 完整安装包');
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw Error('GitHub 未提供安装包 SHA256 摘要');
    if (!String(asset.browser_download_url).startsWith('https://github.com/SnowLuma/SnowLuma/releases/download/')) throw Error('下载地址不是 SnowLuma 官方 Release');
    if (!(asset.size > 0 && asset.size < 512*1024*1024)) throw Error('安装包大小无效');
    this.state.version = String(release.tag_name); this.state.total = asset.size; this.state.phase = 'download';
    const base = path.join(this.dataDir,'dependencies'); fs.mkdirSync(base,{recursive:true});
    const stage = fs.mkdtempSync(path.join(base,'.snowluma-install-'));
    const archive = path.join(stage,'release.zip'), unpack = path.join(stage,'program');
    try {
      const response = await this.fetch(asset.browser_download_url, {signal:AbortSignal.timeout(300000)});
      if (!response.ok || !response.body) throw Error(`安装包下载 HTTP ${response.status}`);
      const hash = crypto.createHash('sha256'); const fd = fs.openSync(archive,'wx');
      try {
        for await (const chunk of response.body) {
          this.state.received += chunk.length;
          if (this.state.received > asset.size) throw Error('下载大小超过 Release 声明');
          hash.update(chunk); fs.writeSync(fd,chunk);
        }
      } finally { fs.closeSync(fd); }
      if (this.state.received !== asset.size || hash.digest('hex') !== asset.digest.slice(7).toLowerCase()) throw Error('安装包大小或 SHA256 校验失败');
      this.state.phase = 'extract'; fs.mkdirSync(unpack);
      await this.extract(archive,unpack);
      let program = unpack;
      if (!fs.existsSync(path.join(program,'index.mjs'))) {
        const dirs = fs.readdirSync(unpack,{withFileTypes:true}).filter(d=>d.isDirectory());
        if (dirs.length === 1) program = path.join(unpack,dirs[0].name);
      }
      for (const name of ['index.mjs','node.exe']) if (!fs.statSync(path.join(program,name)).isFile()) throw Error('安装包缺少 '+name);
      // 新版本放独立目录，旧程序与登录数据在切换成功前保持完整。
      for (const name of ['config','data']) {
        if (previous && fs.existsSync(path.join(previous,name))) fs.cpSync(path.join(previous,name),path.join(program,name),{recursive:true});
      }
      const target = path.join(base,'snowluma-'+crypto.randomUUID());
      fs.renameSync(program,target);
      try { await this.configure(target); }
      catch(e) { fs.rmSync(target,{recursive:true,force:true}); throw e; }
      this.state.status = 'done'; this.state.phase = 'ready';
    } finally {
      // stage 是由 mkdtemp 在固定 dependencies 下直接创建的绝对路径。
      if (path.dirname(stage) !== path.resolve(base)) throw Error('Unexpected staging path');
      fs.rmSync(stage,{recursive:true,force:true});
    }
  }
}

async function extractArchive(archive, destination) {
  await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    fileURLToPath(new URL('./snowluma-extract.ps1',import.meta.url)),archive,destination],{windowsHide:true,timeout:120000});
}
