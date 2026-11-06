import path from 'node:path';

const norm = s => String(s || '').replaceAll('/', '\\').toLowerCase();
const within = (file, dir) => !!dir && norm(file).startsWith(norm(dir).replace(/\\+$/, '') + '\\');
const hasArg = (command, file) => [...String(command || '').matchAll(/"([^"]*)"|(\S+)/g)].some(m => norm(m[1] ?? m[2]) === norm(file));

export function shutdownPlan(snapshot, { agentPid, helperPid, root, snowlumaDir }) {
  const rows = snapshot.processes || [];
  const protectedIds = new Set([helperPid]);
  // The installed QQ client is user-owned, even if launched from our UI.
  for (const p of rows) if (path.win32.basename(p.exe || '').toLowerCase() === 'qq.exe') protectedIds.add(p.pid);
  const descend = set => {
    for (let changed = true; changed;) {
      changed = false;
      for (const p of rows) if (set.has(p.parent) && !set.has(p.pid)) { set.add(p.pid); changed = true; }
    }
    return set;
  };
  descend(protectedIds);
  const snowRoots = rows.filter(p => !protectedIds.has(p.pid) && (
    within(p.exe, snowlumaDir) && path.win32.basename(p.exe || '').toLowerCase() === 'node.exe'
    || snowlumaDir && path.win32.basename(p.exe || '').toLowerCase() === 'node.exe' && hasArg(p.command, path.win32.join(snowlumaDir, 'index.mjs'))
  )).map(p => p.pid);
  const agentRoots = new Set([agentPid]);
  // Include only wrappers of this instance, not the terminal or unrelated Node apps.
  let current = rows.find(p => p.pid === agentPid);
  while (current) {
    const parent = rows.find(p => p.pid === current.parent);
    if (!parent || !norm(parent.command).includes(norm(root)) || !/set-location.*node\s+src[\\/]server\.js/i.test(parent.command || '')) break;
    agentRoots.add(parent.pid); current = parent;
  }
  for (const p of rows) {
    if (path.win32.basename(p.exe || '').toLowerCase() === 'node.exe' && hasArg(p.command, path.win32.join(root, 'src', 'server.js'))) agentRoots.add(p.pid);
  }
  const snowIds = descend(new Set(snowRoots));
  const agentIds = descend(agentRoots);
  const ordered = ids => {
    const found = rows.filter(p => ids.has(p.pid) && !protectedIds.has(p.pid));
    const depth = p => { let d = 0, seen = new Set(); while (p && !seen.has(p.pid)) { seen.add(p.pid); p = rows.find(x => x.pid === p.parent); d++; } return d; };
    return found.sort((a, b) => depth(b) - depth(a));
  };
  return { snow: ordered(snowIds), agent: ordered(agentIds).filter(p => !snowIds.has(p.pid)) };
}

export async function runShutdown({ config, inspect, terminate, prepare, stopCore, log, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  log('开始停机：暂停新任务，结束正在运行的会话。');
  await prepare();
  let snapshot = await inspect();
  let plan = shutdownPlan(snapshot, config);
  const assertOwned = (ports, allowed) => {
    for (const row of snapshot.ports || []) if (ports.includes(row.port) && !allowed.has(row.pid)) {
      throw Error(`端口 ${row.port} 被非本实例进程 PID ${row.pid} 占用，未终止该进程。`);
    }
  };
  assertOwned(config.snowPorts, new Set(plan.snow.map(p => p.pid)));
  assertOwned([config.agentPort], new Set(plan.agent.map(p => p.pid)));
  const stopRows = async (rows, name) => {
    if (!rows.length) log(`${name} 已停止，无残留进程。`);
    for (const p of rows) { await terminate(p); log(`${name} PID ${p.pid} 已退出。`); }
  };
  const verify = async (rows, ports, name) => {
    for (let i = 0; i < 8; i++) {
      snapshot = await inspect();
      const alive = rows.filter(p => snapshot.processes.some(q => q.pid === p.pid && q.started === p.started));
      const busy = snapshot.ports.filter(p => ports.includes(p.port));
      if (!alive.length && !busy.length) { log(`${name} 进程已清理；端口 ${ports.join('、')} 已释放。`); return; }
      if (i === 7) throw Error(`${name} 未完全停止：残留 PID ${alive.map(p => p.pid).join('、') || '无'}；占用端口 ${busy.map(p => p.port).join('、') || '无'}。`);
      await sleep(400);
    }
  };
  log('[1/2] 停止 SnowLuma 进程树。');
  await stopRows(plan.snow, 'SnowLuma');
  await verify(plan.snow, config.snowPorts, 'SnowLuma');
  // Refresh descendants after cancellation, before the main service closes.
  plan = shutdownPlan(snapshot, config);
  log('[2/2] 保存 QQ-Agent 状态并停止服务。');
  await stopCore();
  await stopRows(plan.agent, 'QQ-Agent');
  await verify(plan.agent, [config.agentPort], 'QQ-Agent');
  log('停机完成。');
}
