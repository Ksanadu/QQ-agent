import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

  await request('POST','/api/config',{body:{api:{maxRounds:6}}});
  const imageDir=path.join(process.env.QQ_AGENT_DATA_DIR,'sticker-images');
  fs.mkdirSync(imageDir,{recursive:true});
  const imageFile=path.join(imageDir,'completion.png');
  fs.writeFileSync(imageFile,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9uoAAAAASUVORK5CYII=','base64'));
  const sticker={id:'completion-sticker',desc:'得意的测试表情',url:'file:///'+imageFile.replaceAll('\\','/')};
  app.stickers.sync=async()=>({entries:[sticker]});
  app.stickers.list=async()=>({total:1,matched:1,stickers:[sticker]});
  app.stickers.find=async id=>id===sticker.id?sticker:null;
  app.stickers.ensureSendable=async s=>s;
  const guide={toolCalls:[{name:'read_skill_guide',args:{skillId:'core-stickers'}}]};
  const catalogue={toolCalls:[{name:'list_stickers',args:{query:'得意'}}]};
  const sendSticker=id=>({toolCalls:[{name:'send_sticker',args:{stickerId:id}}]});
  const sequential=await run(113,'查表情，先回复文字，再补发表情',[
    guide,catalogue,send('掌声不要停'),sendSticker(sticker.id),finish
  ]);
  assert.equal(sequential.session.status,'done');assert.equal(sequential.requests.length,5);
  assert.deepEqual(sequential.session.sent.map(x=>x.type),['text','sticker']);
  assert.ok(sequential.requests[3].tools.some(t=>t.function.name==='send_sticker'));
  assert.ok(sequential.requests[3].messages.some(m=>m.role==='tool'&&m.name==='send_message'&&String(m.content).includes('messageIds')));
  assert.ok(onebotHttp.state.sends.some(s=>s.body.message.some(m=>m.type==='image')),'sticker must reach the queued mock QQ sender');
  assert.equal(sequential.session.finishReason,'试图结束');
  console.log('✓ catalogue → text → sticker → explicit finish works across separate model calls');

  const retriedSticker=await run(114,'文字发出后表情失败仍可修正',[
    guide,catalogue,send('再补一张表情'),sendSticker('missing-sticker'),sendSticker(sticker.id),finish
  ]);
  assert.equal(retriedSticker.session.status,'done');assert.equal(retriedSticker.requests.length,6);
  assert.deepEqual(retriedSticker.session.sent.map(x=>x.type),['text','sticker']);
  assert.equal(retriedSticker.session.messages.find(x=>x.toolCall?.name==='send_sticker').toolCall.isError,true);
  assert.ok(retriedSticker.requests[4].messages.some(m=>m.role==='tool'&&m.name==='send_sticker'&&String(m.content).includes('找不到表情')));
  console.log('✓ a failed sticker after text is returned to the model and can be retried');
  await request('POST','/api/config',{body:{api:{maxRounds:3}}});

  const second=await run(102,'直接结束也不行',[finish,send('先给你一个正式答复。'),finish]);
  assert.equal(second.session.status,'done');assert.equal(second.requests.length,3);
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

  const stubborn=await run(105,'不发文字不得假完成',[react(105),finish,finish,finish,react(105)]);
  assert.equal(stubborn.session.status,'error');assert.equal(stubborn.session.completion.delivered,false);
  assert.equal(stubborn.requests.length,5);assert.match(stubborn.session.error,/任务未完成/);
  assert.equal(stubborn.session.toolRoundsUsed,1,'three failed rounds and restricted recovery do not consume the quota');
  assert.equal(stubborn.session.sent.length,1,'final restricted round must not execute a forbidden reaction');
  console.log('✓ persistent refusal is bounded and recorded as error, not done; restricted tool calls cannot execute');

  await request('POST','/api/config',{body:{api:{maxRounds:1}}});
  const freeFailure=await run(117,'失败和混合批次的额度',[
    {toolCalls:[{name:'no_such_tool',args:{}}, {name:'another_unknown_tool',args:{}}]},
    {toolCalls:[{name:'get_recent_messages',args:{limit:1}}, {name:'no_such_tool',args:{}}]},
    send('失败没有吃掉额度。')
  ]);
  assert.equal(freeFailure.session.status,'done');
  assert.equal(freeFailure.requests.length,3);
  assert.ok(freeFailure.requests[1].tools.some(t=>t.function.name==='get_recent_messages'));
  assert.deepEqual(freeFailure.requests[2].tools.map(t=>t.function.name),['send_message']);
  assert.equal(freeFailure.session.toolRoundsUsed,1);
  console.log('✓ all-failed rounds are free; a mixed round consumes only one round');
  await request('POST','/api/config',{body:{api:{maxRounds:3}}});

  failText=true;
  const failed=await run(106,'失败发送不算完成',[send('失败的消息'),finish,finish,send('仍然失败')]);
  assert.equal(failed.session.status,'error');assert.equal(failed.session.completion.delivered,false);
  assert.equal(failed.session.sent.length,0);failText=false;
  console.log('✓ failed send_message does not grant completion');

  await app.sender.sendTextBatch('group:456',['已有相同文字']);
  const deduped=await run(107,'去重不算本轮发送',[send('已有相同文字'),send('本轮的新回复'),finish]);
  assert.equal(deduped.session.status,'done');assert.equal(deduped.requests.length,3);
  assert.equal(deduped.session.messages.find(x=>x.toolCall?.name==='send_message').toolCall.isError,true);
  assert.equal(deduped.session.sent.length,1);assert.equal(deduped.session.sent[0].text,'本轮的新回复');
  console.log('✓ a deduplicated no-op cannot unlock completion or fabricate a receipt');

  await request('POST','/api/config',{body:{tools:{crossChatSend:true}}});
  const cross=await run(108,'跨会话不能代替当前回复',[
    {toolCalls:[{name:'send_to',args:{targetChatKey:'private:777',messages:'转告给另一个会话'}}]},send('当前会话也给出回复。'),finish
  ]);
  assert.equal(cross.session.status,'done');assert.equal(cross.requests.length,3);
  assert.equal(cross.session.sent[0].to,'private:777');assert.equal(cross.session.sent[1].to,'group:456');
  console.log('✓ successful send_to cannot replace current-chat send_message');

  const allowed=await run(109,'先发文字再结束',[{toolCalls:[{name:'send_message',args:{messages:'正常完成'}},{name:'finish',args:{summary:'已回复'}}]}]);
  assert.equal(allowed.session.status,'done');assert.equal(allowed.requests.length,1);
  assert.equal(allowed.session.messages.find(x=>x.toolCall?.name==='finish').toolCall.isError,false);
  console.log('✓ send_message followed by finish in the same batch completes normally');

  const stopped=await run(115,'发完文字后由模型自然结束',[send('完整答复'),{content:''}]);
  assert.equal(stopped.session.status,'done');assert.equal(stopped.requests.length,2);
  assert.equal(stopped.session.completion.delivered,true);
  console.log('✓ successful text is fed back to the model before a natural no-tool stop');

  const bounded=await run(116,'文字之后仍受正常轮次上限约束',[
    send('已经回复，继续查询'),
    {toolCalls:[{name:'get_recent_messages',args:{limit:2}}]},
    {toolCalls:[{name:'get_recent_messages',args:{limit:2}}]}
  ]);
  assert.equal(bounded.session.status,'done');assert.equal(bounded.requests.length,3);
  assert.equal(bounded.session.completion.recoveryUsed,false);
  assert.equal(bounded.session.messages.filter(x=>x.toolCall?.name==='get_recent_messages').length,2);
  console.log('✓ post-delivery tools still obey the normal round budget without a duplicate delivery round');

  const {skillManager}=await import('../src/skills/manager.js');
  const providers=skillManager.getCapabilityProviders;
  let policyCalls=0;
  skillManager.getCapabilityProviders=function(name,context){
    return name==='reply.local-policy' ? [{fn:()=>{policyCalls++;return {shouldEnd:true};}}] : providers.call(this,name,context);
  };
  try {
    const policy=await run(111,'插件也不能截断文字之后的操作',[
      react(111),send('插件建议结束也应继续操作。'),
      {toolCalls:[{name:'react_message',args:{messageId:111,emojiId:'66'}}]}
    ]);
    assert.equal(policy.session.status,'done');assert.equal(policy.requests.length,3);
    assert.equal(policy.session.sent.filter(x=>x.type==='reaction').length,2);
    assert.equal(policyCalls,0,'legacy local finish policy must not be consulted');
  } finally {skillManager.getCapabilityProviders=providers;}
  console.log('✓ legacy local reply policy cannot truncate remaining actions after text delivery');

  const poke=await run(112,'拍一拍也不算文字交付',[
    {toolCalls:[{name:'send_poke',args:{userId:'777'}}]},send('拍一拍之外还要回复。'),finish
  ]);
  assert.equal(poke.session.status,'done');assert.equal(poke.requests.length,3);
  assert.equal(poke.session.completion.delivered,true);
  console.log('✓ a poke receipt cannot replace successful send_message');

  await request('POST','/api/config',{body:{tools:{overrides:{send_message:false}}}});
  const disabled=await run(110,'未授权不能强制开启发送',[]);
  assert.equal(disabled.session.status,'error');assert.equal(disabled.requests.length,0);
  assert.match(disabled.session.error,/send_message 已禁用/);
  console.log('✓ disabled send_message remains disabled; completion enforcement does not bypass permissions');
}finally{await env.teardown();}
