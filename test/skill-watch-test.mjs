import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-watch-access-'));
process.env.QQ_AGENT_DATA_DIR=path.join(dir,'data');
const {watchPlugins}=await import('../src/plugin-loader.js');
const roots={skills:path.join(dir,'skills'),plugins:path.join(dir,'plugins')};
fs.mkdirSync(roots.skills);fs.mkdirSync(roots.plugins);
const skill=path.join(roots.skills,'watch-demo');fs.mkdirSync(skill);
fs.writeFileSync(path.join(skill,'skill.json'),JSON.stringify({id:'watch-demo',name:'Watch demo',apiVersion:1,entry:'index.mjs'}));
fs.writeFileSync(path.join(skill,'index.mjs'),'export function setup() {}');
const guide=path.join(skill,'QUICK_REFERENCE.md');fs.writeFileSync(guide,'original guide');
const old=new Date(Date.now()-86400000);fs.utimesSync(guide,old,old);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let reloads=0;
const watcher=watchPlugins({roots,log:()=>{},onReload:()=>{reloads++;}});
async function waitForReload(previous){
  const until=Date.now()+6000;
  while(reloads===previous&&Date.now()<until)await sleep(30);
  assert.ok(reloads>previous,'real file changes must still reload skills');
}
try {
  fs.readFileSync(guide,'utf8');await sleep(900);
  assert.equal(reloads,0,'a read-only last-access update must not reload skills');
  const mtime=fs.statSync(guide).mtime;fs.utimesSync(guide,new Date(),mtime);await sleep(900);
  assert.equal(reloads,0,'an access-time-only metadata update must not reload skills');
  fs.writeFileSync(guide,'changed guide with new instructions');await waitForReload(0);
  const beforeAdd=reloads,added=path.join(skill,'extra.md');fs.writeFileSync(added,'new file');await waitForReload(beforeAdd);
  const beforeRemove=reloads;fs.unlinkSync(added);await waitForReload(beforeRemove);
  console.log('PASS read/access-time events ignored; real edits, added files and deleted files still trigger skill reload');
} finally {
  watcher?.close();
  const actual=fs.realpathSync(dir);
  if(!actual.toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase()+path.sep))throw Error('Unsafe cleanup path');
  fs.rmSync(actual,{recursive:true,force:true});
}
