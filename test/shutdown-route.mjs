import assert from 'node:assert/strict';
import { bootApp } from './_harness.mjs';
const env=await bootApp();
try {
  const r=await env.request('POST','/api/shutdown',{body:{}});
  assert.equal(r.status,400);assert.match(r.data.error,/确认/);
  const foreign=await env.rawRequest('POST','/api/shutdown',{Origin:'https://foreign.example'});
  assert.equal(foreign.status,403);
  assert.equal(env.app.orchestrator.paused,false);
  console.log('PASS shutdown route requires confirmation and same-origin access');
}finally{await env.teardown();}
