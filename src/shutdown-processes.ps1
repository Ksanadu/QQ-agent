$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.action -eq 'inspect') {
    $processes = @(Get-CimInstance Win32_Process | ForEach-Object {
        [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; exe=$_.ExecutablePath; command=$_.CommandLine; started=$(if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {''})}
    })
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $request.ports -contains $_.LocalPort } | ForEach-Object {
        [pscustomobject]@{port=[int]$_.LocalPort; pid=[int]$_.OwningProcess}
    })
    [pscustomobject]@{processes=$processes; ports=$ports} | ConvertTo-Json -Depth 5 -Compress
} elseif ($request.action -eq 'stop') {
    foreach ($item in $request.processes) {
        $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$item.pid)
        if (-not $p) { continue }
        if ($p.CreationDate.ToUniversalTime().ToString('o') -ne $item.started) { throw "PID identity changed; refusing to stop $($item.pid)" }
        Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop
    }
    '{"ok":true}'
} else { throw 'Unknown shutdown action' }
