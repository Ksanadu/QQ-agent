import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchSnowlumaPtt } from '../src/snowluma-ptt-patch.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = patchSnowlumaPtt(process.argv[2] || path.join(root, 'snowluma'));
console.log(JSON.stringify(result));
if (result.status === 'unsupported' || result.status === 'missing') process.exitCode = 1;
