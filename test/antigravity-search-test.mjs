import assert from 'node:assert/strict';
import http from 'node:http';
import {bootApp, listen, waitFor, readBody} from './_harness.mjs';

const chunks = [{web: {uri: 'https://example.com/official', title: '官方资料'}}];
const packets = [
  {candidates: [{content: {parts: [{text:'不应展示思考', thought:true}, {text:'核实两个游戏：'}]}}]},
  {candidates: [{content: {parts: [{text:'奖项不同。'}]}, finishReason:'STOP', groundingMetadata: {
    webSearchQueries:['黑神话 宇宙机器人 TGA'], groundingChunks: chunks,
    groundingSupports:[{segment:{text:'奖项不同。'}, groundingChunkIndices:[0]}]
  }}], usageMetadata:{promptTokenCount:100,totalTokenCount:160}}
];
const streamText = packets.map(p => 'data: '+JSON.stringify({response:p})+'\r\n\r\n').join('') + 'data: [DONE]';
let mode = 'ok'; const calls = [];
const native = http.createServer(async(req,res) => {
  const body = await readBody(req); calls.push({url:req.url,body,auth:req.headers.authorization});
  if(mode==='http-error'){res.writeHead(503);return res.end('unavailable');}
  res.writeHead(200,{'content-type':'text/event-stream'});
  if(mode==='ungrounded')return res.end('data: '+JSON.stringify({candidates:[{content:{parts:[{text:'我记得是这样，链接 https://example.com'}]},finishReason:'STOP'}]})+'\n\n');
  res.end(streamText);
});
const port = await listen(native);
const env = await bootApp({config:{
  api:{provider:'test-main'},
  providers:[{id:'search-proxy',baseURL:`http://127.0.0.1:${port}/v1`,apiKey:'native-secret'}],
  webSearch:{provider:'antigravity',antigravity:{providerId:'search-proxy',model:'gemini-3.8-flash-medium',timeoutMs:15000}},
  memory:{consolidateEnabled:false}
},script:[
  {toolCalls:[{name:'web_search',args:{query:'"黑神话" "宇宙机器人" TGA'}}]},
  {toolCalls:[{name:'send_message',args:{messages:'已核对两款游戏'}}]}
]});
try {
  const {groundedSearchResult,readGeminiSearchStream,resolveSearchConnection}=await import('../src/antigravity-search.js');
  const {webSearch}=await import('../src/web-search.js');
  const {getConfig}=await import('../src/config.js');
  const connection=resolveSearchConnection(getConfig());
  assert.equal(connection.apiKey,'native-secret');
  assert.equal(connection.baseUrl,`http://127.0.0.1:${port}`);
  const cfg=structuredClone(getConfig());cfg.dshProviderKeys={'search-proxy':'catalog-secret'};
  assert.equal(resolveSearchConnection(cfg).apiKey,'catalog-secret');
  cfg.webSearch.antigravity.providerId='missing';assert.throws(()=>resolveSearchConnection(cfg),/未配置/);
  cfg.webSearch.antigravity.providerId='search-proxy';cfg.webSearch.antigravity.model='claude-sonnet';assert.throws(()=>resolveSearchConnection(cfg),/Gemini/);
  console.log('✓ native search resolves its own provider address/key and rejects incompatible or missing connections');

  const bytes=new TextEncoder().encode(streamText);let offset=0;
  const split=new ReadableStream({pull(controller){if(offset>=bytes.length)return controller.close();controller.enqueue(bytes.slice(offset,++offset));}});
  const parsed=await readGeminiSearchStream(new Response(split));
  const result=groundedSearchResult('测试查询',parsed,{model:'gemini-3.8-flash-medium'});
  assert.equal(result.answer,'核实两个游戏：奖项不同。');
  assert.equal(result.grounded,true);assert.equal(result.provider,'antigravity-google');
  assert.equal(result.results[0].snippet,'奖项不同。');
  assert.equal(result.searchQueries[0],'黑神话 宇宙机器人 TGA');
  assert.equal(result.usage.totalTokenCount,160);
  assert.throws(()=>groundedSearchResult('q',[{candidates:[{content:{parts:[{text:'only a claim'}]}}]}]),/未返回可验证/);
  const errorStream=new Response(streamText.replace('data: [DONE]','data: {"error":{"message":"upstream failed"}}\n\n'));
  await assert.rejects(readGeminiSearchStream(errorStream),/upstream failed/);
  console.log('✓ byte-split UTF-8, wrapped SSE, final data without newline, grounding citations and late errors are handled');

  env.pushGroupMsg(777,'验收用户','@覆盖Bot 查黑神话和宇宙机器人',801);
  await waitFor(()=>env.onebotHttp.state.sends.length===1,5000,'native search result delivered via main tools');
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/v1beta\/models\/gemini-3.8-flash-medium:streamGenerateContent\?alt=sse/);
  assert.equal(calls[0].auth,'Bearer native-secret');
  assert.deepEqual(calls[0].body.tools,[{googleSearch:{}}]);
  assert.ok(!JSON.stringify(calls[0].body).includes('send_message'));
  assert.ok(calls[0].body.contents[0].parts[0].text.includes('黑神话'));
  const tool=env.llm.state.requests[1].messages.find(m=>m.role==='tool'&&m.name==='web_search');
  const value=JSON.parse(tool.content);
  assert.equal(value.grounded,true);assert.equal(value.answer,'核实两个游戏：奖项不同。');
  assert.equal(value.results[0].url,'https://example.com/official');
  assert.ok(env.llm.state.requests[0].tools.some(t=>t.function.name==='send_message'));
  console.log('✓ real incoming event → web_search → isolated native Google request → grounded results → normal QQ tool delivery');

  mode='ungrounded';await assert.rejects(webSearch('没有来源的回答'),/未返回可验证/);
  assert.equal(calls.length,2,'no silent Bing fallback');
  mode='http-error';await assert.rejects(webSearch('上游不可用'),/HTTP 503/);
  assert.equal(calls.length,3);
  console.log('✓ ungrounded answers and HTTP errors fail explicitly without silently switching engines');
} finally {await env.teardown();native.close();}
