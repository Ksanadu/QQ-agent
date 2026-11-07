import { setTimeout as delay } from 'node:timers/promises';

export const STALE_REPLY = '未执行：收到本轮新增消息，请结合补充内容重新决定。';

export function replyDelay(value, fallback = 2000) {
  return value != null && value !== '' && Number.isFinite(Number(value))
    ? Math.max(0, Number(value)) : fallback;
}

export class ReplyWindow {
  constructor({ entries, delayMs, receivedAt, fromListener = false }) {
    this.entries = [...entries];
    this.actors = new Set(entries.map(m => String(m.senderId)));
    this.delayMs = delayMs;
    this.deadline = receivedAt + delayMs;
    this.fromListener = fromListener;
    this.version = 0;
    this.pending = 0;
    this.change = new AbortController();
  }

  notify() {
    this.change.abort();
    this.change = new AbortController();
  }

  refresh(at) {
    this.deadline = Math.max(this.deadline, at + this.delayMs);
    this.notify();
  }

  add(entry, at) {
    this.entries.push(entry);
    this.version++;
    this.refresh(at);
  }

  reserve(at) {
    this.pending++;
    this.refresh(at);
    return () => { this.pending--; this.notify(); };
  }

  isCurrent(version) { return this.version === version && !this.pending; }

  async #wait(ms, signal) {
    signal.throwIfAborted();
    const changed = this.change.signal;
    const wait = new AbortController();
    const interrupt = () => wait.abort();
    changed.addEventListener('abort', interrupt, { once: true });
    signal.addEventListener('abort', interrupt, { once: true });
    try { await delay(Math.min(ms, 2_147_483_647), undefined, { signal: wait.signal }); }
    catch (error) { if (!changed.aborted) throw error; }
    finally {
      changed.removeEventListener('abort', interrupt);
      signal.removeEventListener('abort', interrupt);
    }
    signal.throwIfAborted();
  }

  async waitForInputs(signal) {
    while (this.pending) await this.#wait(2147483647, signal);
    signal.throwIfAborted();
  }

  async waitToSend(version, signal, onWait) {
    while (this.isCurrent(version)) {
      signal.throwIfAborted();
      const left = this.deadline - Date.now();
      if (left <= 0) return true;
      onWait?.();
      await this.#wait(left, signal);
    }
    return false;
  }

  assertCurrent(version, signal) {
    signal.throwIfAborted();
    if (!this.isCurrent(version)) throw Error(STALE_REPLY);
  }

  assertSend(version, signal) {
    this.assertCurrent(version, signal);
    if (this.deadline > Date.now()) throw Error(STALE_REPLY);
  }
}
