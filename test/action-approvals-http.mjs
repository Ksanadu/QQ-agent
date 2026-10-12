import assert from 'node:assert/strict';
import { bootApp } from './_harness.mjs';
const ctx = await bootApp({ config: { security: { adminUserIds: ['900'] } } });
try {
  const entries = [{ id: 'mock', emojiId: 'qq-mock', desc: 'mock' }];
  ctx.app.stickers.entries = entries;
  ctx.app.stickers.sync = async () => ({ entries });
  let deleted = 0;
  const original = ctx.app.onebot.call.bind(ctx.app.onebot);
  ctx.app.onebot.call = async (action, ...args) => action === 'delete_custom_face' ? (++deleted, {}) : original(action, ...args);
  const op = await ctx.app.approvals.forSession({ id: 'mock-session', chatKey: 'group:456' }, [{ senderId: '900', mid: 1 }]).requestStickerDeletion({ stickerIds: ['mock'] });
  const list = await fetch(ctx.base + '/api/action-approvals');
  assert.equal(list.status, 200); assert.equal((await list.json()).operations[0].id, op.id);
  const blocked = await fetch(ctx.base + '/api/action-approvals/' + op.id + '/approve', { method: 'POST', headers: { origin: 'https://untrusted.example' }, body: '{}' });
  assert.equal(blocked.status, 403); assert.equal(deleted, 0);
  ctx.app.updateConfig({ server: { token: 'test-token' } });
  const unauthorized = await fetch(ctx.base + '/api/action-approvals/' + op.id + '/approve', { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401); assert.equal(deleted, 0);
  const approved = await fetch(ctx.base + '/api/action-approvals/' + op.id + '/approve', { method: 'POST', headers: { 'x-console-token': 'test-token' }, body: JSON.stringify({ targets: ['different'], via: 'qq' }) });
  assert.equal(approved.status, 200); assert.equal(deleted, 1);
  const replay = await fetch(ctx.base + '/api/action-approvals/' + op.id + '/approve', { method: 'POST', headers: { 'x-console-token': 'test-token' }, body: '{}' });
  assert.equal(replay.status, 409); assert.equal(deleted, 1);
  console.log('✓ approval HTTP routes enforce console auth, origin checks, fixed targets and replay rejection');
} finally { await ctx.teardown(); }
