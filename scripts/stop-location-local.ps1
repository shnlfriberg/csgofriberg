param([switch]$CheckOnly)
. (Join-Path $PSScriptRoot 'location-local-common.ps1')
$mutex = $null
try {
    $mutex = Enter-LocalServiceLock
    $records = @(Read-LocalServiceState)
    if (!($records | Where-Object { $_.name -eq 'redis' -and (Test-LocalProcessRecord $_) })) {
        $legacyRedis = Get-LegacyLocalRedisRecord
        if ($legacyRedis) { $records += $legacyRedis }
    }
    $live = @($records | Where-Object { Test-LocalProcessRecord $_ })
    Write-Host '弗一把整合版 · 停止本机测试' -ForegroundColor Cyan
    if ($CheckOnly) {
        foreach ($record in $live) { Write-Host ("{0}：PID {1}" -f $record.name, $record.processId) }
        if (!$live.Count) { Write-Host '没有本项目记录的运行进程。' }
        exit 0
    }
    foreach ($name in @('client', 'server')) {
        foreach ($record in @($live | Where-Object { $_.name -eq $name })) {
            Write-Host ("正在停止 {0}…" -f $name)
            Stop-LocalNodeService $record
        }
    }
    foreach ($record in @($live | Where-Object { $_.name -eq 'redis' })) {
        Write-Host '正在保存 Redis 数据并退出…'
        Stop-LocalRedisService $record
    }
    Save-LocalServiceState @()
    Write-Host '本机测试已停止。账号、题库、截图和 Redis 数据均已保留。' -ForegroundColor Green
    Write-Host 'Edge 浏览器窗口可自行关闭。'
} catch {
    Write-Host ('停止失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
