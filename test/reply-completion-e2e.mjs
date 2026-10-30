import assert from 'node:assert/strict';
import {bootApp, waitFor} from './_harness.mjs';
const env=await bootApp({config:{wakeDelayMs:25,api:{maxRounds:3},memory:{consolidateEnabled:false}}});
const {app,llm,pushGroupMsg,onebotHttp,request}=env;
const calls=[];const original=app.onebot.call.bind(app.onebot);
let failText=false;
app.onebot.call=async(action,params,...rest)=>{
  if(action==='set_msg_emoji_like'){calls.push(params);return {};}
  if(action==='send_group_msg'&&failText)throw Error('mock send rejected');
  return original(action,params,...rest);
};
const send=text=>({toolCalls:[{name:'send_message',args:{messages:text}}]});
const react=mid=>({toolCalls:[{name:'react_message',args:{messageId:mid,emojiId:'76'}}]});
const finish={toolCalls:[{name:'finish',args:{summary:'试图结束'}}]};
async function run(mid,text,steps){
  const start=llm.state.requests.length;
  for(let i=0;i<steps.length;i++)llm.state.script[start+i]=steps[i];
  pushGroupMsg(777,'提问者','@覆盖Bot '+text,mid);
  const session=await waitFor(()=>{
    const s=app.sessions.listSummaries(100).map(x=>app.sessions.get(x.id)).find(x=>x.trigger?.some(m=>m.mid===mid));
    return s&&!['running','waiting'].includes(s.status)?s:null;
  },8000,'completion for '+mid);
  await waitFor(()=>!app.orchestrator.runningChats.has('group:456'),2000);
  return {session,start,requests:llm.state.requests.slice(start)};
}
try{
  const first=await run(101,'查一下再回答',[{toolCalls:[{name:'web_search',args:{query:'资料'}}]},react(101),send('查到的资料不足，暂时不能下结论。')]);
  assert.equal(first.session.status,'done');assert.equal(first.requests.length,3);
  assert.deepEqual(first.session.sent.map(x=>x.type),['reaction','text']);
  assert.equal(first.session.completion.delivered,true);
  assert.ok(first.requests[2].messages.some(m=>String(m.content).includes('不能完结')));
  console.log('✓ search → reaction no longer completes; real current-chat send_message unlocks completion');

  const second=await run(102,'直接结束也不行',[finish,send('先给你一个正式答复。')]);
  assert.equal(second.session.status,'done');assert.equal(second.requests.length,2);
  assert.equal(second.session.messages.find(x=>x.toolCall?.name==='finish').toolCall.isError,true);
  assert.equal(second.session.sent[0].type,'text');
  console.log('✓ finish before send_message is rejected and does not terminate the agent loop');

  const third=await run(103,'正文不算交付',[{content:'这是没有通过工具发送的答案。'},send('这才是真正发出的答案。')]);
  assert.equal(third.session.status,'done');assert.equal(third.requests.length,2);
  assert.deepEqual(third.requests[1].tools.map(t=>t.function.name),['send_message']);
  assert.equal(third.session.completion.recoveryUsed,true);
  assert.equal(third.session.sent[0].text,'这才是真正发出的答案。');
  console.log('✓ ordinary model output cannot finish; one delivery-only recovery round requires send_message');

  const exhausted=await run(104,'耗尽轮次也只允许文字',[react(104),react(104),react(104),send('补上正式回复。')]);
  assert.equal(exhausted.session.status,'done');assert.equal(exhausted.requests.length,4);
  assert.deepEqual(exhausted.requests[3].tools.map(t=>t.function.name),['send_message']);
  assert.equal(exhausted.session.completion.recoveryUsed,true);
  console.log('✓ normal budget exhaustion reserves exactly one send_message-only opportunity');

  const stubborn=await run(105,'不发文字不得假完成',[react(105),finish,finish,react(105)]);
  assert.equal(stubborn.session.status,'error');assert.equal(stubborn.session.completion.delivered,false);
  assert.equal(stubborn.requests.length,4);assert.match(stubborn.session.error,/任务未完成/);
  assert.equal(stubborn.session.sent.length,1,'final restricted round must not execute a forbidden reaction');
  console.log('✓ persistent refusal is bounded and recorded as error, not done; restricted tool calls cannot execute');

  failText=true;
  const failed=await run(106,'失败发送不算完成',[send('失败的消息'),finish,finish,send('仍然失败')]);
  assert.equal(failed.session.status,'error');assert.equal(failed.session.completion.delivered,false);
  assert.equal(failed.session.sent.length,0);failText=false;
  console.log('✓ failed send_message does not grant completion');

  await app.sender.sendTextBatch('group:456',['已有相同文字']);
  const deduped=await run(107,'去重不算本轮发送',[send('已有相同文字'),send('本轮的新回复')]);
  assert.equal(deduped.session.status,'done');assert.equal(deduped.requests.length,2);
  assert.equal(deduped.session.messages.find(x=>x.toolCall?.name==='send_message').toolCall.isError,true);
  assert.equal(deduped.session.sent.length,1);assert.equal(deduped.session.sent[0].text,'本轮的新回复');
  console.log('✓ a deduplicated no-op cannot unlock completion or fabricate a receipt');

  await request('POST','/api/config',{body:{tools:{crossChatSend:true}}});
  const cross=await run(108,'跨会话不能代替当前回复',[
    {toolCalls:[{name:'send_to',args:{targetChatKey:'private:777',messages:'转告给另一个会话'}}]},send('当前会话也给出回复。')
  ]);
  assert.equal(cross.session.status,'done');assert.equal(cross.requests.length,2);
  assert.equal(cross.session.sent[0].to,'private:777');assert.equal(cross.session.sent[1].to,'group:456');
  console.log('✓ successful send_to cannot replace current-chat send_message');

  const allowed=await run(109,'先发文字再结束',[{toolCalls:[{name:'send_message',args:{messages:'正常完成'}},{name:'finish',args:{summary:'已回复'}}]}]);
  assert.equal(allowed.session.status,'done');assert.equal(allowed.requests.length,1);
  assert.equal(allowed.session.messages.find(x=>x.toolCall?.name==='finish').toolCall.isError,false);
  console.log('✓ send_message followed by finish in the same batch completes normally');

  const {skillManager}=await import('../src/skills/manager.js');
  const providers=skillManager.getCapabilityProviders;
  let policyCalls=0;
  skillManager.getCapabilityProviders=function(name,context){
    return name==='reply.local-policy' ? [{fn:()=>{policyCalls++;return {shouldEnd:true};}}] : providers.call(this,name,context);
  };
  try {
    const policy=await run(111,'插件也不能绕过文字交付',[react(111),send('插件建议结束也必须先回复。')]);
    assert.equal(policy.session.status,'done');assert.equal(policy.requests.length,2);
    assert.equal(policyCalls,1,'local finish policy is only consulted after the real send');
  } finally {skillManager.getCapabilityProviders=providers;}
  console.log('✓ local reply policy cannot turn reaction-only delivery into completion');

  const poke=await run(112,'拍一拍也不算文字交付',[
    {toolCalls:[{name:'send_poke',args:{userId:'777'}}]},send('拍一拍之外还要回复。')
  ]);
  assert.equal(poke.session.status,'done');assert.equal(poke.requests.length,2);
  assert.equal(poke.session.completion.delivered,true);
  console.log('✓ a poke receipt cannot replace successful send_message');

  await request('POST','/api/config',{body:{tools:{overrides:{send_message:false}}}});
  const disabled=await run(110,'未授权不能强制开启发送',[]);
  assert.equal(disabled.session.status,'error');assert.equal(disabled.requests.length,0);
  assert.match(disabled.session.error,/send_message 已禁用/);
  console.log('✓ disabled send_message remains disabled; completion enforcement does not bypass permissions');
}finally{await env.teardown();}
