import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {bootApp} from './_harness.mjs';
const env=await bootApp({config:{conversationListener:{enabled:false,idleMs:45000}}});
const dom=new JSDOM('<main id="root"></main>',{runScripts:'outside-only',url:'http://127.0.0.1:3210'});
const {window}=dom;
try {
  window.$=selector=>window.document.querySelector(selector);
  window.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  window.setCard=({id,title,body})=>`<section id="${id}"><h4>${title}</h4>${body}</section>`;
  window.tierSummary=()=>'';window.sliderToTierUI_tierToSlider=()=>10;window.STICKER_LEVELS=[];
  const initial=await env.request('GET','/api/config');
  window.state={config:initial.data,settingsSection:'chat'};
  window.api=async(url,options)=>{
    const response=await env.request(options.method,url,{body:JSON.parse(options.body)});
    assert.equal(response.status,200);return response.data;
  };
  const render=fs.readFileSync(new URL('../ui/app/06-settings-render.js',import.meta.url),'utf8');
  window.eval(render.slice(render.indexOf('function renderChatSection'),render.indexOf('function renderDesktopSection')));
  const modals=fs.readFileSync(new URL('../ui/app/08-modals.js',import.meta.url),'utf8');
  window.eval(modals.slice(modals.indexOf('async function saveConfig')));
  const show=()=>{window.$('#root').innerHTML=window.renderChatSection(window.state.config);};
  show();
  assert.match(window.$('#card-conversation-listener').textContent,/独立关联监听/);
  assert.equal(window.$('#cfg-listener-seconds').value,'45');
  window.$('#cfg-listener-seconds').value='180';
  await window.saveConfig({quiet:true});
  const saved=JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR,'config.json'),'utf8'));
  assert.equal(saved.conversationListener.idleMs,180000);
  assert.equal(saved.conversationListener.enabled,false,'changing duration must preserve the existing enable switch');
  show();assert.equal(window.$('#cfg-listener-seconds').value,'180','saved duration must survive a re-render');
  for(const [input,expected] of [['',60000],['-5',1000],['5000',3600000]]){
    window.$('#cfg-listener-seconds').value=input;
    await window.saveConfig({quiet:true});
    assert.equal(window.state.config.conversationListener.idleMs,expected);
  }
  const sessions=fs.readFileSync(new URL('../ui/app/02-sse-sessions.js',import.meta.url),'utf8');
  window.eval(sessions.slice(sessions.indexOf('function sessionTriggerLabel'),sessions.indexOf('function renderSessionList')));
  const old='独立关联监听（闲置一分钟自动结束）';
  assert.equal(window.sessionTriggerLabel({trigger:old}),'独立关联监听');
  assert.equal(window.sessionTriggerLabel({triggerSummary:old,taskType:'conversation-listener'}),'独立关联监听');
  assert.equal(window.sessionTriggerLabel({trigger:'普通聊天请求'}),'普通聊天请求');
  assert.equal(window.sessionTriggerLabel({trigger:'proactive'},'主动机会'),'主动机会');
  console.log('PASS listener settings render → seconds/ms conversion → real config API/disk → re-render; bounds, preserved enable switch and historical session labels');
} finally {dom.window.close();await env.teardown();}
