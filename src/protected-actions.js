import { AsyncLocalStorage } from 'node:async_hooks';

const grants = new AsyncLocalStorage();

// A trusted approval executor grants only the exact approved QQ sticker IDs.
export function withStickerDeletionGrant(ids, execute) {
  return grants.run(new Set(ids.map(String)), execute);
}

export function assertProtectedAction(action, params) {
  if (String(action).toLowerCase() !== 'delete_custom_face') return;
  const grant = grants.getStore();
  if (!grant?.has(String(params?.emoji_id))) throw new Error('删除表情需要在管理控制台批准，或由指定管理员确认操作码');
}
