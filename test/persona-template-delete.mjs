import assert from 'node:assert/strict';
import {bootApp} from './_harness.mjs';
const env = await bootApp({config:{
  persona:{roleText:'自定义角色',customRules:'附加规则'},
  personaByChat:{'group:456':{roleText:'群人设保留'}},
  customPersonas:[{name:'测试模板',text:'自定义角色'}]
}});
try {
  assert.equal((await env.request('DELETE','/api/persona-templates/custom_0',{body:{}})).status,200);
  let cfg = (await env.request('GET','/api/config')).data;
  assert.equal(cfg.customPersonas.length,0);
  assert.equal(cfg.persona.roleText,'');
  assert.equal(cfg.personaByChat['group:456'].roleText,'群人设保留');
  const original = (await env.request('GET','/api/persona-templates')).data.templates.find(t=>t.builtin);
  assert.ok(original);
  assert.equal((await env.request('DELETE','/api/persona-templates/'+original.id,{body:{}})).status,200);
  assert.ok(!(await env.request('GET','/api/persona-templates')).data.templates.some(t=>t.id===original.id));
  assert.equal((await env.request('DELETE','/api/persona-templates/custom_9999',{body:{}})).status,404);
  await env.request('POST','/api/persona-templates',{body:{name:'新模板',text:'新角色'}});
  assert.ok((await env.request('GET','/api/persona-templates')).data.templates.some(t=>t.name==='新模板'));
  console.log('PASS custom/builtin deletion persists, selected global role resets, group persona preserved, missing deletion rejected, add still works');
} finally {await env.teardown();}
