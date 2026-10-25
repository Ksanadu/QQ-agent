// Backport SnowLuma 76846f40 (signed PTT IDs) to the bundled 1.14.x runtime.
// https://github.com/SnowLuma/SnowLuma/commit/76846f40b141afec1a7d8a11673a1cca1d9ee0fd
// The vendor runtime remains a separate download; never rewrite unknown code.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const oldKey = 'function pttTransKey(selfUin, msgId) {\n\treturn `${selfUin}:${msgId}`;\n}';
const newKey = 'function pttTransKey(selfUin, msgId) {\n\tif (typeof msgId === "number" && !Number.isSafeInteger(msgId)) throw new RangeError("PTT message id must be a safe integer or bigint");\n\treturn `${selfUin}:${BigInt.asIntN(64, BigInt(msgId))}`;\n}';
const decodePrefix = 'function decodePttTransResult(ctx) {\n\tconst item = protobuf_decode_PttTransPush(ctx.content)?.item;\n\tif (!item) return [];\n\tconst msgId = ';
const oldDecode = decodePrefix + 'Number(item.msgId ?? 0n);';
const newDecode = decodePrefix + 'item.msgId ?? 0n;';

export function patchPttSource(source) {
  const crlf = source.includes('\r\n');
  let next = source.replaceAll('\r\n', '\n');
  const hasOnce = token => next.split(token).length === 2;
  if (!hasOnce('function pttTransKey(') || !hasOnce('function decodePttTransResult(')) return { status: 'unsupported', source };
  // Accept our patch, or upstream's lossless key implementation, as already fixed.
  const keyBody = next.match(/function pttTransKey\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const fixedKey = /BigInt\.asIntN\(64,\s*BigInt\(msgId\)\)/.test(keyBody);
  if (hasOnce(newDecode) && fixedKey) return { status: 'already-fixed', source };
  if (!(hasOnce(oldKey) || fixedKey) || !(hasOnce(oldDecode) || hasOnce(newDecode))) {
    return { status: 'unsupported', source };
  }
  if (hasOnce(oldKey)) next = next.replace(oldKey, newKey);
  if (hasOnce(oldDecode)) next = next.replace(oldDecode, newDecode);
  return { status: 'patched', source: crlf ? next.replaceAll('\n', '\r\n') : next };
}

export function patchSnowlumaPtt(dir) {
  const file = path.resolve(dir, 'index.mjs');
  if (!fs.existsSync(file)) return { status: 'missing' };
  const original = fs.readFileSync(file, 'utf8');
  const result = patchPttSource(original);
  if (result.status !== 'patched') return { status: result.status };
  const digest = createHash('sha256').update(original).digest('hex');
  const backup = `${file}.ptt-${digest.slice(0, 16)}.bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  if (createHash('sha256').update(fs.readFileSync(backup)).digest('hex') !== digest) {
    throw new Error('SnowLuma PTT backup verification failed');
  }
  const temp = `${file}.ptt-${process.pid}.tmp`;
  let created = false;
  try {
    fs.writeFileSync(temp, result.source, { flag: 'wx' });
    created = true;
    if (fs.readFileSync(file, 'utf8') !== original) throw new Error('SnowLuma changed while applying PTT patch');
    fs.renameSync(temp, file);
  } finally {
    if (created && fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return { status: result.status, backup };
}
