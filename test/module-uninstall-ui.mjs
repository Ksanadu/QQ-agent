import assert from 'node:assert/strict';import fs from 'node:fs';import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('../ui/app/06-settings-render.js',import.meta.url),'utf8');
const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window;
let requests=[],confirmed=false,failure=false,reloaded=0;
Object.assign(w,{state:{skills:[{id:'demo',name:'测试技能'}]},
 modelModalShell:({head,body,foot})=>{const d=w.document.createElement('section');d.innerHTML='<h2>'+head+'</h2>'+body+foot;w.document.body.append(d);return d;},
 closeModelModal:d=>d.remove(),uiConfirm:async()=>confirmed,
 api:async(url,args)=>{requests.push({url,body:JSON.parse(args.body)});if(failure)throw Error('file locked');return {};},
 loadModulePage:async()=>{reloaded++;}
});
w.eval(source.slice(source.indexOf('function openModuleUninstallDialog')));
const tick=()=>new Promise(r=>setTimeout(r,0));
w.openModuleUninstallDialog('demo');assert.equal(w.document.querySelector('input').checked,false);
w.document.querySelector('.module-uninstall-cancel').click();assert.equal(requests.length,0);
w.openModuleUninstallDialog('demo');w.document.querySelector('.module-uninstall-confirm').click();await tick();
assert.deepEqual(requests[0],{url:'/api/skills/demo/uninstall',body:{confirm:true,clearData:false}});assert.equal(reloaded,1);
w.openModuleUninstallDialog('demo');w.document.querySelector('input').checked=true;
w.document.querySelector('.module-uninstall-confirm').click();await tick();assert.equal(requests.length,1);
confirmed=true;failure=true;w.document.querySelector('.module-uninstall-confirm').click();await tick();
assert.equal(requests[1].body.clearData,true);assert.match(w.document.body.textContent,/file locked/);assert.equal(w.document.querySelector('.module-uninstall-confirm').disabled,false);
console.log('PASS uninstall modal defaults to retention, cancellation, cleanup confirmation, success refresh and retryable errors');
dom.window.close();
