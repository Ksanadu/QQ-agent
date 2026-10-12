import fs from 'node:fs';
import path from 'node:path';

export function extensionIds(roots) {
  const ids = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      for (const name of ['skill.json', 'plugin.json']) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
          const id = String(manifest.id || entry.name);
          ids.set(id, [...(ids.get(id) || []), dir]);
        } catch { /* The loader reports malformed manifests separately. */ }
        break;
      }
    }
  }
  return ids;
}
