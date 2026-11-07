import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {uninstallModuleFiles} from '../src/module-uninstall.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-uninstall-'));
const dataDir=path.join(root,'data');fs.mkdirSync(dataDir);
try {
 for(const kind of ['skills','plugins']) for(const clearData of [false,true]) {
  const id='comfy-draw', dir=path.join(root,kind,'test-module');fs.mkdirSync(path.join(dir,'storage'),{recursive:true});
  fs.writeFileSync(path.join(dir,'storage','user.json'),'keep-me');fs.writeFileSync(path.join(dir,'index.js'),'code');
  const shared=path.join(dataDir,'memory');fs.mkdirSync(shared,{recursive:true});fs.writeFileSync(path.join(shared,'sentinel'),'untouched');
  const owned=path.join(dataDir,'comfy-draw');fs.mkdirSync(owned,{recursive:true});fs.writeFileSync(path.join(owned,'workflow.json'),'workflow');
  let cfg={skills:{[id]:{enabled:true,key:'private'},other:{enabled:true}}};const events=[];
  const manager={registry:{get:k=>k===id?{dir,kind:kind==='plugins'?'plugin':'skill'}:null},unregister:k=>events.push(k)};
  const updateConfig=patch=>{if(patch.skills.__replace__)cfg.skills=patch.skills.__replace__;else Object.assign(cfg.skills,patch.skills);};
  const rename=fs.renameSync;
  if(kind==='plugins'&&!clearData)fs.renameSync=()=>{const e=Error('cross-device test');e.code='EXDEV';throw e;};
  let result;
  try { result=uninstallModuleFiles({id,clearData,root,dataDir,manager,getConfig:()=>cfg,updateConfig}); } finally {fs.renameSync=rename;}
  assert.deepEqual(events,[id]);assert.equal(fs.existsSync(dir),false);assert.ok(cfg.skills.other);
  if(clearData){assert.equal(cfg.skills[id],undefined);assert.equal(fs.existsSync(owned),false);assert.equal(result.backupPath,null);}
  else {assert.equal(cfg.skills[id].enabled,false);assert.equal(cfg.skills[id].key,'private');assert.equal(fs.readFileSync(path.join(result.backupPath,'storage','user.json'),'utf8'),'keep-me');assert.ok(fs.existsSync(owned));}
  assert.ok(fs.existsSync(path.join(shared,'sentinel')));
 }
 const outside=path.join(root,'outside');fs.mkdirSync(outside);
 assert.throws(()=>uninstallModuleFiles({id:'bad',root,dataDir,manager:{registry:{get:()=>({dir:outside})}}}),/路径/);
 assert.throws(()=>uninstallModuleFiles({id:'missing',root,dataDir,manager:{registry:{get:()=>null}}}),/不存在/);
 console.log('PASS skill/plugin uninstall, retained private config & arbitrary local data, full cleanup, shared-data protection, path rejection');
}finally{fs.rmSync(root,{recursive:true,force:true});}
