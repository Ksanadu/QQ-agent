import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export function localQQConnected(connected, wsUrl) {
  try { return !!connected && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(wsUrl).hostname); }
  catch { return false; }
}

// Open the user's installed QQ; no bundled runtime, separate profile, or process stop.
export async function launchLocalQQ({ platform = process.platform, run = exec, start = spawn, exists = fs.existsSync, env = process.env } = {}) {
  if (platform !== 'win32') return { ok: false, error: '当前仅支持启动 Windows 本机 QQ' };
  let discovered = {};
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8;
      $qqProcess = Get-CimInstance Win32_Process -Filter "name='QQ.exe'" | Select-Object -First 1;
      $qqPaths = @();
      foreach ($qqKey in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\QQ.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\QQ.exe','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\QQ.exe')) {
        $qqItem = Get-ItemProperty -LiteralPath $qqKey -ErrorAction SilentlyContinue;
        if ($qqItem) { $qqPaths += $qqItem.'(default)' }
      }
      foreach ($qqRoot in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
        Get-ItemProperty ($qqRoot+'\\*') -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -match '^QQ(\\s|$|NT)'} | ForEach-Object {
          if ($_.InstallLocation) { $qqPaths += (Join-Path $_.InstallLocation 'QQ.exe'); $qqPaths += (Join-Path $_.InstallLocation 'Bin\\QQ.exe') }
          if ($_.DisplayIcon) { $qqPaths += ($_.DisplayIcon -replace ',\\d+$','').Trim('"') }
        }
      }
      [pscustomobject]@{pid=$qqProcess.ProcessId; paths=@($qqProcess.ExecutablePath)+$qqPaths} | ConvertTo-Json -Compress`
    ], { windowsHide: true, timeout: 15000 });
    discovered = JSON.parse(String(stdout).trim() || '{}');
  } catch { /* standard install paths remain available */ }
  if (Number(discovered.pid) > 0) return { ok: true, alreadyRunning: true, pid: Number(discovered.pid) };
  const candidates = [...(discovered.paths || []),
    ...[env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)
      .flatMap(base => [path.join(base, 'Tencent', 'QQNT', 'QQ.exe'), path.join(base, 'Tencent', 'QQ', 'Bin', 'QQ.exe')])];
  const exe = candidates.find(p => p && exists(p));
  if (!exe) return { ok: false, error: '未找到本机 QQ，请先安装并打开一次 QQ' };
  return new Promise(resolve => {
    const child = start(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', error => resolve({ ok: false, error: error.message }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, pid: child.pid }); });
  });
}
