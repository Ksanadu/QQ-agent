import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync(new URL('../ui/app/08-modals.js', import.meta.url),'utf8');
const dom = new JSDOM('<button id="shutdown-btn">停机</button>',{runScripts:'outside-only'});
const w=dom.window, calls=[], waits=[];
let confirmed=false, failure=false, closed=0;
Object.assign(w,{
  uiConfirm:async message=>{assert.equal(message,'确认停机？');return confirmed;},
  api:async(url,args)=>{calls.push({url,args});return {url:'http://127.0.0.1:9999',token:'test'};},
  fetch:async(url,args)=>{calls.push({url,args});return {ok:true,json:async()=>({status:failure?'failed':'done',logs:[{at:Date.now(),text:'[1/2] SnowLuma 已退出'},{at:Date.now(),text:'[2/2] QQ-Agent 已退出，端口已释放'}],logFile:'test.log'})};},
  setTimeout:(fn,ms)=>{waits.push(ms);queueMicrotask(fn);return 1;},
  close:()=>{closed++;}, AbortSignal,
  modelModalShell:({body,foot})=>{const el=w.document.createElement('div');el.innerHTML='<button class="model-modal-close">关闭</button>'+body+foot;el._keyHandler=()=>{};w.document.body.append(el);return el;},
  closeModelModal:el=>el.remove()
});
// Evaluate just this self-contained controller; the application provides its modal shell.
w.eval(source.slice(0,source.indexOf('// ── 模型选择/添加/删除'))+'\nwindow.openShutdownDialog=openShutdownDialog;');
await w.openShutdownDialog();assert.equal(calls.length,0,'cancel never requests shutdown');
confirmed=true;
await w.openShutdownDialog();
assert.equal(calls[0].url,'/api/shutdown');
assert.equal(JSON.parse(calls[0].args.body).confirm,true);
assert.equal(calls[1].args.headers['x-shutdown-token'],'test');
assert.equal(closed,1);assert.deepEqual(waits,[1000,1000,1000]);
assert.match(w.document.body.textContent,/已停机，可手动关闭/);
assert.match(w.document.querySelector('.shutdown-log').textContent,/端口已释放/);
failure=true;waits.length=0;
await w.openShutdownDialog();
assert.equal(closed,1,'failure never closes tab');assert.deepEqual(waits,[]);
assert.match(w.document.body.textContent,/停机未完成/);
assert.equal([...w.document.querySelectorAll('.shutdown-close')].at(-1).disabled,false);
dom.window.close();
console.log('PASS shutdown confirmation, live log output, three-second close attempt, failure retention');
