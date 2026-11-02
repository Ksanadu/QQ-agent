import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
const { OneBotClient } = await import('../src/onebot.js');
const { SendQueue } = await import('../src/sender.js');
const { updateConfig } = await import('../src/config.js');
updateConfig({ allow: { groups: ['456'], users: ['777'] } });
let rows = [], behavior, historyAvailable = true, historyDelay = 0, sendCalls = 0, historyCalls = 0;
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const params = JSON.parse(Buffer.concat(chunks));
  const reply = data => res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('_msg_history')) {
    historyCalls++;
    if (historyDelay) await sleep(historyDelay);
    if (!historyAvailable) return res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: 'unsupported' }));
    return reply({ messages: rows });
  }
  sendCalls++;
  const result = await behavior(params);
  if (result === 'ok') return reply({ message_id: 800 });
  res.end(JSON.stringify({ status: 'failed', retcode: 100, wording: 'send group message rejected: result=241 err=' }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const client = new OneBotClient({ httpUrl: `http://127.0.0.1:${server.address().port}` });
client.selfInfo = { user_id: 99 };
let nextId = 1000;
const text = value => [{ type: 'text', data: { text: value } }];
function row(message, extra = {}) {
  return { message_id: ++nextId, time: Math.floor(Date.now() / 1000), message_type: 'group', group_id: 456,
    user_id: 99, sender: { user_id: 99 }, message, ...extra };
}
function reset(fn) { rows = []; sendCalls = 0; historyCalls = 0; historyAvailable = true; historyDelay = 0; behavior = fn; }
async function check(label, fn) { await fn(); console.log('PASS ' + label); }
try {
  await check('normal send preserves its receipt without recovery polling', async () => {
    reset(() => 'ok');
    assert.equal((await client.sendText('group', '456', 'normal')).message_id, 800);
    assert.equal(sendCalls, 1); assert.equal(historyCalls, 1);
  });
  await check('241 then delayed self history becomes success, with one actual submission', async () => {
    reset(p => { setTimeout(() => rows.push(row(p.message)), 900); });
    const result = await client.sendText('group', '456', '真实已发');
    assert.equal(result.delivery_verified, true); assert.equal(result.message_id, rows[0].message_id);
    assert.equal(sendCalls, 1); assert.ok(historyCalls >= 3);
  });
  await check('an old identical same-second message never proves the new failed attempt', async () => {
    reset(() => {}); rows.push(row(text('相同内容')));
    await assert.rejects(client.sendText('group', '456', '相同内容'), /result=241/);
    assert.equal(sendCalls, 1);
  });
  await check('other authors/chats, substrings and media of a different hash do not match', async () => {
    reset(() => {
      rows.push(row(text('完整内容'), { user_id: 77 }), row(text('完整内容'), { group_id: 457 }),
        row(text('完整内容更多')), row(text('完整')));
    });
    await assert.rejects(client.sendText('group', '456', '完整内容'), /result=241/);
    reset(() => rows.push(row([{ type: 'image', data: { file: '0123456789abcdef0123456789abcdef.jpg' } }])));
    await assert.rejects(client.sendImage('group', '456', 'base64://' + Buffer.from('different').toString('base64')), /result=241/);
  });
  await check('failed local image send verified by content hash prevents the base64 fallback', async () => {
    const bytes = Buffer.from('a local image body for receipt identity');
    const file = path.join(tmp, 'local.png'); fs.writeFileSync(file, bytes);
    const hash = createHash('md5').update(bytes).digest('hex');
    reset(() => rows.push(row([{ type: 'image', data: { file: hash.toUpperCase() + '.png' } }])));
    const q = new SendQueue({ onebot: client, store: { appendSelf() {} } });
    const result = await q.sendImage('group:456', { file, dataUrl: 'base64://' + bytes.toString('base64') });
    assert.ok(result.message_id); assert.equal(sendCalls, 1);
  });
  await check('a downloaded web image is matched by known bytes while still sending its short URL', async () => {
    const bytes = Buffer.from('remote webp bytes'), hash = createHash('md5').update(bytes).digest('hex');
    reset(p => {
      assert.equal(p.message[0].data.file, 'https://example.com/photo.webp');
      rows.push(row([{ type: 'image', data: { file: hash + '.webp' } }]));
    });
    const q = new SendQueue({ onebot: client, store: { appendSelf() {} } });
    await q.sendImage('group:456', { url: 'https://example.com/photo.webp', dataUrl: 'base64://' + bytes.toString('base64') });
    assert.equal(sendCalls, 1);
  });
  await check('cancellation during the pre-send snapshot prevents a late submission', async () => {
    reset(() => 'ok'); historyDelay = 300;
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
      if (String(args[0]).endsWith('_msg_history')) setTimeout(() => controller.abort(), 30);
      return originalFetch(...args);
    };
    const q = new SendQueue({ onebot: client, store: { appendSelf() {} } });
    try { await assert.rejects(q.sendTextBatch('group:456', ['取消此条'], { signal: controller.signal }), /abort/i); }
    finally { globalThis.fetch = originalFetch; }
    assert.equal(sendCalls, 0);
  });
  await check('parallel identical calls cannot reuse a single delivered message', async () => {
    reset(p => { if (sendCalls === 1) rows.push(row(p.message)); });
    const result = await Promise.allSettled([client.sendText('group', 456, '同文并发'), client.sendText('group', 456, '同文并发')]);
    assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].status, 'rejected');
    assert.equal(sendCalls, 2);
  });
  await check('sticker and voice/card sends use the shared verified delivery path', async () => {
    const bytes = Buffer.from('sticker body'), hash = createHash('md5').update(bytes).digest('hex');
    reset(() => rows.push(row([{ type: 'image', data: { file: hash + '.webp', sub_type: 1 } }])));
    const q = new SendQueue({ onebot: client, store: { appendSelf() {} } });
    await q.sendSticker('group:456', { id: 'probe', url: 'base64://' + bytes.toString('base64') });
    assert.equal(sendCalls, 1);
    reset(() => rows.push(row([{ type: 'record', data: { file: hash + '.amr' } }])));
    assert.equal((await client.sendSegments('group', 456, [{ type: 'record', data: { file: 'base64://' + bytes.toString('base64') } }])).delivery_verified, true);
    reset(() => rows.push(row([{ type: 'json', data: { data: '{"meta":{"url":"https://b23.tv/test"},"app":"test"}' } }])));
    assert.equal((await client.sendSegments('group', 456, [{ type: 'json', data: { data: '{"app":"test","meta":{"url":"https://b23.tv/test"}}' } }])).delivery_verified, true);
  });
  await check('private messages recover only from that peer and the bot itself', async () => {
    reset(p => rows.push(row(p.message, { group_id: undefined, message_type: 'private', target_id: 777 })));
    assert.equal((await client.sendText('private', 777, '私聊送达')).delivery_verified, true);
    reset(p => rows.push(row(p.message, { group_id: undefined, message_type: 'private', target_id: 778 })));
    await assert.rejects(client.sendText('private', 777, '发给另一人不能算'), /result=241/);
  });
  await check('fresh self echoes still verify when history is unavailable', async () => {
    reset(p => client.deliveryVerifier.observe({ ...row(p.message), post_type: 'message_sent' }));
    historyAvailable = false;
    assert.equal((await client.sendText('group', 456, '用回传确认')).delivery_verified, true);
  });
  await check('a confirmed self poke notice prevents the alternate poke API from firing', async () => {
    reset(() => client.deliveryVerifier.observe({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
      user_id: 99, target_id: 777, group_id: 456 }));
    assert.equal((await client.sendPoke('group', 456, 777)).delivery_verified, true);
    assert.equal(sendCalls, 1);
  });
  await check('a lost HTTP response after delivery also recovers without resending', async () => {
    reset(p => { rows.push(row(p.message)); return 'ok'; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const result = await originalFetch(...args);
      if (String(args[0]).endsWith('/send_group_msg')) throw new Error('lost response');
      return result;
    };
    try { assert.equal((await client.sendText('group', 456, '响应丢失')).delivery_verified, true); }
    finally { globalThis.fetch = originalFetch; }
    assert.equal(sendCalls, 1);
  });
  await check('unknown/unverifiable sends preserve failure instead of inventing success', async () => {
    reset(() => {});
    await assert.rejects(client.sendText('group', 456, '未发送'), /result=241/);
    assert.equal(sendCalls, 1);
  });
} finally {
  client.close(); await new Promise(r => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
