$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeExe = Join-Path $root '.tools/node-v26.10.0-win-x64/node.exe'
$tsx = Join-Path $root 'server/node_modules/tsx/dist/cli.mjs'
$credentialsFile = Join-Path $root '.local-data/test-admin.json'
if (!(Test-Path -LiteralPath $credentialsFile)) {
    $random = New-Object byte[] 18
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($random) } finally { $generator.Dispose() }
    $json = @{ username = 'integration_admin'; password = ('FyB!' + [Convert]::ToBase64String($random)); url = 'http://localhost:5175/admin' } | ConvertTo-Json
    [IO.File]::WriteAllText($credentialsFile, $json, (New-Object Text.UTF8Encoding($false)))
}
$credentials = Get-Content -LiteralPath $credentialsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$env:ADMIN_USERNAME = $credentials.username
$env:ADMIN_PASSWORD = $credentials.password
$env:NODE_OPTIONS = '--require="' + (Join-Path $root '.tools/sqlite-shim.cjs').Replace('\', '/') + '"'
Push-Location (Join-Path $root 'server')
try {
    & $nodeExe $tsx 'src/db/createAdmin.ts'
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the local administrator' }
    if ((Test-Path -LiteralPath (Join-Path $root 'external-scraper/cli.py')) -and
        (Test-Path -LiteralPath (Join-Path $root 'server/scripts/connect-local-scraper.ts'))) {
        & $nodeExe $tsx 'scripts/connect-local-scraper.ts'
        if ($LASTEXITCODE -ne 0) { throw 'Failed to configure the local scraper' }
    }
} finally {
    Pop-Location
    Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:ADMIN_USERNAME -ErrorAction SilentlyContinue
}
Write-Host ('测试账号已就绪，凭据保存在：' + $credentialsFile)
