export function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Read-only adapters that do not yet accept a signal must not keep a chat slot
// after cancellation. Adapters that do accept it also stop their actual I/O.
export function interruptible(signal, work) {
  if (!signal) return work();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => signal.removeEventListener('abort', onAbort);
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }).then(value => { done(); resolve(value); }, error => { done(); reject(error); });
  });
}
