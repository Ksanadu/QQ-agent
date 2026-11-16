import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), asar = require('@electron/asar');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.resolve(process.argv[2] || path.join(root, 'dist-desktop/win-unpacked/resources/app.asar'));
const expectedVersion = process.argv[3] || JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8')).version;
const metadata = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(metadata.name, 'qq-agent-desktop');
assert.equal(metadata.main, 'main.js');
assert.equal(metadata.version, expectedVersion);
assert.deepEqual(metadata.dependencies, {});
const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
const ownFiles = new Set(['main.js','preload.cjs','gateway.js','preferences.js','window-policy.js']);
let count = 0;
for (const name of entries) {
  const nativeName = path.normalize(name);
  if (asar.statFile(archive, nativeName).files) continue;
  assert.ok(!/^(src|skills|plugins|data|snowluma|node_modules)\//.test(name), 'unexpected runtime/data: ' + name);
  if (name === 'package.json') continue;
  const source = name.startsWith('legacy-ui/') ? path.join(root, 'ui', name.slice('legacy-ui/'.length))
    : name.startsWith('ui/') ? path.join(root, 'desktop', name)
    : name.startsWith('assets/') ? path.join(root, 'desktop', name)
    : name === 'LICENSE' ? path.join(root, name)
    : ownFiles.has(name) ? path.join(root, 'desktop', name) : null;
  assert.ok(source, 'unexpected packaged file: ' + name);
  assert.ok(asar.extractFile(archive, nativeName).equals(fs.readFileSync(source)), 'packaged/source mismatch: ' + name);
  count++;
}
assert.ok(entries.includes('LICENSE'));
assert.ok(entries.includes('legacy-ui/vendor/tier-slider.js'));
assert.ok(entries.includes('legacy-ui/vendor/price-match.js'));
assert.ok(entries.includes('ui/desktop.css'));
assert.ok(entries.includes('assets/icon.svg'));
const vector = asar.extractFile(archive, path.normalize('assets/icon.svg')).toString();
assert.match(vector, /viewBox="0 0 1280 1280"/); assert.ok(!/<(?:image|script)\b/i.test(vector), 'a real vector, not an embedded raster');
const ico = asar.extractFile(archive, path.normalize('assets/icon.ico'));
assert.equal(ico.readUInt32LE(0), 65536);
const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
for (const size of [16,32,48,256]) assert.ok(sizes.includes(size), 'ICO size ' + size);
console.log(`PASS desktop ${expectedVersion} package: ${count} source-matched assets, license, no bot core/config/data/extensions/dependencies`);
