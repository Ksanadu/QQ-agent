import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { patchPttSource, patchSnowlumaPtt } from '../src/snowluma-ptt-patch.js';

// The two affected legacy boundaries, with a small event delivery harness.
const fixture = 'function pttTransKey(selfUin, msgId) {\n\treturn `${selfUin}:${msgId}`;\n}\n' +
  'function decodePttTransResult(ctx) {\n\tconst item = protobuf_decode_PttTransPush(ctx.content)?.item;\n\tif (!item) return [];\n\tconst msgId = Number(item.msgId ?? 0n);\n\tconst text = item.text ?? "";\n\tif (!msgId || !text) return [];\n\treturn [{ selfUin: ctx.selfUin, msgId, text }];\n}\n';
const legacy = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : fixture;
function boundaries(source) {
  const key = source.match(/function pttTransKey\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0];
  const decoder = source.match(/function decodePttTransResult\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(key && decoder);
  return vm.runInNewContext(`${key}\n${decoder}\n({key:pttTransKey, decode:decodePttTransResult})`, {
    protobuf_decode_PttTransPush: content => ({item:content})
  });
}
const cases = [-373767942, -373767943, -2147483648, -1, 1, 147311541, 433718668, 2147483647];
const before = boundaries(legacy);
const negative = cases[0];
assert.notEqual(before.key(10001, negative), before.key(10001, before.decode({selfUin:10001,head:{timestamp:0},content:{msgId:BigInt.asUintN(64,BigInt(negative)),text:'test'}})[0].msgId));
for (const source of [legacy, legacy.replaceAll('\r\n','\n').replaceAll('\n','\r\n')]) {
  const patched = patchPttSource(source); assert.equal(patched.status, 'patched');
  assert.equal(patchPttSource(patched.source).status, 'already-fixed');
  const {key,decode} = boundaries(patched.source);
  const pending = new Map();
  for (const account of [10001,10002]) for (const id of cases) pending.set(key(account,id), `${account}/${id}`);
  for (const account of [10002,10001]) for (const id of [...cases].reverse()) {
    const text = `${account}/${id}`;
    const [event] = decode({selfUin:account,head:{timestamp:0},content:{msgId:BigInt.asUintN(64,BigInt(id)),text}});
    const k = key(event.selfUin,event.msgId);
    assert.equal(pending.get(k),text); pending.delete(k);
  }
  assert.equal(pending.size,0);
  for (const bad of [Number(18446744073335783674n), NaN, 1.5, Infinity]) assert.throws(()=>key(10001,bad),/safe integer/);
  assert.equal(decode({content:{msgId:0n,text:'zero'}}).length,0);
}
assert.equal(patchPttSource('unrecognised vendor bundle').status, 'unsupported');
assert.equal(patchPttSource(fixture + fixture).status, 'unsupported');
assert.equal(patchPttSource(fixture.replace('return `${selfUin}:${msgId}`;', 'return String(msgId);')).source.includes('Number(item.msgId'),true);
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'qq-ptt-patch-'));
try {
  assert.equal(patchSnowlumaPtt(dir).status,'missing');
  fs.writeFileSync(path.join(dir,'index.mjs'),fixture);
  const existingTemp = path.join(dir,`index.mjs.ptt-${process.pid}.tmp`);
  fs.writeFileSync(existingTemp,'unrelated existing file');
  assert.throws(()=>patchSnowlumaPtt(dir),/EEXIST/);
  assert.equal(fs.readFileSync(existingTemp,'utf8'),'unrelated existing file');
  assert.equal(fs.readFileSync(path.join(dir,'index.mjs'),'utf8'),fixture);
  fs.unlinkSync(existingTemp);
  const result = patchSnowlumaPtt(dir); assert.equal(result.status,'patched');
  assert.equal(fs.readFileSync(result.backup,'utf8'),fixture);
  assert.equal(patchSnowlumaPtt(dir).status,'already-fixed');
  fs.writeFileSync(path.join(dir,'index.mjs'),'future version');
  assert.equal(patchSnowlumaPtt(dir).status,'unsupported');
  assert.equal(fs.readFileSync(path.join(dir,'index.mjs'),'utf8'),'future version');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
console.log('PASS PTT signed/unsigned push correlation, adjacent 64-bit IDs, account isolation, positive IDs, idempotence, unknown-version guard and verified backup');
