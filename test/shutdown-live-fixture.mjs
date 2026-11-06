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
const shutdownModule = new URL('../src/shutdown.js', import.meta.url).href;
fs.writeFileSync(path.join(root, 'leaf.mjs'), 'setInterval(()=>{},1000);');
fs.writeFileSync(path.join(root, 'snow', 'index.mjs'), `import net from 'node:net';import {fork} from 'node:child_process'; const leaf=fork(${JSON.stringify(path.join(root,'leaf.mjs'))},[],{stdio:'ignore'}); const s=net.createServer();s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port,leafPid:leaf.pid}));`);
fs.writeFileSync(path.join(root, 'src', 'server.js'), `
import net from 'node:net';import {fork} from 'node:child_process';import {once} from 'node:events';
import {createShutdownLauncher} from ${JSON.stringify(shutdownModule)};
const snow=fork(${JSON.stringify(path.join(root, 'snow', 'index.mjs'))},[],{stdio:['ignore','ignore','inherit','ipc']});
const [info]=await once(snow,'message');const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
const leaf=fork(${JSON.stringify(path.join(root,'leaf.mjs'))},[],{stdio:'ignore'});
const launch=createShutdownLauncher({prepare:async()=>{},stopCore:async()=>{s.close();}});
const job=await launch({root:${JSON.stringify(root)},snowlumaDir:${JSON.stringify(path.join(root,'snow'))},snowPorts:[info.port],agentPort:s.address().port,logDir:${JSON.stringify(path.join(root,'logs'))},origin:'http://127.0.0.1:9876'});
process.send({job,snowPid:snow.pid,leafPids:[info.leafPid,leaf.pid],agentPort:s.address().port,snowPort:info.port});
`);
fs.writeFileSync(path.join(root,'package.json'), '{"type":"module"}');
const agent = fork(path.join(root,'src','server.js'), [], {stdio:['ignore','ignore','inherit','ipc']});
let info;
try {
  [info] = await Promise.race([once(agent,'message'), new Promise((_,reject)=>setTimeout(()=>reject(Error('fixture startup timed out')),15000).unref())]);
  const {job} = info;
  assert.equal((await fetch(job.url+'/status')).status,403);
  assert.equal((await fetch(job.url+'/status',{headers:{'x-shutdown-token':job.token,Origin:'https://foreign.example'}})).status,403);
  const request = (route, method='GET') => fetch(job.url+route,{method,headers:{'x-shutdown-token':job.token,Origin:'http://127.0.0.1:9876'}}).then(r=>r.json());
  const exit = once(agent,'exit');
  let state=await request('/run','POST');
  const deadline=Date.now()+110000;
  while(state.status==='running' && Date.now()<deadline){await new Promise(r=>setTimeout(r,500));state=await request('/status');}
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
