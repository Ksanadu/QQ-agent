// A failed send response is not proof of non-delivery. Only recover a receipt
// from a NEW self-authored message with the same destination and full content.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const MESSAGE_ACTIONS = new Set(['send_group_msg', 'send_private_msg', 'send_msg']);
const POKE_ACTIONS = new Set(['group_poke', 'friend_poke', 'send_poke']);
const MEDIA = new Set(['image', 'record', 'video', 'file']);
const decode = value => String(value ?? '').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
const mid = row => String(row?.message_id ?? '');
const timestamp = row => Number(row?.time) * 1000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}

async function mediaIdentity(data) {
  const refs = [data.md5, data.file, data.url].filter(Boolean).map(String);
  const hashes = new Set();
  for (const ref of refs) {
    const hash = ref.match(/(?:^|[^a-f\d])([a-f\d]{32})(?=$|[^a-f\d])/i)?.[1];
    if (hash) hashes.add(hash.toLowerCase());
  }
  const ref = String(data.file || '');
  if (ref.startsWith('base64://')) {
    hashes.add(createHash('md5').update(Buffer.from(ref.slice(9), 'base64')).digest('hex'));
  } else if (/^file:/i.test(ref) || path.isAbsolute(ref)) {
    // The file was already selected for sending; never download remote URLs to
    // guess identity. Stream hashing bounds memory for video/voice attachments.
    try {
      const file = /^file:/i.test(ref) ? fileURLToPath(ref) : ref;
      const stat = await fs.promises.stat(file);
      if (stat.isFile() && stat.size > 0 && stat.size <= 256 * 1024 * 1024) {
        const hash = createHash('md5');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        hashes.add(hash.digest('hex'));
      }
    } catch { /* Unreadable local files cannot supply delivery evidence. */ }
  }
  return { hashes, refs: new Set(refs.filter(r => !r.startsWith('base64://'))) };
}

async function signature(message) {
  const parts = typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message;
  if (!Array.isArray(parts) || !parts.length) return null;
  const out = [];
  for (const p of parts) {
    const d = p?.data || {};
    let value;
    if (p.type === 'text') {
      value = decode(d.text);
      if (!value) continue;
      if (out.at(-1)?.type === 'text') { out.at(-1).value += value; continue; }
    } else if (p.type === 'at') value = String(d.qq);
    else if (p.type === 'reply') value = String(d.id);
    else if (MEDIA.has(p.type)) value = await mediaIdentity(d);
    else if (p.type === 'json') {
      try { value = JSON.stringify(stable(JSON.parse(d.data))); } catch { return null; }
    } else if (p.type === 'face') value = String(d.id);
    else return null; // An unknown segment must never be treated as "same".
    out.push({ type: p.type, value });
  }
  return out.length ? out : null;
}

async function sameMessage(expected, actual) {
  const got = await signature(actual);
  if (!got || expected.length !== got.length) return false;
  return expected.every((p, i) => {
    const q = got[i];
    if (p.type !== q.type) return false;
    if (!MEDIA.has(p.type)) return p.value === q.value;
    return [...p.value.hashes].some(h => q.value.hashes.has(h))
      || [...p.value.refs].some(ref => q.value.refs.has(ref));
  });
}

export class DeliveryVerifier {
  constructor() { this.events = []; this.consumed = new Map(); this.serial = 0; this.pending = new Map(); }

  async run(action, params, execute) {
    if (!MESSAGE_ACTIONS.has(action) && !POKE_ACTIONS.has(action)) return execute();
    const key = params.group_id != null ? `group:${params.group_id}` : `private:${params.user_id}`;
    const next = (this.pending.get(key) || Promise.resolve()).catch(() => {}).then(execute);
    this.pending.set(key, next);
    try { return await next; }
    finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }

  observe(event) {
    if (!['message', 'message_sent', 'notice'].includes(event?.post_type)) return;
    const now = Date.now();
    this.events = this.events.filter(x => now - x.receivedAt < 120000).slice(-199);
    this.events.push({ ...event, receivedAt: now, deliverySerial: ++this.serial });
    for (const [id, at] of this.consumed) if (now - at > 120000) this.consumed.delete(id);
  }

  async prepare(action, params, selfId, query) {
    if (!selfId || (!MESSAGE_ACTIONS.has(action) && !POKE_ACTIONS.has(action))) return null;
    const kind = params.group_id != null ? 'group' : 'private';
    const peer = String(kind === 'group' ? params.group_id : params.user_id);
    if (!/^\d+$/.test(peer)) return null;
    const poke = POKE_ACTIONS.has(action);
    const expected = poke ? null : await signature(params.message);
    if (!poke && !expected) return null;
    const attempt = { kind, peer, selfId: String(selfId), poke, expected,
      target: String(params.user_id || peer), beforeIds: new Set(), baseline: false, query };
    if (!poke) {
      // Snapshot BEFORE submitting, so an old identical message (even in the
      // same second) cannot turn a real failure into a false success.
      try {
        for (const row of await this.history(attempt)) attempt.beforeIds.add(mid(row));
        attempt.baseline = true;
      } catch { /* Self echoes remain usable when history is unavailable. */ }
    }
    attempt.startedAt = Date.now();
    attempt.eventCursor = this.serial;
    return attempt;
  }

  async history(a) {
    const action = a.kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const data = await a.query(action, { [a.kind === 'group' ? 'group_id' : 'user_id']: Number(a.peer), count: 30 }, 1500);
    if (!Array.isArray(data?.messages)) throw new Error('History unavailable');
    return data.messages;
  }

  destination(a, row, echo) {
    if (String(row.user_id ?? row.sender?.user_id ?? '') !== a.selfId) return false;
    if (a.kind === 'group') return String(row.group_id ?? '') === a.peer;
    if (row.group_id != null || row.message_type === 'group') return false;
    const peer = row.target_id ?? row.peer_id;
    // Private history is already scoped by the query; echoes must name its peer.
    return peer == null ? !echo : String(peer) === a.peer;
  }

  async recover(a) {
    if (!a) return null;
    // The self event may arrive after the failed HTTP response (the real 241
    // incident took about one second). Bound all polling and never resend here.
    const deadline = Date.now() + 5500;
    for (let poll = 0; poll < 3; poll++) {
      if (poll) await delay(700);
      const events = this.events.filter(e => e.deliverySerial > a.eventCursor);
      if (a.poke) {
        if (events.some(e => e.post_type === 'notice' && e.notice_type === 'notify' && e.sub_type === 'poke'
          && String(e.user_id ?? e.sender_id) === a.selfId && String(e.target_id) === a.target
          && (a.kind === 'group' ? String(e.group_id) === a.peer : e.group_id == null))) return { delivery_verified: true };
        continue;
      }
      let rows = events.map(e => ({ row: e, echo: true }));
      if (Date.now() < deadline) {
        try { rows.push(...(await this.history(a)).map(row => ({ row, echo: false }))); } catch { /* Preserve the original send error. */ }
      }
      for (const { row, echo } of rows) {
        const id = mid(row), key = `${a.kind}:${a.peer}:${id}`;
        if (!id || id === '0' || a.beforeIds.has(id) || this.consumed.has(key) || !this.destination(a, row, echo)) continue;
        const ts = timestamp(row);
        if (!Number.isFinite(ts) || ts < Math.floor(a.startedAt / 1000) * 1000 || ts > Date.now() + 2000) continue;
        // Without a baseline, same-second historical rows are ambiguous.
        if (!echo && !a.baseline && ts < a.startedAt) continue;
        if (!await sameMessage(a.expected, row.message)) continue;
        this.consumed.set(key, Date.now());
        return { message_id: row.message_id, delivery_verified: true };
      }
      if (Date.now() >= deadline) break;
    }
    return null;
  }
}
