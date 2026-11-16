// Rasterize the approved SVG with electron-builder's existing icon toolchain.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runIconsTool } = require('app-builder-lib/out/toolsets/icons.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'desktop/assets');
const inputFile = path.join(assets, 'icon.svg'), outDir = path.join(root, 'dist-desktop-icons');
await fs.mkdir(outDir, { recursive: true });
await runIconsTool({ inputFile, outputFormat: 'set', outDir });
await runIconsTool({ inputFile, outputFormat: 'ico', outDir });
await fs.copyFile(path.join(outDir, '512x512.png'), path.join(assets, 'icon.png'));
await fs.copyFile(path.join(outDir, 'icon.ico'), path.join(assets, 'icon.ico'));
console.log('Created desktop/assets/icon.png and icon.ico from icon.svg');
