import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function createShutdownLauncher({ prepare, stopCore }) {
  let pending = null;
  return config => {
    if (pending) return pending;
    if (process.platform !== 'win32') throw Error('当前停机功能支持 Windows 本机部署');
    pending = new Promise((resolve, reject) => {
      const worker = fork(fileURLToPath(new URL('./shutdown-worker.js', import.meta.url)), [], {
        detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      const timer = setTimeout(() => { worker.kill(); reject(Error('停机助手启动超时')); }, 10000);
      worker.on('error', e => { clearTimeout(timer); pending = null; reject(e); });
      worker.on('exit', () => { clearTimeout(timer); pending = null; reject(Error('停机助手已退出')); });
      worker.on('message', async m => {
        if (m.type === 'ready') { clearTimeout(timer); resolve({ url: m.url, token: m.token }); return; }
        if (!['prepare', 'stop-core'].includes(m.type)) return;
        try { await (m.type === 'prepare' ? prepare() : stopCore()); worker.send({ type: m.type }); }
        catch (e) { if (worker.connected) worker.send({ type: m.type, error: e.message }); }
      });
      worker.send({ config: { ...config, agentPid: process.pid } });
      worker.unref(); worker.channel.unref();
    });
    return pending;
  };
}
