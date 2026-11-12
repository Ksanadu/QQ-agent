export function hasMessageId(value) {
  return /^-?[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
}

// An acknowledgement can be lost or malformed after QQ actually sends.
// Without independent evidence, a second submission is not safe.
export class DeliveryUnconfirmedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'DELIVERY_UNCONFIRMED';
  }
}
