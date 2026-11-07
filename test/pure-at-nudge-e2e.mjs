import assert from 'node:assert/strict';
import {bootApp,waitFor,sleep} from './_harness.mjs';
const env=await bootApp({config:{wakeDelayMs:25,drainDelayMs:200,conversationListener:{enabled:true,idleMs:10000}}});
const {app,llm,pushGroupMsg,request}=env;
const at={type:'at',data:{qq:'888'}};
const reply=text=>({toolCalls:[{name:'send_message',args:{messages:text}},{name:'finish',args:{summary:'已回复'}}]});
const send=(mid,user=777,message=[at])=>pushGroupMsg(user,'测试者','',mid,{message});
const idle=()=>waitFor(()=>app.orchestrator.runningChats.size===0,5000);
try {
  const {isPureBotMention}=await import('../src/onebot.js');
  assert.equal(isPureBotMention([at,{type:'text',data:{text:' \n '}}],'888'),true);
  for(const segments of ['@覆盖Bot',[{type:'text',data:{text:'@覆盖Bot'}}],[at,{type:'at',data:{qq:'all'}}],[at,{type:'text',data:{text:'换一首'}}],[at,{type:'reply',data:{id:1}}],[at,{type:'image',data:{url:'x'}}],[at,{type:'face',data:{id:1}}]])assert.equal(isPureBotMention(segments,'888'),false);
  assert.equal(isPureBotMention([at],''),false);
  llm.state.script.push({...reply('第一轮答复'),delayMs:1200});
  pushGroupMsg(777,'甲','@覆盖Bot 第一问',100);
  await waitFor(()=>llm.state.requests.length===1);
  send(101);send(102,777,[{type:'text',data:{text:' \n'}},at,at]);
  await waitFor(()=>app.store.findByMid('group:456',102)?.read===true);
  const active=app.sessions.get(app.orchestrator.activeRuns.get('group:456'));
  assert.equal(active.nudges.length,2);
  assert.equal(app.store.findByMid('group:456',101).nudgeForSessionId,active.id);
  await idle();await sleep(700);
  assert.equal(llm.state.requests.length,1,'nudges must not cause classification or another main request');
  assert.equal(env.onebotHttp.state.sends.length,1);
  console.log('PASS same requester pure @ during a main run is archived as a nudge; no LLM, listener check or second wake');

  let start=llm.state.requests.length;
  llm.state.script[start]={...reply('不可发送的旧稿'),delayMs:350};
  llm.state.script[start+1]=reply('按最新请求回答');
  pushGroupMsg(777,'甲','@覆盖Bot 第二问',200);
  await waitFor(()=>llm.state.requests.length===start+1);
  const cases=[
    [201,[at,{type:'text',data:{text:'换一首'}}]],
    [203,[{type:'reply',data:{id:'100'}},at]],
    [204,[at,{type:'image',data:{url:'https://example.com/test.png'}}]],
    [205,[at,{type:'at',data:{qq:'999'}}]],
    [206,[{type:'text',data:{text:'@覆盖Bot'}}]]
  ];
  for(const [mid,segments] of cases)send(mid,777,segments);
  await waitFor(()=>app.store.findByMid('group:456',206)?.read);
  await idle();
  const follow=app.sessions.listSummaries(30).map(s=>app.sessions.get(s.id)).find(s=>s.trigger?.some(m=>m.mid===200));
  assert.deepEqual(follow.trigger.map(m=>m.mid),[200,...cases.map(c=>c[0])]);
  assert.deepEqual(follow.sent.map(m=>m.text),['按最新请求回答']);
  assert.equal(llm.state.requests.length,start+2);
  console.log('PASS same speaker substantive @/quote/media go into the active run, not the nudge or new wake path');

  start=llm.state.requests.length;llm.state.script[start]={...reply('不应发出'),delayMs:1600};
  pushGroupMsg(777,'甲','@覆盖Bot 中止测试',400);
  await waitFor(()=>llm.state.requests.length===start+1);
  send(401);await waitFor(()=>app.store.findByMid('group:456',401)?.read);
  const id=app.orchestrator.activeRuns.get('group:456');
  assert.equal((await request('POST',`/api/sessions/${id}/abort`,{body:{}})).status,200);
  await idle();await sleep(700);
  assert.equal(app.sessions.get(id).status,'aborted');
  assert.equal(llm.state.requests.length,start+1,'merged nudge cannot restart an aborted run');
  console.log('PASS abort removes the listener and merged nudges do not wake a replacement run');
} finally {await env.teardown();}
