param([switch]$CheckOnly, [switch]$NoBrowser, [switch]$HotReload)

# Local Windows testing defaults to a stable built frontend. Opt into HMR with -HotReload.
# Production uses the repository Docker flow.
. (Join-Path $PSScriptRoot 'location-local-common.ps1')

function Find-LocalEdge {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft/Edge/Application/msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft/Edge/Application/msedge.exe')
    )
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
    $command = Get-Command msedge.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw '没有找到 Microsoft Edge，请安装 Edge 后重新启动本机测试。'
}

function Wait-LocalTestReady($Records) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($record in $Records) {
            if (!(Test-LocalProcessRecord $record)) { throw "$($record.name) 启动后退出。请查看 .local-data/$($record.name)-local.stderr.log。" }
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($localProfile.apiPort)/api/health" -TimeoutSec 2
            $page = Invoke-WebRequest -Uri "http://127.0.0.1:$($localProfile.webPort)/" -UseBasicParsing -TimeoutSec 2
            if ($health.ok -and $health.redis -eq 'up' -and $page.StatusCode -eq 200 -and (($HotReload -and $page.Content -match '/src/main.tsx') -or (!$HotReload -and $page.Content -match '/assets/' -and $page.Content -notmatch '/@vite/client'))) { return }
        } catch { }
        Start-Sleep -Milliseconds 400
    }
    throw '等待本机测试服务就绪超时。请查看 .local-data 中的 server-local 和 client-local 日志。'
}

$mutex = $null
$newRecords = @()
try {
    $portableNode = Join-Path $workspaceRoot '.tools/node-v26.10.0-win-x64'
    if (Test-Path -LiteralPath (Join-Path $portableNode 'node.exe')) { $env:PATH = $portableNode + ';' + $env:PATH }
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $nodeVersion = & $nodeCommand.Source --version
    if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 26) { throw '本机测试需要 Node.js 26 或更新版本。' }
    $serverEntry = (Join-Path $workspaceRoot 'server/node_modules/tsx/dist/cli.mjs')
    $clientEntry = (Join-Path $workspaceRoot 'client/node_modules/vite/bin/vite.js')
    foreach ($entry in @($serverEntry, $clientEntry)) {
        if (!(Test-Path -LiteralPath $entry)) { throw '缺少项目依赖，请在工作区运行 pnpm install。' }
    }
    $edgeExe = $null
    Write-Host '弗一把整合版 · 本机测试' -ForegroundColor Cyan
    Write-Host ('工作区：' + $workspaceRoot)
    Write-Host ('Node：' + $nodeVersion)
    Write-Host "测试网页：http://localhost:$($localProfile.webPort)/"
    Write-Host "管理员后台：http://localhost:$($localProfile.webPort)/admin"
    if ($CheckOnly) {
        foreach ($port in @($localProfile.apiPort, $localProfile.webPort, $localProfile.redisPort)) { Write-Host ("端口 {0}：{1}" -f $port, (@(Get-LocalListenerIds $port) -join ',')) }
        Write-Host ('Edge：' + $edgeExe)
        exit 0
    }
    Push-Location (Join-Path $workspaceRoot 'packages/location-core')
    try { & $nodeCommand.Source build.cjs; if ($LASTEXITCODE -ne 0) { throw '共享图寻模块构建失败。' } } finally { Pop-Location }
    Push-Location (Join-Path $workspaceRoot 'packages/card-link-core')
    try { & $nodeCommand.Source build.cjs; if ($LASTEXITCODE -ne 0) { throw '共享卡牌模块构建失败。' } } finally { Pop-Location }
    $mutex = Enter-LocalServiceLock
    # Freeze one build identity for both the source server and Vite build/HMR.
    $env:BUILD_INFO_JSON = $null
    $buildInfoJson = & $nodeCommand.Source (Join-Path $workspaceRoot 'scripts/build-info.cjs') json
    if ($LASTEXITCODE -ne 0) { throw '生成应用版本信息失败。' }
    $env:BUILD_INFO_JSON = $buildInfoJson
    [void](New-Item -ItemType Directory -Path $localData -Force)
    $records = @(Read-LocalServiceState | Where-Object { Test-LocalProcessRecord $_ })
    if (!($records | Where-Object { $_.name -eq 'redis' })) {
        $legacyRedis = Get-LegacyLocalRedisRecord
        if ($legacyRedis) { $records += $legacyRedis }
    }
    # Refuse a port owned by anything outside the records verified for this workspace.
    foreach ($service in @(@{ name = 'server'; port = $localProfile.apiPort }, @{ name = 'client'; port = $localProfile.webPort }, @{ name = 'redis'; port = $localProfile.redisPort })) {
        $listeners = @(Get-LocalListenerIds $service.port)
        if (!$listeners.Count) { continue }
        $record = $records | Where-Object { $_.name -eq $service.name } | Select-Object -First 1
        $owned = $false
        if ($record) {
            $owned = $true
            foreach ($listenerId in $listeners) {
                if (!(Test-LocalProcessTreeMember $record $listenerId)) { $owned = $false }
            }
        }
        if (!$owned) { throw "端口 $($service.port) 已被其它或旧版进程占用（PID：$($listeners -join ',')），未自动终止它。请关闭对应服务后重试。" }
    }
    $env:NODE_ENV = 'development'
    $env:DB_CLIENT = 'sqlite'
    $env:LOCATION_ASSET_DIR = Join-Path $workspaceRoot $localProfile.assets
    $env:DB_URL = Join-Path $workspaceRoot $localProfile.database
    $env:REDIS_URL = $localProfile.redisUrl
    $env:REDIS_PREFIX = $localProfile.redisPrefix
    $env:REDIS_REQUIRED = 'true'
    $env:PORT = [string]$localProfile.apiPort
    $env:VITE_DEV_PORT = [string]$localProfile.webPort
    $env:VITE_API_PROXY_TARGET = "http://127.0.0.1:$($localProfile.apiPort)"
    $env:CORS_ORIGINS = "http://localhost:$($localProfile.webPort),http://127.0.0.1:$($localProfile.webPort)"
    $sqliteShim = Join-Path $workspaceRoot '.tools/sqlite-shim.cjs'
    if (Test-Path -LiteralPath $sqliteShim) { $env:NODE_OPTIONS = '--require="' + $sqliteShim.Replace('\', '/') + '"' }
    $runtimeFile = Join-Path $localData 'location-runtime.json'
    if (!(Test-Path -LiteralPath $runtimeFile)) {
        $randomBytes = New-Object byte[] 48
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
        @{ jwtSecret = [Convert]::ToBase64String($randomBytes) } | ConvertTo-Json | Set-Content -LiteralPath $runtimeFile -Encoding UTF8
    }
    $runtime = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$runtime.jwtSecret) { throw '本机登录配置缺少 jwtSecret，请检查 .local-data/location-runtime.json。' }
    $env:JWT_SECRET = $runtime.jwtSecret
    $env:GUEST_ID_SALT = $runtime.jwtSecret
    # Upgrade existing local databases before serving new features, including on repeated launches.
    Write-Host '正在升级并检查本机数据库…'
    $migration = Start-Process -FilePath $nodeCommand.Source -ArgumentList @(('"' + $serverEntry + '"'), 'src/db/migrate.ts') `
        -WorkingDirectory (Join-Path $workspaceRoot 'server') -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $localData 'migrate-local.stdout.log') `
        -RedirectStandardError (Join-Path $localData 'migrate-local.stderr.log') -Wait -PassThru
    if ($migration.ExitCode -ne 0) { throw '本机数据库升级失败，请查看 .local-data/migrate-local.stderr.log。' }
    if (!($records | Where-Object { $_.name -eq 'redis' })) {
        if (!(Test-Path -LiteralPath $redisServer)) { throw '缺少本项目的 Redis，请恢复 .tools/redis 目录。' }
        $redisData = Join-Path $localData 'redis'
        [void](New-Item -ItemType Directory -Path $redisData -Force)
        Write-Host '正在启动 Redis…'
        $process = Start-Process -FilePath $redisServer -ArgumentList @('--bind','127.0.0.1','--port',([string]$localProfile.redisPort),'--dir','.','--appendonly','yes','--save','60','1') -WorkingDirectory $redisData -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $localData 'redis-local.stdout.log') -RedirectStandardError (Join-Path $localData 'redis-local.stderr.log') -PassThru
        $record = Get-LocalProcessRecord 'redis' $process.Id $redisServer
        $newRecords += $record; $records += $record; Save-LocalServiceState $records
        $process.Id | Set-Content -LiteralPath (Join-Path $localData 'redis-local.pid')
    }
    $redisDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (!(Get-LocalListenerIds $localProfile.redisPort)) {
        if ([DateTime]::UtcNow -gt $redisDeadline) { throw 'Redis 未能启动，请查看 .local-data/redis-local.stderr.log。' }
        Start-Sleep -Milliseconds 250
    }
    # Listening can precede AOF/RDB recovery; wait for readiness within the same deadline.
    do {
        $pong = & $redisCli -h 127.0.0.1 -p $localProfile.redisPort ping
        $redisReady = $LASTEXITCODE -eq 0 -and ($pong | Out-String).Trim() -eq 'PONG'
        if ($redisReady) { break }
        if ([DateTime]::UtcNow -gt $redisDeadline) { throw '本机 Redis 未通过连接检查。' }
        Start-Sleep -Milliseconds 250
    } while ($true)
    if (!($records | Where-Object { $_.name -eq 'server' })) {
        Write-Host '正在启动后端…'
        $record = Start-LocalNodeService 'server' $nodeCommand.Source $serverEntry @('watch', 'src/index.ts') (Join-Path $workspaceRoot 'server')
        $newRecords += $record; $records += $record; Save-LocalServiceState $records
    }
    if (!$HotReload) {
        Write-Host '正在构建稳定测试前端（不会因开发连接断开而刷新）…'
        $previousNodeEnv = $env:NODE_ENV
        $env:NODE_ENV = 'production'
        try {
            Push-Location (Join-Path $workspaceRoot 'client')
            try {
                & $nodeCommand.Source (Join-Path $workspaceRoot 'client/node_modules/typescript/bin/tsc') -b
                if ($LASTEXITCODE -ne 0) { throw '前端类型检查失败，保留原运行服务。' }
                # Retain hashed assets so existing tabs can still load their older lazy chunks.
                & $nodeCommand.Source $clientEntry build --outDir ../.local-data/client-preview --emptyOutDir false
                if ($LASTEXITCODE -ne 0) { throw '稳定测试前端构建失败，保留原运行服务。' }
            } finally { Pop-Location }
        } finally { $env:NODE_ENV = $previousNodeEnv }
    }
    $existingClient = $records | Where-Object { $_.name -eq 'client' } | Select-Object -First 1
    if ($existingClient) {
        $clientProcess = Get-LocalProcess ([int]$existingClient.processId)
        $isPreview = [string]$clientProcess.CommandLine -match '\spreview(?:\s|$)'
        if ($isPreview -eq [bool]$HotReload) {
            Write-Host '正在切换前端测试模式；后端和 Redis 保持运行…'
            Stop-LocalNodeService $existingClient
            $records = @($records | Where-Object { $_.name -ne 'client' })
            Save-LocalServiceState $records
        }
    }
    if (!($records | Where-Object { $_.name -eq 'client' })) {
        Write-Host '正在启动前端…'
        $frontendArgs = @('--host', '127.0.0.1', '--port', ([string]$localProfile.webPort), '--strictPort')
        if (!$HotReload) { $frontendArgs = @('preview', '--outDir', '../.local-data/client-preview') + $frontendArgs }
        $record = Start-LocalNodeService 'client' $nodeCommand.Source $clientEntry $frontendArgs (Join-Path $workspaceRoot 'client')
        $newRecords += $record; $records += $record; Save-LocalServiceState $records
    }
    Save-LocalServiceState $records
    Write-Host '正在等待网页就绪…'
    Wait-LocalTestReady $records
    Write-Host '本机测试已启动，关闭此窗口不会停止服务。' -ForegroundColor Green
    if (!$HotReload) { Write-Host '当前为稳定测试模式。代码修改后重新运行启动脚本，再手动刷新页面；需要热更新开发时使用 -HotReload。' }
    Write-Host '停止时请双击工作区中的“停止本机测试.cmd”。'
    if (!$NoBrowser) {
        Start-Process "http://localhost:$($localProfile.webPort)/" | Out-Null
        Write-Host '已打开测试网页。'
    }
} catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    # Roll back only processes started by this invocation; leave previously running services intact.
    foreach ($record in @($newRecords | Where-Object { $_.name -ne 'redis' })) { try { Stop-LocalNodeService $record } catch { Write-Warning $_ } }
    foreach ($record in @($newRecords | Where-Object { $_.name -eq 'redis' })) { try { Stop-LocalRedisService $record } catch { Write-Warning $_ } }
    exit 1
} finally {
    if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
