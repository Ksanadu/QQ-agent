// Executes the real Windows shutdown path against disposable Node processes only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'win32') { console.log('SKIP Windows shutdown integration'); process.exit(0); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-shutdown-test-'));
fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'snow'));
const browserMode = process.argv.includes('--browser');
const uiRoot = fileURLToPath(new URL('../ui/', import.meta.url));
const shutdownModule = new URL('../src/shutdown.js', import.meta.url).href;
fs.writeFileSync(path.join(root, 'leaf.mjs'), 'setInterval(()=>{},1000);');
fs.writeFileSync(path.join(root, 'snow', 'index.mjs'), `import net from 'node:net';import {fork} from 'node:child_process'; const leaf=fork(${JSON.stringify(path.join(root,'leaf.mjs'))},[],{stdio:'ignore'}); const s=net.createServer();s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port,leafPid:leaf.pid}));`);
fs.writeFileSync(path.join(root, 'src', 'server.js'), `
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {fork} from 'node:child_process';import {once} from 'node:events';
import {createShutdownLauncher} from ${JSON.stringify(shutdownModule)};
const snow=fork(${JSON.stringify(path.join(root, 'snow', 'index.mjs'))},[],{stdio:['ignore','ignore','inherit','ipc']});
const [info]=await once(snow,'message');
const uiRoot=${JSON.stringify(uiRoot)};
const csp=fs.readFileSync(path.join(uiRoot,'index.html'),'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const controller=fs.readFileSync(path.join(uiRoot,'app','08-modals.js'),'utf8').split('// ── 模型选择/添加/删除')[0];
const testScript=\`
async function uiConfirm(text){const d=document.createElement('dialog');const p=document.createElement('p');p.textContent=text;d.append(p);const yes=document.createElement('button');yes.textContent='确认';const no=document.createElement('button');no.textContent='取消';d.append(no,yes);document.body.append(d);d.showModal();return new Promise(resolve=>{yes.onclick=()=>{d.remove();resolve(true);};no.onclick=()=>{d.remove();resolve(false);};});}
function modelModalShell({head,body,foot}){const d=document.createElement('section');d.innerHTML='<h2>'+head+'</h2><button class="model-modal-close">关闭</button>'+body+foot;d._keyHandler=()=>{};document.body.append(d);return d;}
function closeModelModal(d){d.remove();}
async function api(url,args){const r=await fetch(url,args);return r.json();}
\`+controller+"\\ndocument.querySelector('#shutdown-btn').onclick=openShutdownDialog;";
let launch;
const s=http.createServer(async(req,res)=>{
  if(req.url==='/api/shutdown'&&req.method==='POST'){
    const job=await launch({root:${JSON.stringify(root)},snowlumaDir:${JSON.stringify(path.join(root,'snow'))},snowPorts:[info.port],agentPort:s.address().port,logDir:${JSON.stringify(path.join(root,'logs'))},origin:'http://127.0.0.1:'+s.address().port});
    process.send({job});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(job));return;
  }
  res.setHeader('Content-Security-Policy',csp);
  if(req.url==='/test.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(testScript);return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>隔离停机验收</title><h1>隔离停机验收</h1><p>仅停止测试进程，不涉及真实机器人。使用主页面原有 CSP。</p><button id="shutdown-btn">停机</button><script src="/test.js"></script></html>');
});
await new Promise(r=>s.listen(0,'127.0.0.1',r));
const leaf=fork(${JSON.stringify(path.join(root,'leaf.mjs'))},[],{stdio:'ignore'});
launch=createShutdownLauncher({prepare:async()=>{},stopCore:async()=>{s.close();}});
process.send({snowPid:snow.pid,leafPids:[info.leafPid,leaf.pid],agentPort:s.address().port,snowPort:info.port});
`);
fs.writeFileSync(path.join(root,'package.json'), '{"type":"module"}');
const agent = fork(path.join(root,'src','server.js'), [], {stdio:['ignore','ignore','inherit','ipc']});
let info;
try {
  [info] = await Promise.race([once(agent,'message'), new Promise((_,reject)=>setTimeout(()=>reject(Error('fixture startup timed out')),15000).unref())]);
  const jobReady = once(agent,'message');
  if(browserMode) console.log(`BROWSER_FIXTURE_URL=http://127.0.0.1:${info.agentPort}`);
  else await fetch(`http://127.0.0.1:${info.agentPort}/api/shutdown`,{method:'POST'});
  const [{job}] = await jobReady;
  const page = await fetch(job.url+'/');
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await page.text(), /停机日志/);
  assert.equal((await fetch(job.url+'/shutdown.js')).status,200);
  assert.equal((await fetch(job.url+'/../package.json')).status,403);
  assert.equal((await fetch(job.url+'/status')).status,403);
  assert.equal((await fetch(job.url+'/status',{headers:{'x-shutdown-token':job.token,Origin:'https://foreign.example'}})).status,403);
  const request = (route, method='GET') => fetch(job.url+route,{method,headers:{'x-shutdown-token':job.token,Origin:job.url}}).then(r=>r.json());
  const exit = once(agent,'exit');
  let state=browserMode ? await request('/status') : await request('/run','POST');
  const deadline=Date.now()+110000;
  while(['ready','running'].includes(state.status) && Date.now()<deadline){await new Promise(r=>setTimeout(r,500));state=await request('/status');}
  console.log(state.logs.map(l=>l.text).join('\n'));
  assert.equal(state.status,'done');
  await exit;
  assert.ok(fs.readFileSync(state.logFile,'utf8').includes('停机完成'));
  assert.equal((await request('/status')).status,'done','helper survives agent exit to deliver final logs');
  for(const pid of info.leafPids) assert.throws(()=>process.kill(pid,0),'descendant must have exited');
  await new Promise(r=>setTimeout(r,11000));
  await assert.rejects(fetch(job.url+'/status'), 'shutdown helper must exit too');
  console.log('PASS real isolated SnowLuma/agent process trees exited, ports released, authenticated final logs survive shutdown');
} finally {
  if (agent.exitCode === null && agent.signalCode === null) agent.kill();
  if (info?.snowPid) { try { process.kill(info.snowPid); } catch {} }
  for(const pid of info?.leafPids || []) { try { process.kill(pid); } catch {} }
}
