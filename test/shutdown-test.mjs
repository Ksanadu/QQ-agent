import assert from 'node:assert/strict';
import { shutdownPlan, runShutdown } from '../src/shutdown-plan.js';
const config = { agentPid: 10, helperPid: 11, root: 'D:\\bot', snowlumaDir: 'D:\\bot\\snow', agentPort: 3210, snowPorts: [3000, 3001, 5099] };
const row = (pid, parent, exe, command = '') => ({ pid, parent, exe, command, started: `time-${pid}` });
const snapshot = { processes: [
  row(10, 1, 'C:\\node.exe', 'node src/server.js'), row(11, 10, 'C:\\node.exe', 'node shutdown-worker.js'),
  row(12, 11, 'C:\\powershell.exe'), row(13, 10, 'C:\\node.exe'),
  row(20, 1, 'D:\\bot\\snow\\node.exe', 'node index.mjs'), row(21, 20, 'C:\\node.exe'),
  row(30, 10, 'C:\\Tencent\\QQ.exe'), row(31, 30, 'C:\\Tencent\\QQ.exe'),
  row(40, 1, 'C:\\node.exe', 'node D:\\bot-other\\src\\server.js'),
  row(50, 1, 'C:\\powershell.exe', 'echo D:\\bot\\src\\server.js')
], ports: [{ port: 3000, pid: 20 }, { port: 3001, pid: 20 }, { port: 5099, pid: 20 }, { port: 3210, pid: 10 }] };
const plan = shutdownPlan(snapshot, config);
assert.deepEqual(plan.snow.map(p => p.pid), [21, 20]);
assert.deepEqual(plan.agent.map(p => p.pid), [13, 10]);
const events = [], state = structuredClone(snapshot);
await runShutdown({ config, inspect: async () => structuredClone(state),
  prepare: async () => events.push('prepare'), stopCore: async () => events.push('stopCore'), log: text => events.push(text),
  terminate: async p => { events.push(p.pid); state.processes = state.processes.filter(q => q.pid !== p.pid); state.ports = state.ports.filter(q => q.pid !== p.pid); }
});
assert.ok(events.indexOf(20) < events.indexOf('stopCore'));
assert.ok(events.indexOf('stopCore') < events.indexOf(10));
assert.deepEqual(events.filter(e => typeof e === 'number'), [21, 20, 13, 10]);
let killed = false;
await assert.rejects(runShutdown({ config, inspect: async () => ({ ...snapshot, ports: [{ port: 3000, pid: 999 }] }),
  prepare: async () => {}, stopCore: async () => {}, log: () => {}, terminate: async () => { killed = true; }
}), /非本实例/);
assert.equal(killed, false);
await assert.rejects(runShutdown({ config, inspect: async () => snapshot, prepare: async () => {}, stopCore: async () => {},
  terminate: async () => {}, log: () => {}, sleep: async () => {}
}), /未完全停止/);
console.log('PASS shutdown order, tree ownership, QQ/helper exclusion, foreign-port refusal and failure reporting');
