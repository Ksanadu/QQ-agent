import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGenerateCommand, parseImageCommand } from '../src/image-commands.js';
import { ImageCommandService, ADMIN_QQ, beijingDay } from '../src/image-command-service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-generate-unit-'));
let checks = 0;
const event = (text, user = '111', mid = 1) => ({ post_type: 'message', user_id: user, sender: { user_id: user }, message_id: mid, message: [{ type: 'text', data: { text } }] });
const command = (user, mid, request = '画一只橘猫', name = 'generate') => parseImageCommand(event(`/${name} ` + request, user, mid), '888');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

for (const text of ['画一张图', '请 /generate 一只猫', '"/generate 一只猫"', '/generatex 一只猫', '/GENERATE 一只猫']) assert.equal(parseGenerateCommand(event(text), '888'), null);
assert.equal(parseGenerateCommand(event('/generate'), '888').request, '');
assert.equal(parseGenerateCommand(event('/generate\n橘猫'), '888').request, '橘猫');
const at = event('/generate 橘猫'); at.message.unshift({ type: 'at', data: { qq: '888' } });
assert.equal(parseGenerateCommand(at, '888').actorId, '111');
at.message[0].data.qq = '999'; assert.equal(parseGenerateCommand(at, '888'), null);
const quoted = event('/generate 猫'); quoted.message = [{ type: 'forward', data: { text: '/generate 猫' } }];
assert.equal(parseGenerateCommand(quoted, '888'), null);
const spoofed = event('/generate 猫', '111'); spoofed.sender.user_id = ADMIN_QQ;
assert.equal(parseGenerateCommand(spoofed, '888'), null);
assert.equal(parseGenerateCommand({ ...event('/generate 猫'), post_type: 'message_sent' }, '888'), null);
assert.equal(parseGenerateCommand({ ...event('/generate 猫'), message: '[CQ:at,qq=888] /generate 猫' }, '888').request, '猫');
checks++; console.log('✓ strict command parsing, trusted identity, @/reply and forwarded/spoofed input');
assert.equal(parseImageCommand(event('/comfy 猫'), '888').name, 'comfy');
assert.equal(parseImageCommand(event('/comfyx 猫'), '888'), null);
assert.equal(parseGenerateCommand(event('/comfy 猫'), '888'), null);

function fixture(name, overrides = {}) {
  let clock = 1800000000000, allowed = true;
  const sends = [], images = [], calls = [];
  const service = new ImageCommandService({
    stateFile: path.join(root, name, 'quota.json'), now: () => clock,
    preparePrompt: async (request) => { calls.push('prepare'); return { prompt: `A polished image: ${request}`, ratio: '1:1' }; },
    generateImage: async () => { calls.push('generate'); return { buffer: Buffer.from('image') }; },
    saveImage: async () => { calls.push('save'); return { file: 'test.png' }; }, ...overrides
  });
  const ctx = (user = '111', mid = 1, chatKey = 'group:456', request) => ({
    command: command(user, mid, request, service.commandName), chatKey, kind: chatKey.split(':')[0], canSend: () => allowed,
    sender: { sendTextBatch: async (_key, texts) => { sends.push(texts[0]); calls.push('ack'); }, sendImage: async (...args) => { images.push(args); calls.push('image'); } }
  });
  return { service, ctx, calls, sends, images, setClock: (value) => { clock = value; }, deny: () => { allowed = false; } };
}

try {
  const f = fixture('rate');
  const first = f.service.handle(f.ctx());
  const raced = f.service.handle(f.ctx('111', 2, 'private:111'));
  const third = f.service.handle(f.ctx('111', 3, 'group:789'));
  const fourth = f.service.handle(f.ctx('111', 4));
  await Promise.all([first.completion, raced.completion, third.completion, fourth.completion]);
  assert.equal(f.images.length, 3); assert.ok(f.sends.some((s) => /每天 3 张/.test(s)));
  assert.ok(f.calls.indexOf('ack') < f.calls.indexOf('prepare'));
  await f.service.handle(f.ctx()).completion;
  assert.equal(f.images.length, 3); // redelivery is ignored, not a new quota request.
  const reboot = fixture('rate');
  await reboot.service.handle(reboot.ctx('111', 5)).completion;
  assert.equal(reboot.images.length, 0); assert.match(reboot.sends[0], /每天 3 张/);
  reboot.setClock(1800000000000 + 3600000);
  await reboot.service.handle(reboot.ctx('111', 6)).completion; assert.equal(reboot.images.length, 0);
  reboot.setClock(1800000000000 + 86400000);
  await reboot.service.handle(reboot.ctx('111', 5)).completion; assert.equal(reboot.images.length, 1);
  checks++; console.log('✓ three burst requests allowed, fourth denied across groups/private chats, restart persistence and daily reset');

  const midnight = fixture('midnight');
  midnight.setClock(Date.parse('2026-10-14T15:59:59.999Z'));
  assert.equal(beijingDay(Date.parse('2026-10-14T15:59:59.999Z')), '2026-10-14');
  assert.equal(beijingDay(Date.parse('2026-10-14T16:00:00.000Z')), '2026-10-15');
  await Promise.all([1, 2, 3].map((id) => midnight.service.handle(midnight.ctx('111', id)).completion));
  midnight.setClock(Date.parse('2026-10-14T16:00:00.000Z'));
  await midnight.service.handle(midnight.ctx('111', 4)).completion;
  assert.equal(midnight.images.length, 4);
  checks++; console.log('✓ midnight reset uses Asia/Shanghai rather than host timezone or rolling 24 hours');

  const rollover = fixture('rollover');
  rollover.setClock(Date.parse('2026-10-14T15:59:59.999Z'));
  const oldReservation = rollover.service.reserve(command('111', 1), 'group:456');
  rollover.setClock(Date.parse('2026-10-14T16:00:00.000Z'));
  rollover.service.reserve(command('111', 2), 'group:456');
  rollover.service.releaseUnused({ ...rollover.ctx('111', 1), ...oldReservation, imageCreated: false });
  assert.equal(rollover.service.readState().users['111'].day, '2026-10-15');
  assert.equal(rollover.service.readState().users['111'].entries.length, 1);
  const legacy = fixture('legacy'); fs.mkdirSync(path.dirname(legacy.service.stateFile), { recursive: true });
  fs.writeFileSync(legacy.service.stateFile, JSON.stringify({ version: 1, users: { '111': 1800000000000 }, events: {} }));
  await Promise.all([2, 3, 4].map((id) => legacy.service.handle(legacy.ctx('111', id)).completion));
  assert.equal(legacy.images.length, 2); assert.equal(legacy.service.readState().version, 2);
  checks++; console.log('✓ old quota migrates without clearing usage; prior-day failures cannot refund next-day reservations');

  const apiStateBeforeComfy = fs.readFileSync(f.service.stateFile, 'utf8');
  const comfy = fixture('comfy', { commandName: 'comfy', model: 'Anima', dailyLimit: null, maxActive: 1 });
  await Promise.all([1, 2, 3, 4].map((id) => comfy.service.handle(comfy.ctx('111', id)).completion));
  assert.equal(comfy.images.length, 4); assert.equal(Object.keys(comfy.service.readState().users).length, 0);
  assert.throws(() => comfy.service.handle(f.ctx('111', 8)), /匹配/);
  assert.equal(fs.readFileSync(f.service.stateFile, 'utf8'), apiStateBeforeComfy);
  checks++; console.log('✓ unlimited Comfy requests use an independent serial queue and do not touch exhausted API quota');

  const admin = fixture('admin');
  await Promise.all([1, 2, 3, 4].map((id) => admin.service.handle(admin.ctx(ADMIN_QQ, id)).completion));
  assert.equal(admin.images.length, 4);
  await admin.service.handle(admin.ctx(ADMIN_QQ, 1)).completion; assert.equal(admin.images.length, 4);
  const adminRestart = fixture('admin');
  await adminRestart.service.handle(adminRestart.ctx(ADMIN_QQ, 1)).completion; assert.equal(adminRestart.images.length, 0);
  checks++; console.log('✓ only QQ 2456214815 is exempt; duplicate admin events remain idempotent across restart');

  const gate = deferred(), ack = fixture('ack');
  const pendingCtx = ack.ctx(); pendingCtx.sender.sendTextBatch = () => gate.promise;
  const pending = ack.service.handle(pendingCtx);
  await Promise.resolve(); assert.equal(ack.calls.length, 0);
  gate.resolve(); await pending.completion; assert.equal(ack.images.length, 1);
  const empty = fixture('empty');
  const emptyCtx = empty.ctx(); emptyCtx.command = parseGenerateCommand(event('/generate'), '888');
  await empty.service.handle(emptyCtx).completion;
  assert.equal(empty.calls.includes('generate'), false); assert.equal(fs.existsSync(empty.service.stateFile), false);
  checks++; console.log('✓ receipt is awaited before prompting/generation; empty commands do not spend quota');

  const prep = fixture('prep-error', { preparePrompt: async () => { throw new Error('bad prompt JSON'); } });
  await prep.service.handle(prep.ctx()).completion;
  assert.equal(prep.service.readState().users['111'], undefined); assert.equal(prep.calls.includes('generate'), false);
  const failure = fixture('image-error', { generateImage: async () => { throw new Error('HTTP 503'); } });
  await failure.service.handle(failure.ctx()).completion;
  assert.equal(failure.service.readState().users['111'], undefined); assert.match(failure.sends.at(-1), /未消耗/);
  const sendFail = fixture('send-error'); const sendCtx = sendFail.ctx();
  sendCtx.sender.sendImage = async () => { throw new Error('OneBot offline'); };
  await sendFail.service.handle(sendCtx).completion;
  assert.ok(sendFail.service.readState().users['111']); assert.ok(sendFail.calls.includes('save'));
  checks++; console.log('✓ prompt/upstream failures release quota; produced images retain daily count if delivery fails');

  let attempt = 0;
  const refund = fixture('concurrent-refund', { generateImage: async () => { if (++attempt === 1) throw new Error('upstream unavailable'); return {}; } });
  await Promise.all([1, 2, 3].map((id) => refund.service.handle(refund.ctx('111', id)).completion));
  assert.equal(refund.images.length, 2); assert.equal(refund.service.readState().users['111'].entries.length, 2);
  await refund.service.handle(refund.ctx('111', 4)).completion;
  assert.equal(refund.images.length, 3); assert.equal(refund.service.readState().users['111'].entries.length, 3);
  checks++; console.log('✓ failed concurrent job releases only its own slot, even when all requests share a timestamp');

  const deniedGate = deferred(), denied = fixture('denied', { generateImage: async () => { await deniedGate.promise; return {}; } });
  const deniedJob = denied.service.handle(denied.ctx());
  await new Promise((r) => setImmediate(r)); denied.deny(); deniedGate.resolve(); await deniedJob.completion;
  assert.equal(denied.images.length, 0);
  const stopGate = deferred(), stop = fixture('stop', { preparePrompt: async (_r, signal) => { await stopGate.promise; signal.throwIfAborted(); return {}; } });
  const stopped = stop.service.handle(stop.ctx()); await new Promise((r) => setImmediate(r));
  stop.service.stop(); stopGate.resolve(); await stopped.completion;
  assert.equal(stop.images.length, 0); assert.equal(stop.service.readState().users['111'], undefined);
  checks++; console.log('✓ policy changes and skill deactivation prevent late delivery; cancelled preparation releases quota');

  const corrupt = fixture('corrupt'); fs.mkdirSync(path.dirname(corrupt.service.stateFile), { recursive: true });
  fs.writeFileSync(corrupt.service.stateFile, 'bad json');
  await corrupt.service.handle(corrupt.ctx()).completion;
  assert.equal(corrupt.calls.includes('generate'), false); assert.equal(fs.readFileSync(corrupt.service.stateFile, 'utf8'), 'bad json');
  checks++; console.log('✓ corrupt quota state fails closed without resetting usage');
  console.log(`${checks} behavioral test groups passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
