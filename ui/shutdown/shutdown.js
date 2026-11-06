'use strict';
async function runShutdownPage() {
  const status = document.querySelector('.shutdown-status');
  const log = document.querySelector('.shutdown-log');
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  try {
    if (!/^[a-f0-9]{64}$/.test(token)) throw Error('停机凭据已失效，请从 QQ-Agent 重新点击停机。');
    const call = async (route, method = 'GET') => {
      const res = await fetch(route, { method, headers: { 'x-shutdown-token': token }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw Error(`停机助手返回 HTTP ${res.status}`);
      return res.json();
    };
    let snapshot = await call('/run', 'POST');
    const deadline = Date.now() + 180000;
    while (true) {
      log.textContent = snapshot.logs.map(l => `[${new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${l.text}`).join('\n');
      log.scrollTop = log.scrollHeight;
      status.textContent = snapshot.status === 'done' ? '停机完成' : snapshot.status === 'failed' ? '停机失败' : '正在停机…';
      if (snapshot.status === 'failed') throw Error(`请按日志处理后重试。日志文件：${snapshot.logFile}`);
      if (snapshot.status === 'done') break;
      if (Date.now() > deadline) throw Error('停机超时，请查看本机 data/logs/shutdown 日志。');
      await new Promise(r => setTimeout(r, 400));
      snapshot = await call('/status');
    }
    for (let seconds = 3; seconds > 0; seconds--) {
      status.textContent = `停机完成 · ${seconds} 秒后关闭标签页`;
      await new Promise(r => setTimeout(r, 1000));
    }
    window.close();
    status.textContent = '已停机，可手动关闭此标签页';
  } catch (e) {
    status.textContent = '停机未完成';
    log.textContent += `\n${e.message}`;
  }
}
void runShutdownPage();
