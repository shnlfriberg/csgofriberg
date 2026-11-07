param([ValidateSet('server', 'client', 'scraper', 'all')][string]$Suite = 'all', [string]$RedisUrl = '', [string[]]$TestFiles = @())
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$env:PATH = (Join-Path $root '.tools/node-v26.10.0-win-x64') + ';' + $env:PATH
$run = Join-Path $root ('.local-data/verification/' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $run -Force)
$env:DB_CLIENT = 'sqlite'
$env:DB_URL = Join-Path $run 'tests.sqlite3'
$profile = Get-Content -LiteralPath (Join-Path $root 'config/local-profile.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$env:REDIS_URL = if ($RedisUrl) { $RedisUrl } else { $profile.redisUrl + '/15' }
$env:REDIS_PREFIX = 'integration-tests:' + [guid]::NewGuid().ToString('N') + ':'
# Some unit tests deliberately replace Redis with null to test memory fallback.
# Integration tests still connect to the isolated Redis database below.
$env:REDIS_REQUIRED = 'false'
$env:LOCATION_ASSET_DIR = Join-Path $run 'assets'
$env:NODE_OPTIONS = '--require="' + (Join-Path $root '.tools/sqlite-shim.cjs').Replace('\', '/') + '"'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
Push-Location $root
try {
    foreach ($name in @('server', 'client', 'scraper')) {
        if ($Suite -ne 'all' -and $Suite -ne $name) { continue }
        if ($name -eq 'scraper' -and !(Test-Path -LiteralPath (Join-Path $root 'external-scraper/cli.py'))) {
            if ($Suite -eq 'scraper') { throw 'The scraper is maintained in the private shnlfriberg/external-scraper repository. Clone it into external-scraper and restore workspace-integration first.' }
            Write-Host 'Skipping optional private scraper checkout; game suites remain enabled.'
            continue
        }
        Write-Host ('Testing ' + $name + ' in isolated storage: ' + $run)
        if ($name -eq 'scraper') {
            . (Join-Path $PSScriptRoot 'scraper-python.ps1')
            $scraperPython = Get-ScraperPython $root
            Push-Location (Join-Path $root 'external-scraper')
            try { & $scraperPython -m unittest discover -s tests -v } finally { Pop-Location }
        } else { pnpm --filter $name test @TestFiles }
        if ($LASTEXITCODE -ne 0) { throw ($name + ' tests failed') }
    }
} finally { Pop-Location }
