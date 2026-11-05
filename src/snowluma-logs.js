import fs from 'node:fs';
import path from 'node:path';

// External SnowLuma keeps its own log files. Read only a bounded tail, never whole files.
export function readSnowlumaLogs(dir, memory = [], limit = 500) {
  if (memory.length) return { source: 'process', logs: memory.slice(-limit) };
  if (!dir) return { source: 'file', logs: [] };
  try {
    const base = path.join(dir, 'logs');
    const files = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isFile() && /\.log$/i.test(e.name))
      .map(e => ({ file: path.join(base, e.name), name: e.name, stat: fs.statSync(path.join(base, e.name)) }))
      .filter(e => e.stat.size > 0).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 3);
    let logs = [];
    for (const entry of files) {
      const fd = fs.openSync(entry.file, 'r');
      let text;
      try {
        const start = Math.max(0, entry.stat.size - 512 * 1024);
        const buffer = Buffer.alloc(entry.stat.size - start);
        const count = fs.readSync(fd, buffer, 0, buffer.length, start);
        text = buffer.subarray(0, count).toString('utf8');
        if (start) text = text.slice(text.indexOf('\n') + 1);
      } finally { fs.closeSync(fd); }
      const date = /\d{4}-\d{2}-\d{2}/.exec(entry.name)?.[0];
      const rows = text.split(/\r?\n/).filter(Boolean).slice(-limit).map(line => {
        const time = /^(\d{2}:\d{2}:\d{2})/.exec(line)?.[1];
        return { at: date && time ? new Date(`${date}T${time}`).getTime() : entry.stat.mtimeMs,
          stream: /\b(ERROR|FATAL)\b/.test(line) ? 'stderr' : 'stdout', text: line.replace(/\x1b\[[0-9;]*m/g, '') };
      });
      logs = [...rows, ...logs].slice(-limit);
      if (logs.length >= limit) break;
    }
    return { source: 'file', logs };
  } catch (error) {
    if (error.code === 'ENOENT') return { source: 'file', logs: [] };
    return { source: 'file', logs: [], error: error.message };
  }
}
