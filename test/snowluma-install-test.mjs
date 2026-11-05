import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {SnowlumaInstaller} from '../src/snowluma-install.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(),'qq-snow-install-'));
const bytes = Buffer.from('release fixture');
const digest = 'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex');
const asset = {name:'SnowLuma-v1-win-x64.zip',size:bytes.length,digest,browser_download_url:'https://github.com/SnowLuma/SnowLuma/releases/download/v1/program.zip'};
let configured = '', calls = 0;
const previous = path.join(root,'old'); fs.mkdirSync(path.join(previous,'config'),{recursive:true}); fs.writeFileSync(path.join(previous,'config','login.json'),'private fixture');
const fake = (entry = asset) => async url => {
  calls++;
  return String(url).includes('/latest') ? new Response(JSON.stringify({tag_name:'v1',assets:[entry]})) : new Response(bytes);
};
const extract = async (zip,dir) => {fs.writeFileSync(path.join(dir,'index.mjs'),'// module');fs.writeFileSync(path.join(dir,'node.exe'),'fixture');};
try {
  const installer = new SnowlumaInstaller({dataDir:root,configure:p=>{configured=p;},fetchImpl:fake(),extract});
  installer.start(previous);installer.start(previous);await installer.task;
  assert.equal(calls,2,'duplicate click must share one install');assert.equal(installer.state.status,'done');
  assert.equal(fs.readFileSync(path.join(configured,'config','login.json'),'utf8'),'private fixture');assert.ok(fs.existsSync(previous));
  const good = configured;
  for (const entry of [{...asset,digest:'sha256:'+'0'.repeat(64)},{...asset,browser_download_url:'https://example.com/evil.zip'},{...asset,digest:null}]) {
    const bad = new SnowlumaInstaller({dataDir:root,configure:p=>{configured=p;},fetchImpl:fake(entry),extract});bad.start(previous);await bad.task;
    assert.equal(bad.state.status,'error');assert.equal(configured,good);
  }
  const rollback = new SnowlumaInstaller({dataDir:root,configure:()=>{throw Error('config failure');},fetchImpl:fake(),extract});rollback.start(previous);await rollback.task;assert.equal(rollback.state.status,'error');
  assert.equal(fs.readdirSync(path.join(root,'dependencies')).filter(n=>n.startsWith('snowluma-')).length,1);
  console.log('PASS duplicate install, verified download, preserved previous login, hash/source/metadata rejection and configure rollback');
} finally {fs.rmSync(root,{recursive:true,force:true});}
