import { backendAddress } from './preferences.js';

export function shutdownLogUrl(job) {
  const base = backendAddress(job?.url);
  if (!job?.url || !/^[a-f0-9]{64}$/.test(job.token || '')) throw new Error('停机日志地址无效');
  return base + '/#' + job.token;
}
