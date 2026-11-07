import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {bootApp,ROOT} from './_harness.mjs';
const dirs=['skills','plugins'].map(kind=>path.join(ROOT,kind,'qa-uninstall-fixture'));
let env;
try {
 for(const [i,dir] of dirs.entries()){
  if(fs.existsSync(dir))throw Error('fixture path already exists');fs.mkdirSync(path.join(dir,'storage'),{recursive:true});
  fs.writeFileSync(path.join(dir,'storage','user.txt'),'retained');
  fs.writeFileSync(path.join(dir,i?'plugin.json':'skill.json'),JSON.stringify({id:`qa-uninstall-${i}`,name:'卸载验收',version:'1.0.0',apiVersion:1,entry:'index.js'}));
  fs.writeFileSync(path.join(dir,'index.js'),`export function setup(api){api.registerTool({id:'test',name:'test',description:'test',parameters:{type:'object',properties:{}},execute:async()=>({ok:true})});} export const providers={'qa.test':()=>true};`);
 }
 env=await bootApp();
 const {skillManager}=await import('../src/skills/manager.js');const {listTools}=await import('../src/tool-registry.js');
 for(const [i,dir] of dirs.entries()){
  const id=`qa-uninstall-${i}`,url=`/api/skills/${id}/uninstall`;
  assert.ok(skillManager.registry.get(id));assert.ok(listTools().some(t=>t.skillId===id));
  assert.equal((await env.request('POST',url,{body:{clearData:false}})).status,400);
  assert.equal((await env.rawRequest('POST',url,{Origin:'https://foreign.example'})).status,403);
  const r=await env.request('POST',url,{body:{confirm:true,clearData:!!i}});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(fs.existsSync(dir),false);
  assert.equal(skillManager.registry.get(id),null);assert.ok(!listTools().some(t=>t.skillId===id));
  if(!i)assert.equal(fs.readFileSync(path.join(r.data.backupPath,'storage','user.txt'),'utf8'),'retained');
  assert.equal((await env.request('POST',url,{body:{confirm:true,clearData:false}})).status,409);
 }
 assert.equal((await env.request('POST','/api/skills/reload')).status,200);
 assert.ok(!listTools().some(t=>t.skillId?.startsWith('qa-uninstall-')));
 console.log('PASS authenticated HTTP uninstall for skills/plugins, tool & capability removal, no resurrection after reload');
} finally {
 if(env)await env.teardown();
 for(const dir of dirs)if(fs.existsSync(dir))fs.rmSync(dir,{recursive:true,force:true});
}

