import assert from 'node:assert/strict';
import {bootApp,waitFor,sleep} from './_harness.mjs';
const env=await bootApp({config:{wakeDelayMs:25,drainDelayMs:200,conversationListener:{enabled:true,idleMs:10000}}});
const {app,llm,pushGroupMsg,request}=env;
const at={type:'at',data:{qq:'888'}};
const reply=text=>({toolCalls:[{name:'send_message',args:{messages:text}},{name:'finish',args:{summary:'已回复'}}]});
const pure=mid=>pushGroupMsg(777,'甲','',mid,{message:[at]});
const idle=()=>waitFor(()=>!app.orchestrator.runningChats.size,3000);
try {
  llm.state.script.push(reply('图片和文字已一起收到'));
  pure(501);
  await waitFor(()=>app.orchestrator.pendingSessions.has('group:456'));
  const id=app.orchestrator.pendingSessions.get('group:456'),until=app.sessions.get(id).waitUntil;
  assert.ok(until-Date.now()>4500,'a first pure @ must reserve five seconds');
  await sleep(3100);
  assert.equal(llm.state.requests.length,0,'must not wake on the initial @ before the image arrives');
  pushGroupMsg(777,'甲','',502,{message:[{type:'image',data:{url:'https://example.com/test.png'}}]});
  pushGroupMsg(777,'甲','这张图评价一下',503);
  pure(504);
  await waitFor(()=>app.store.findByMid('group:456',504));
  assert.equal(app.sessions.get(id).waitUntil,until,'supplements must not restart or extend the fixed window');
  await waitFor(()=>llm.state.requests.length===1,4000);await idle();await sleep(700);
  const session=app.sessions.get(id);
  assert.deepEqual(session.trigger.map(m=>m.mid).sort(),[501,502,503,504]);
  assert.equal(session.trigger.find(m=>m.mid===502).media[0].kind,'image');
  assert.equal(llm.state.requests.length,1,'the whole batch must produce only one main call and no listener follow-up');
  assert.equal(env.onebotHttp.state.sends.length,1);
  console.log('PASS first pure @ waits five seconds; image/text three seconds later join one batch; repeated @ does not extend it');

  llm.state.script[1]=reply('正常文字请求');
  pushGroupMsg(777,'甲','@覆盖Bot 有正文的新问题',510);
  await waitFor(()=>llm.state.requests.length===2,1500);await idle();
  console.log('PASS requests with text still use the configured short batching window');

  llm.state.script[2]=reply('只有艾特也正常回复');
  pure(520);await waitFor(()=>app.orchestrator.pendingSessions.has('group:456'));
  await waitFor(()=>llm.state.requests.length===3,7000);await idle();
  assert.equal(app.sessions.listSummaries(20).map(s=>app.sessions.get(s.id)).find(s=>s.trigger?.some(m=>m.mid===520)).status,'done');
  console.log('PASS pure @ without supplements still wakes normally when five seconds expire');

  await request('POST','/api/config',{body:{wakeDelayMs:7000}});
  pure(530);await waitFor(()=>app.orchestrator.pendingSessions.has('group:456'));
  const waiting=app.orchestrator.pendingSessions.get('group:456');
  assert.ok(app.sessions.get(waiting).waitUntil-Date.now()>6500,'longer configured batching must not be shortened');
  assert.equal((await request('POST',`/api/sessions/${waiting}/abort`,{body:{}})).status,200);
  assert.equal(app.orchestrator.pendingWake.has('group:456'),false);
  assert.equal(app.orchestrator.wakeTimers.has('group:456'),false);
  assert.equal(llm.state.requests.length,3);
  console.log('PASS longer batching settings preserved; waiting pure @ can be cancelled without a model call');
} finally {await env.teardown();}
