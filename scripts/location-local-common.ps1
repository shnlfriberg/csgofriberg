# Shared Windows-only process management for the local test launchers.
$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$localProfile = Get-Content -LiteralPath (Join-Path $workspaceRoot 'config/local-profile.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$localData = Join-Path $workspaceRoot '.local-data'
$serviceStateFile = Join-Path $localData 'location-services.json'
$redisDirectory = Join-Path $workspaceRoot '.tools/redis/Redis-8.10.2-Windows-x64-msys2'
$redisServer = Join-Path $redisDirectory 'redis-server.exe'
$redisCli = Join-Path $redisDirectory 'redis-cli.exe'

function Get-LocalListenerIds([int]$Port) {
    @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-LocalProcess([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Get-LocalProcessRecord([string]$Name, [int]$ProcessId, [string]$EntryPoint) {
    $item = Get-LocalProcess $ProcessId
    if (!$item) { throw "进程 $Name 已退出，请查看 .local-data 中的日志。" }
    [pscustomobject]@{
        name = $Name
        processId = [int]$item.ProcessId
        startedAt = $item.CreationDate.ToUniversalTime().ToString('o')
        executable = [string]$item.ExecutablePath
        entryPoint = $EntryPoint
    }
}

function Test-LocalProcessRecord($Record) {
    if (!$Record -or !$Record.processId -or !$Record.startedAt -or !$Record.executable -or !$Record.entryPoint) { return $false }
    $item = Get-LocalProcess ([int]$Record.processId)
    if (!$item -or !$item.ExecutablePath -or !$item.CreationDate) { return $false }
    # Both the PID and birth time must match, so a reused PID cannot stop another app.
    # PowerShell 7 may deserialize ISO timestamps as DateTime and normalize the
    # fractional digits. Compare instants, so records also work across PS 5/7.
    try { $savedStart = ([DateTimeOffset]$Record.startedAt).UtcDateTime.Ticks } catch { return $false }
    if ($item.CreationDate.ToUniversalTime().Ticks -ne $savedStart -or
        ![string]::Equals($item.ExecutablePath, $Record.executable, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $rootPrefix = $workspaceRoot.TrimEnd('\') + '\'
    if (!$Record.entryPoint.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $command = ([string]$item.CommandLine).Replace('/', '\')
    $command.IndexOf(([string]$Record.entryPoint).Replace('/', '\'), [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-LocalProcessTreeMember($Record, [int]$ProcessId) {
    if (!(Test-LocalProcessRecord $Record)) { return $false }
    $seen = @{}
    $current = Get-LocalProcess $ProcessId
    while ($current -and !$seen.ContainsKey([int]$current.ProcessId)) {
        if ([int]$current.ProcessId -eq [int]$Record.processId) { return $true }
        $seen[[int]$current.ProcessId] = $true
        $current = Get-LocalProcess ([int]$current.ParentProcessId)
    }
    $false
}

function Read-LocalServiceState {
    if (!(Test-Path -LiteralPath $serviceStateFile)) { return @() }
    $state = Get-Content -LiteralPath $serviceStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.format -ne 1 -or $state.workspace -ne $workspaceRoot) { throw '本机测试进程记录不属于当前工作区，请检查 .local-data/location-services.json。' }
    @($state.services | Where-Object { $_ })
}

function Save-LocalServiceState($Records) {
    [void](New-Item -ItemType Directory -Path $localData -Force)
    $temporary = $serviceStateFile + '.tmp'
    @{ format = 1; workspace = $workspaceRoot; services = @($Records) } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $serviceStateFile -Force
}

function Get-LegacyLocalRedisRecord {
    $legacyFile = Join-Path $localData 'redis-local.pid'
    if (!(Test-Path -LiteralPath $legacyFile)) { return $null }
    $savedId = 0
    if (![int]::TryParse((Get-Content -LiteralPath $legacyFile -Raw).Trim(), [ref]$savedId)) { return $null }
    $item = Get-LocalProcess $savedId
    if (!$item -or ![string]::Equals($item.ExecutablePath, $redisServer, [StringComparison]::OrdinalIgnoreCase) -or
        @(Get-LocalListenerIds $localProfile.redisPort) -notcontains $savedId) { return $null }
    # The legacy file was written immediately after startup. Reject PID-file reuse.
    $written = (Get-Item -LiteralPath $legacyFile).LastWriteTimeUtc
    if ([Math]::Abs(($written - $item.CreationDate.ToUniversalTime()).TotalSeconds) -gt 30) { return $null }
    Get-LocalProcessRecord 'redis' $savedId $redisServer
}

function Enter-LocalServiceLock {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($workspaceRoot.ToLowerInvariant()))).Replace('-', '') }
    finally { $hash.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\FribergLocalTest_' + $key))
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (!$acquired) { $mutex.Dispose(); throw '另一个启动或停止窗口正在操作，请稍后再试。' }
    $mutex
}

function Start-LocalNodeService([string]$Name, [string]$NodeExe, [string]$EntryPoint, [string[]]$ExtraArguments, [string]$Directory) {
    # Start-Process joins arguments on Windows; quote the absolute script path.
    $arguments = @(('"' + $EntryPoint + '"')) + $ExtraArguments
    $process = Start-Process -FilePath $NodeExe -ArgumentList $arguments -WorkingDirectory $Directory -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $localData ($Name + '-local.stdout.log')) `
        -RedirectStandardError (Join-Path $localData ($Name + '-local.stderr.log')) -PassThru
    Get-LocalProcessRecord $Name $process.Id $EntryPoint
}

function Stop-LocalNodeService($Record) {
    if (!(Test-LocalProcessRecord $Record)) { return }
    # Restrict tree termination to the verified project process; never kill all node.exe processes.
    $output = & "$env:SystemRoot\System32\taskkill.exe" /PID ([string]$Record.processId) /T /F 2>&1
    if ($LASTEXITCODE -ne 0 -and (Test-LocalProcessRecord $Record)) { throw "无法停止 $($Record.name)：$output" }
}

function Stop-LocalRedisService($Record) {
    if (!(Test-LocalProcessRecord $Record)) { return }
    $listeners = @(Get-LocalListenerIds $localProfile.redisPort)
    if ($listeners -notcontains [int]$Record.processId) { throw '已记录的 Redis 没有监听测试端口；为避免误关其它服务，未执行停止。' }
    if (!(Test-Path -LiteralPath $redisCli)) { throw '缺少本机 Redis 客户端，无法安全保存并关闭 Redis。' }
    # SAVE is intentional: accounts/questions are in SQLite, active local games are in Redis.
    $output = & $redisCli -h 127.0.0.1 -p $localProfile.redisPort shutdown save 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Redis 保存退出失败：$output" }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (Test-LocalProcessRecord $Record) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Redis 仍在保存数据，请稍后重新点击停止。' }
        Start-Sleep -Milliseconds 200
    }
}
