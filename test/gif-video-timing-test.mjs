import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gifToVideoDataUrl, GIF_VIDEO_MAX_FRAMES, resolveGifRoute } from '../src/gif-to-video.js';

// A minimal GIF frame; enlarge the logical canvas so yuv420p can encode it.
const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
function gif(delays, loop = true) {
  const header = Buffer.from(pixel.subarray(0, 19));
  header.writeUInt16LE(4, 6);
  header.writeUInt16LE(4, 8);
  return Buffer.concat([
    header,
    ...(loop ? [Buffer.from('21ff0b4e45545343415045322e300301000000', 'hex')] : []),
    ...delays.map(delay => {
      const frame = Buffer.from(pixel.subarray(19, -1));
      frame.writeUInt16LE(delay, 4);
      return frame;
    }),
    Buffer.from([0x3b])
  ]);
}
function probe(file) {
  return JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=pts_time,duration_time:format=duration', '-of', 'json', file
  ], { encoding: 'utf8', windowsHide: true }));
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-gif-timing-'));
try {
  // Fail rather than silently skip if the installed dependency is unavailable.
  execFileSync('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { windowsHide: true, stdio: 'ignore' });
  for (const [name, delays] of [
    ['constant-10fps', Array(53).fill(10)],
    ['variable-frame-delays', [10, 20, 7, 40, 11]]
  ]) {
    const bytes = gif(delays);
    const input = path.join(dir, name + '.gif');
    const output = path.join(dir, name + '.mp4');
    fs.writeFileSync(input, bytes);
    const result = await gifToVideoDataUrl(bytes);
    assert.ok(result, name + ': conversion');
    assert.equal(result.frames, delays.length);
    fs.writeFileSync(output, Buffer.from(result.dataUrl.split(',')[1], 'base64'));
    const original = probe(input);
    const converted = probe(output);
    assert.equal(converted.frames.length, delays.length, 'all frames, one loop only');
    assert.deepEqual(converted.frames.map(f => f.pts_time), original.frames.map(f => f.pts_time), 'per-frame timestamps');
    assert.deepEqual(converted.frames.map(f => f.duration_time), original.frames.map(f => f.duration_time), 'per-frame durations');
    assert.equal(converted.format.duration, original.format.duration, 'complete duration');
    console.log('PASS', name, `${delays.length} frames; identical timestamps and duration`);
  }
  const odd = path.join(dir, 'odd.gif');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=101x61:rate=8:duration=1', odd], { windowsHide: true });
  const oddResult = await gifToVideoDataUrl(fs.readFileSync(odd));
  assert.ok(oddResult);
  assert.equal(oddResult.frames, 8);
  assert.equal(oddResult.width % 2, 0);
  assert.equal(oddResult.height % 2, 0);
  console.log('PASS odd dimensions');
  assert.equal(await gifToVideoDataUrl(gif(Array(GIF_VIDEO_MAX_FRAMES + 1).fill(10))), null, 'reject over-limit input; never truncate');
  assert.equal(await gifToVideoDataUrl(gif([10]).subarray(0, -3)), null, 'reject truncated GIF blocks');
  assert.equal(await gifToVideoDataUrl(Buffer.from('not a GIF')), null);
  assert.equal(resolveGifRoute({ vision: true, video: true }), 'video');
  assert.equal(resolveGifRoute({ vision: true, video: false }), 'gif-image');
  console.log('PASS frame safety limit, malformed input, unchanged routing');
} finally {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('qqa-gif-timing-'));
  fs.rmSync(dir, { recursive: true, force: true });
}
