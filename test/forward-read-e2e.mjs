import assert from 'node:assert/strict';
import { bootApp, waitFor } from './_harness.mjs';
const env=await bootApp({config:{wakeDelayMs:100},script:[
 {toolCalls:[{name:'finish',args:{reason:'读取完成'}}]},
 {toolCalls:[{name:'read_forward',args:{messageId:-200}}]},
 {toolCalls:[{name:'finish',args:{reason:'已读到转发'}}]}
]});
const {app,pushGroupMsg,llm}=env;
const calls=[];let available=true;
const nodes=[{sender:{user_id:222,nickname:'转发甲'},message:[{type:'text',data:{text:'真正聊天记录里的文字'}},{type:'image',data:{url:'https://example.com/forward.png',file:'forward.png'}}]}];
const original=app.onebot.call.bind(app.onebot);
app.onebot.call=async(action,args)=>{
 if(action==='get_msg'&&args.message_id===-200){calls.push({action,args});return{message_id:-200,message_type:'group',group_id:456,message:[{type:'forward',data:{res_id:'archive-resource'}}]};}
 if(action==='get_forward_msg'){
  calls.push({action,args});if(available&&['incoming-resource','archive-resource'].includes(args.id))return{messages:nodes};
  throw new Error('download forward message payload is empty');
 }
 return original(action,args);
};
const {buildToolDefs}=await import('../src/tools.js');const tool=buildToolDefs().find(t=>t.id==='read_forward');
const ctx={chatKey:'group:456',store:app.store,onebot:app.onebot};
try{
 pushGroupMsg(777,'提问者','',-101,{message:[{type:'forward',data:{id:'incoming-resource'}},{type:'at',data:{qq:'888'}},{type:'text',data:{text:'看看这段聊天记录'}}]});
 await waitFor(()=>llm.state.requests.length>=1);
 const stored=app.store.findByMid('group:456',-101);assert.match(stored.text,/真正聊天记录里的文字/);assert.equal(stored.media[0].file,'forward.png');
 assert.ok(llm.state.requests[0].messages.some(m=>m.role==='user'&&m.content.includes('真正聊天记录里的文字')));
 assert.ok(calls.some(c=>c.action==='get_forward_msg'&&c.args.id==='incoming-resource'));
 console.log('✓ actual incoming negative-ID forward automatically expands before prompt, with original image metadata');
 await waitFor(()=>app.sessions.listSummaries(10).every(s=>s.status!=='running'&&s.status!=='waiting'));
 app.store.appendIncoming('group:456',{mid:-200,ts:Date.now(),senderId:'777',senderName:'提问者',text:'[合并转发聊天记录]'});app.store.drainUnread('group:456');
 pushGroupMsg(777,'提问者','@覆盖Bot 打开刚才的转发',-201);
 await waitFor(()=>llm.state.requests.length>=3);
 const toolResult=llm.state.requests[2].messages.find(m=>m.role==='tool'&&m.name==='read_forward');assert.match(toolResult.content,/真正聊天记录里的文字/);
 assert.match(app.store.findByMid('group:456',-200).text,/^\[合并转发 共1条\]/);
 const before=calls.length;const cached=await tool.execute(ctx,{messageId:-200});assert.match(cached.content,/读的是存档/);assert.equal(calls.length,before);
 console.log('✓ real model tool resolves archived negative ID, returns exact forward, persists expansion; repeat reads use cache');
 app.store.appendIncoming('private:777',{mid:-900,ts:Date.now(),text:'[合并转发聊天记录]'});
 assert.equal((await tool.execute(ctx,{messageId:-900})).isError,true);
 available=false;app.store.appendIncoming('group:456',{mid:-300,ts:Date.now(),text:'[合并转发聊天记录]'});
 const failed=await tool.execute(ctx,{messageId:-300});assert.equal(failed.isError,true);assert.match(failed.content,/payload is empty/);assert.equal(app.store.findByMid('group:456',-300).text,'[合并转发聊天记录]');
 console.log('✓ inaccessible/cross-chat forwards fail explicitly without fake text or replacing stored content');
 assert.equal(env.onebotHttp.state.sends.length,0,'test never sends any QQ messages');
}finally{await env.teardown();}
