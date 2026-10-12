// One shared allow/deny rule for incoming chats and queued deliveries.
export function chatAllowed(kind, id, cfg) {
  if (!['group', 'private'].includes(kind) || !/^\d+$/.test(String(id))) return false;
  const deny = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (deny.map(String).includes(String(id))) return false;
  const allow = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  return allow.length ? allow.map(String).includes(String(id)) : cfg.allowAllWhenEmpty === true;
}

export function assertDeliveryAllowed(chatKey, cfg, sourceChatKey = '') {
  const match = /^(group|private):(\d+)$/.exec(String(chatKey));
  if (!match || !chatAllowed(match[1], match[2], cfg)) throw new Error('目标聊天未获准发送（白名单或黑名单限制）');
  if (sourceChatKey && sourceChatKey !== chatKey && cfg.tools?.crossChatSend !== true) {
    throw new Error('跨会话发送未开启');
  }
}
