import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {bootApp,waitFor} from './_harness.mjs';
const env=await bootApp({config:{wakeDelayMs:25},script:[
  {toolCalls:[{name:'read_skill_guide',args:{skillId:'core-stickers'}}]},
  {toolCalls:[{name:'get_sticker_image',args:{stickerId:'collected-test'}}]},
  {toolCalls:[{name:'get_sticker_image',args:{stickerId:'qq-test'}}]},
  {toolCalls:[{name:'send_message',args:{messages:'两种表情 ID 都看到了'}},{name:'finish',args:{summary:'已看图并回复'}}]}
]});
const dataDir=process.env.QQ_AGENT_DATA_DIR,images=path.join(dataDir,'sticker-images');
fs.mkdirSync(images,{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9uoAAAAASUVORK5CYII=','base64');
const file=path.join(images,'preview.jpg');fs.writeFileSync(file,png);
const local={id:'collected-test',resId:'qq-test',url:pathToFileURL(file).href,desc:'本地表情'};
const entries=[local,{id:'qq-test',url:'https://invalid.example/sticker.png'}];
env.app.stickers.entries=entries;
env.app.stickers.sync=async()=>({entries});
try {
  env.pushGroupMsg(777,'甲','@覆盖Bot 看这张本地收藏表情',9001);
  await waitFor(()=>env.onebotHttp.state.sends.length===1,8000);
  await waitFor(()=>env.app.orchestrator.runningChats.size===0,3000);
  const session=env.app.sessions.listSummaries(20).map(s=>env.app.sessions.get(s.id)).find(s=>s.trigger?.some(m=>m.mid===9001));
  const previews=session.messages.filter(m=>m.toolCall?.name==='get_sticker_image');
  assert.equal(previews.length,2);assert.ok(previews.every(m=>!m.toolCall.isError));
  const parts=env.llm.state.requests[3].messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url');
  assert.equal(parts.length,2);assert.ok(parts.every(p=>p.image_url.url.startsWith('data:image/png;base64,')));
  console.log('PASS local collected ID and QQ alias → real preview tools → image parts delivered to the model → QQ reply');

  const {buildToolDefs}=await import('../src/tools.js');
  const tool=buildToolDefs().find(t=>t.id==='get_sticker_image');
  const preview=url=>tool.execute({stickers:{find:async()=>({id:'probe',url,desc:'测试'})}},{stickerId:'probe'});
  const outside=path.join(dataDir,'outside');fs.mkdirSync(outside);
  const outsideFile=path.join(outside,'private.png');fs.writeFileSync(outsideFile,png);
  const empty=path.join(images,'empty.png');fs.writeFileSync(empty,'');
  const text=path.join(images,'text.png');fs.writeFileSync(text,'private text must never become image input');
  const large=path.join(images,'large.png');fs.writeFileSync(large,'');fs.truncateSync(large,12*1024*1024+1);
  const junction=path.join(images,'escape');fs.symlinkSync(outside,junction,'junction');
  for(const target of [outsideFile,path.join(junction,'private.png'),empty,text,large,path.join(images,'missing.png')]){
    const result=await preview(pathToFileURL(target).href);
    assert.equal(result.isError,true,target);
    assert.equal(typeof result.content,'string');
    assert.ok(!result.content.includes(dataDir),'errors must not expose absolute local paths');
  }
  const moved=await preview('file:///C:/old-deployment/sticker-images/preview.jpg');
  assert.ok(!moved.isError,'old deployment URLs can relocate only to the controlled local collection');
  console.log('PASS local scope, junction escape, missing/empty/non-image/oversize rejection, safe errors and moved-collection recovery');

  const remote=`http://127.0.0.1:${env.onebotHttp.server.address().port}/img.png`;
  assert.equal((await preview(remote)).isError,true,'remote image SSRF guard must remain active');
  await env.request('POST','/api/config',{body:{security:{allowPrivateImageHosts:true}}});
  const fetched=await preview(remote);
  assert.ok(!fetched.isError);assert.ok(fetched.content.some(p=>p.type==='image_url'));
  console.log('PASS HTTP previews still use the existing network validation and image pipeline');
} finally {
  if(fs.existsSync(path.join(images,'escape')))fs.unlinkSync(path.join(images,'escape'));
  await env.teardown();
}
