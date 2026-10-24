import assert from 'node:assert/strict';
import { bootApp } from './_harness.mjs';
const env = await bootApp();
try {
  const { biliVideoId, getBiliVideo, shareBiliVideo } = await import('../src/bilibili-card.js');
  const { app } = env; const bvid = 'BV1xx411c7mD';
  assert.deepEqual(biliVideoId('https://www.bilibili.com/video/' + bvid + '/?p=1'), { bvid });
  assert.deepEqual(biliVideoId('av123'), { aid: '123' });
  for (const input of ['https://evil.com/video/' + bvid, 'file:///secret', 'https://www.bilibili.com.evil.com/video/' + bvid, 'https://www.bilibili.com/read/cv123']) assert.throws(() => biliVideoId(input));
  const meta = { code: 0, data: { bvid, aid: 123, title: '真实视频标题', owner: { name: '真实UP' }, pic: 'https://i0.hdslb.com/test.jpg' } };
  const fetcher = async url => { assert.ok(url.startsWith('https://api.bilibili.com/')); return { statusCode: 200, body: JSON.stringify(meta) }; };
  const lookup = value => getBiliVideo(value, fetcher);
  await assert.rejects(getBiliVideo(bvid, async () => ({ statusCode: 200, body: JSON.stringify({ code: -404 }) })), /不存在/);
  const session = { id: 'bili-test', chatKey: 'group:456', trigger: [], sent: [], status: 'running' };
  const card = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '真实视频标题', qqdocurl: 'https://www.bilibili.com/video/' + bvid } } };
  const sent = await shareBiliVideo({ chatKey: session.chatKey, sender: app.sender.forSession(session), onebot: { call: async (action, args) => {
    assert.equal(action, 'get_mini_app_ark'); assert.equal(args.type, 'bili'); assert.equal(args.title, '真实视频标题'); return JSON.stringify(card);
  } } }, bvid, lookup);
  assert.equal(sent.sent, true); assert.equal(session.sent.length, 1);
  const outgoing = env.onebotHttp.state.sends[0];
  assert.ok(JSON.stringify(outgoing).includes('com.tencent.miniapp_01'));
  assert.match(app.store.recent('group:456', { limit: 1 })[0].text, /B站视频卡片.*真实视频标题/);
  let fallback;
  await shareBiliVideo({ chatKey: 'group:456', onebot: { call: async () => { throw Error('unsupported'); } }, sender: { sendMedia: async (key, segments) => { fallback = JSON.parse(segments[0].data.data); return { message_id: 1 }; } } }, bvid, lookup);
  assert.equal(fallback.meta.news.jumpUrl, 'https://www.bilibili.com/video/' + bvid);
  assert.equal(fallback.meta.news.tag, '哔哩哔哩');
  const { SendQueue } = await import('../src/sender.js');
  const denied = new SendQueue({ onebot: app.onebot, store: app.store });
  await assert.rejects(shareBiliVideo({ chatKey: 'group:999', sender: denied, onebot: { call: async () => JSON.stringify(card) } }, bvid, lookup), /白名单/);
  console.log('PASS Phase 4: canonical BV/av and URL validation, actual metadata, native QQ miniapp JSON, fallback card, queued send with session receipt and archive, deny policy');
} finally { await env.teardown(); }
