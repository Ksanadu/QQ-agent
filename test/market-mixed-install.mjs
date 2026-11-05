import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-market-mixed-'));
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'data');
const copy = new URL('../src/.market-mixed-test.mjs', import.meta.url);
const source = fs.readFileSync(new URL('../src/market.js', import.meta.url), 'utf8')
  .replace('import { ROOT, DATA_DIR, getConfig }', 'import { DATA_DIR, getConfig }');
fs.writeFileSync(copy, source + `\nconst ROOT = ${JSON.stringify(root)};\nexport { zipDirectory };\n`);
const originalFetch = globalThis.fetch;
try {
  const { zipDirectory, installByCode } = await import(copy.href);
  const zips = {};
  for (const kind of ['skill', 'plugin']) {
    const dir = path.join(root, 'fixtures', kind); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify({ id: `qa-${kind}`, name: `QA ${kind}`, version: '1.0.0', entry: 'index.js', apiVersion: 1 }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'export function setup() {}');
    zips[kind] = await zipDirectory(dir);
  }
  const verified = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/install/verify')) {
      const codes = JSON.parse(options.body).codes; verified.push(...codes);
      return Response.json({ results: codes.map(code => ({ code, ok: true, id: code === 'AAA111' ? 'qa-skill' : 'qa-plugin', type: code === 'AAA111' ? 'skill' : 'plugin' })) });
    }
    return new Response(zips[String(url).includes('AAA111') ? 'skill' : 'plugin']);
  };
  const skill = await installByCode({ code: 'AAA111', verified: { ok: true, type: 'plugin', id: 'wrong' } });
  const plugin = await installByCode({ code: 'BBB222', verified: { ok: true, type: 'skill', id: 'wrong' } });
  assert.equal(skill.kind, 'skill'); assert.equal(plugin.kind, 'plugin');
  assert.ok(fs.existsSync(path.join(root, 'skills', 'qa-skill', 'skill.json')));
  assert.ok(fs.existsSync(path.join(root, 'plugins', 'qa-plugin', 'plugin.json')));
  assert.deepEqual(verified, ['AAA111', 'BBB222']);
  console.log('PASS mixed installation classifies both codes on server and ignores mismatched caller type');
} finally {
  globalThis.fetch = originalFetch; fs.rmSync(copy, { force: true }); fs.rmSync(root, { recursive: true, force: true });
}
