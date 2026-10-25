import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bootApp,waitFor} from './_harness.mjs';
const env=await bootApp({config:{wakeDelayMs:25,skills:{'hot-trend-tracker':{enabled:false},favor:{enabled:false}}},script:[
 {toolCalls:[{name:'guide-demo__lookup',args:{}}]},
 {toolCalls:[{name:'read_skill_guide',args:{skillId:'guide-demo'}}]},
 {toolCalls:[{name:'guide-demo__lookup',args:{}}]},
 {toolCalls:[{name:'send_message',args:{messages:'查到了实际资料'}}]}
]});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-guide-e2e-'));
const {skillManager}=await import('../src/skills/manager.js');
const {registerTool}=await import('../src/tool-registry.js');
const {normalizeManifest}=await import('../src/skills/manifest.js');
const marker='GUIDE_DETAIL_ONLY_AFTER_READ';let calls=0;
try{
 fs.writeFileSync(path.join(dir,'QUICK_REFERENCE.md'),marker+'\n使用查询结果，不得编造。');
 skillManager.register({manifest:normalizeManifest({id:'guide-demo',name:'Demo lookup',prompt:{guide:{file:'QUICK_REFERENCE.md',when:'需要查测试资料时'}}}).manifest,dir,kind:'skill'});
 registerTool({id:'guide-demo__lookup',name:'测试查询',skillId:'guide-demo',parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>{calls++;return {content:'实际资料:123'};}});
 env.app.orchestrator.refreshToolDefs();
 env.pushGroupMsg(777,'甲','@测试机 查一下资料',1001);
 await waitFor(()=>env.onebotHttp.state.sends.length>0,8000);
 await waitFor(()=>env.app.orchestrator.runningChats.size===0,3000);
 assert.equal(calls,1,'未读时的第一次技能调用必须被拦截');
 const req=env.llm.state.requests;
 assert.equal(req[0].messages.find(x=>x.role==='system').content.includes(marker),false);
 assert.match(req[0].messages.find(x=>x.role==='system').content,/read_skill_guide/);
 assert.ok(req[1].messages.some(x=>x.role==='tool'&&String(x.content).includes('请先调用 read_skill_guide')));
 assert.ok(req[2].messages.some(x=>x.role==='tool'&&String(x.content).includes(marker)));
 assert.ok(req[3].messages.some(x=>x.role==='tool'&&String(x.content).includes('实际资料:123')));
 const start=req.length;
 const imageDir=path.join(process.env.QQ_AGENT_DATA_DIR,'sticker-images');fs.mkdirSync(imageDir,{recursive:true});
 const imageFile=path.join(imageDir,'on-demand.png');fs.writeFileSync(imageFile,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9uoAAAAASUVORK5CYII=','base64'));
 const sticker={id:'ONLY_STICKER_TEST_ID',desc:'按需查出的表情',url:'file:///'+imageFile.replaceAll('\\','/')};
 env.app.stickers.sync=async()=>({entries:[sticker]});
 env.app.stickers.list=async()=>[sticker];
 env.app.stickers.find=async id=>id===sticker.id?sticker:null;
 env.app.stickers.ensureSendable=async s=>s;
 env.llm.state.script.push(
  {toolCalls:[{name:'read_skill_guide',args:{skillId:'core-stickers'}}]},
  {toolCalls:[{name:'list_stickers',args:{query:'可爱'}}]},
  {toolCalls:[{name:'send_sticker',args:{stickerId:sticker.id}}]}
 );
 env.pushGroupMsg(777,'甲','@测试机 发个可爱表情',1002);
 await waitFor(()=>env.onebotHttp.state.sends.some(s=>s.body.message.some(m=>m.type==='image')),8000);
 await waitFor(()=>env.app.orchestrator.runningChats.size===0,3000);
 const input=env.llm.state.requests[start].messages;
 assert.ok(!input.some(m=>String(m.content).includes('ONLY_STICKER_TEST_ID')),'未查询前不自动附带表情目录');
 assert.ok(!input.some(m=>String(m.content).includes('【可用表情包】')));
 assert.ok(env.llm.state.requests[start+1].messages.some(m=>m.role==='tool'&&String(m.content).includes('runtime')));
 assert.ok(env.llm.state.requests[start+2].messages.some(m=>m.role==='tool'&&String(m.content).includes(sticker.id)));
 console.log('PASS real ingest → short skill index → blocked unread call → read guide tool → skill execution → queued QQ reply; full guide absent from initial system prompt');
 console.log('PASS core sticker guide → on-demand catalogue → real queued sticker send; no automatic catalogue injection');
}finally{skillManager.unregister('guide-demo');await env.teardown();fs.rmSync(dir,{recursive:true,force:true});}
