import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync(new URL('../ui/app/08-modals.js', import.meta.url),'utf8');
const dom = new JSDOM('<button id="shutdown-btn">停机</button>',{runScripts:'outside-only'});
const w=dom.window, calls=[];
let confirmed=false, failure=false;
const location={replace:url=>calls.push({navigation:url})};
Object.assign(w,{
  uiConfirm:async message=>{assert.equal(message,'确认停机并中止当前所有会话？');return confirmed;},
  api:async(url,args)=>{calls.push({url,args});if(failure)throw Error('prepare failed');return {url:'http://127.0.0.1:9999',token:'a'.repeat(64)};},
  modelModalShell:({body,foot})=>{const el=w.document.createElement('div');el.innerHTML='<button class="model-modal-close">关闭</button>'+body+foot;el._keyHandler=()=>{};w.document.body.append(el);return el;},
  closeModelModal:el=>el.remove()
});
// Capture navigation without substituting the controller's behavior or making cross-origin requests.
const controller=source.slice(0,source.indexOf('// ── 模型选择/添加/删除'));
const open=new Function('window','document','uiConfirm','modelModalShell','closeModelModal','api',controller+'\nreturn openShutdownDialog;')(
  {location}, w.document,w.uiConfirm,w.modelModalShell,w.closeModelModal,w.api);
await open();assert.equal(calls.length,0,'cancel never requests shutdown');
confirmed=true;await open();
assert.equal(calls[0].url,'/api/shutdown');
assert.equal(JSON.parse(calls[0].args.body).confirm,true);
assert.equal(calls[1].navigation,'http://127.0.0.1:9999/#'+'a'.repeat(64));
failure=true;await open();
assert.match(w.document.body.textContent,/停机未完成/);
assert.equal([...w.document.querySelectorAll('.shutdown-close')].at(-1).disabled,false);
dom.window.close();

const page=fs.readFileSync(new URL('../ui/shutdown/shutdown.js',import.meta.url),'utf8').replace('void runShutdownPage();','');
for(const state of ['done','failed','missing-token']) {
  const doc=new JSDOM('<div class="shutdown-status"></div><pre class="shutdown-log"></pre>');
  const waits=[], requests=[];let closed=0, stripped=false;
  const run=new Function('document','location','history','fetch','AbortSignal','setTimeout','window',page+'\nreturn runShutdownPage;')(
    doc.window.document,{hash:state==='missing-token'?'':'#'+'a'.repeat(64),pathname:'/'},
    {replaceState:(_,__,url)=>{assert.equal(url,'/');stripped=true;}},
    async(url,args)=>{requests.push({url,args});return {ok:true,json:async()=>({status:state,logs:[{at:Date.now(),text:'进程退出，端口已释放'}],logFile:'test.log'})};},
    AbortSignal,(fn,ms)=>{waits.push(ms);queueMicrotask(fn);return 1;},{close:()=>{closed++;}}
  );
  await run();assert.ok(stripped);
  if(state==='missing-token'){assert.equal(requests.length,0);assert.match(doc.window.document.body.textContent,/凭据已失效/);}
  else {assert.equal(requests[0].url,'/run');assert.equal(requests[0].args.headers['x-shutdown-token'],'a'.repeat(64));}
  assert.equal(closed,state==='done'?1:0);
  assert.deepEqual(waits,state==='done'?[1000,1000,1000]:[]);
  assert.match(doc.window.document.body.textContent,state==='done'?/已停机，可手动关闭/:/停机未完成/);
  doc.window.close();
}
console.log('PASS confirmation, cancel, same-tab helper navigation, same-origin logs, three-second close and failure retention');
