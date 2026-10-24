import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-forward-read-'));
process.env.QQ_AGENT_DATA_DIR=dataDir;
const { readForwardMessage }=await import('../src/forward-messages.js');
const { OneBotClient, expandForwardNodes }=await import('../src/onebot.js');
const nodes=[{sender:{user_id:222,nickname:'原发言人'},message:[{type:'text',data:{text:'准确的转发文字'}},{type:'image',data:{url:'https://example.com/inside.png',file:'inside.png'}}]}];
const forward=id=>[{type:'forward',data:{id}}];
const calls=[];
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const part of req) raw+=part;
 const args=JSON.parse(raw||'{}');calls.push({action:req.url.slice(1),args});
 res.writeHead(200,{'content-type':'application/json'});
 const ok=data=>res.end(JSON.stringify({status:'ok',retcode:0,data}));
 if(req.url==='/get_msg') return ok({message_id:args.message_id,message_type:'group',group_id:456,message:forward('real-resource')});
 if(req.url==='/get_forward_msg'&&args.id==='real-resource') return ok({messages:nodes});
 res.end(JSON.stringify({status:'failed',retcode:100,wording:'download forward message payload is empty'}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const client=new OneBotClient({httpUrl:`http://127.0.0.1:${server.address().port}`});
try{
 const result=await readForwardMessage({onebot:client,messageId:-13366002,chatKey:'group:456'});
 assert.deepEqual(result,nodes);
 assert.deepEqual(calls,[{action:'get_msg',args:{message_id:-13366002}},{action:'get_forward_msg',args:{id:'real-resource'}}]);
 calls.length=0;
 await readForwardMessage({onebot:client,messageId:-101,message:forward('real-resource'),chatKey:'group:456'});
 assert.deepEqual(calls,[{action:'get_forward_msg',args:{id:'real-resource'}}],'fresh incoming segment avoids extra card lookup');
 const expanded=await expandForwardNodes(result);assert.match(expanded.text,/准确的转发文字/);assert.equal(expanded.media[0].file,'inside.png');
 console.log('✓ real HTTP client resolves negative QQ IDs to resource IDs; incoming resource fast path; text/images preserved');
}finally{await new Promise(resolve=>server.close(resolve));}

let refreshed=0;const attempts=[];
const refreshClient={selfId:'888',async getMsg(mid){refreshed++;return{message_id:mid,group_id:456,message:forward('fresh')}},async call(action,args){attempts.push(args);if(args.id==='fresh')return{data:{messages:nodes}};throw new Error('stale resource')}};
assert.deepEqual(await readForwardMessage({onebot:refreshClient,messageId:-20,message:'[CQ:forward,id=old]',chatKey:'group:456'}),nodes);
assert.equal(refreshed,1);assert.deepEqual(attempts,[{id:'old'},{id:'fresh'}]);
console.log('✓ stale incoming resource is refreshed via get_msg; CQ string and wrapped response supported');

const fallbackCalls=[];
const fallbackClient={async getMsg(){throw new Error('get_msg unavailable')},async call(action,args){fallbackCalls.push(args);return{messages:nodes}}};
assert.deepEqual(await readForwardMessage({onebot:fallbackClient,messageId:123,chatKey:'private:777'}),nodes);
assert.deepEqual(fallbackCalls,[{message_id:123}]);
assert.deepEqual(await readForwardMessage({onebot:fallbackClient,messageId:-123,chatKey:'private:777'}),nodes);
assert.deepEqual(fallbackCalls.at(-1),{message_id:-123});
console.log('✓ message_id fallback supports positive/negative IDs on implementations without get_msg resources');

for(const message of [{message_id:-99,group_id:456},{message_id:-20,group_id:789},{message_id:-20,message_type:'private',group_id:456}]){
 let downloads=0;
 await assert.rejects(readForwardMessage({onebot:{async getMsg(){return{...message,message:forward('wrong')}},async call(){downloads++;return{messages:nodes}}},messageId:-20,chatKey:'group:456'}),/不一致|不属于/);
 assert.equal(downloads,0,'scope mismatch must not be bypassed by fallback');
}
for(const message of [{group_id:456},{sender:{user_id:999}},{sender:{user_id:888},target_id:999}]){
 await assert.rejects(readForwardMessage({onebot:{selfId:'888',async getMsg(){return{message_id:-20,...message,message:forward('wrong')}}},messageId:-20,chatKey:'private:777'}),/不属于/);
}
for(const id of [0,null,'1e3','1.5','9007199254740993']) await assert.rejects(readForwardMessage({onebot:fallbackClient,messageId:id}),/非零整数/);
let count=0;
await assert.rejects(readForwardMessage({onebot:{async getMsg(mid){return{message_id:mid,message:forward('same')}},async call(){count++;return{messages:[]}}},messageId:-10,message:forward('same')}),/空的转发节点/);
assert.equal(count,2,'same resource attempted once, then single message_id fallback');
console.log('✓ ID/scope validation, no cross-chat fallback, empty content errors, bounded deduplicated retries');
fs.rmSync(dataDir,{recursive:true,force:true});
