param(
    [ValidateSet('setup', 'start', 'stop', 'test', 'backend-test', 'build', 'import')]
    [string]$Action = 'start',
    [string]$PlayersFile = ''
)
# Compatibility entry point: all local commands use the integrated workspace.
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeDir = Join-Path $repoRoot '.tools/node-v26.10.0-win-x64'
if (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe')) { $env:PATH = $nodeDir + ';' + $env:PATH }

Push-Location $repoRoot
try {
    switch ($Action) {
        'start' { & (Join-Path $PSScriptRoot 'start-location-local.ps1') -NoBrowser }
        'stop' { & (Join-Path $PSScriptRoot 'stop-location-local.ps1') }
        'test' { & (Join-Path $PSScriptRoot 'test-integrated.ps1') -Suite all }
        'backend-test' { & (Join-Path $PSScriptRoot 'test-integrated.ps1') -Suite server }
        'setup' {
            if (!(Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe')) -or
                !(Test-Path -LiteralPath (Join-Path $repoRoot '.tools/redis/Redis-8.10.2-Windows-x64-msys2/redis-server.exe'))) {
                throw 'Restore the workspace .tools Node 26 and Redis runtimes first; see docs/integration.md.'
            }
            pnpm install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        }
        'build' {
            pnpm build
            if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
        }
        'import' {
            if (!$PlayersFile) { throw 'Specify -PlayersFile with a local players.json path.' }
            $inputFile = (Resolve-Path -LiteralPath $PlayersFile).Path
            if (!(Test-Path -LiteralPath $inputFile -PathType Leaf)) { throw 'PlayersFile must be a file.' }
            # Reuse the canonical migration, Redis and process ownership checks.
            & (Join-Path $PSScriptRoot 'start-location-local.ps1') -NoBrowser
            if ($LASTEXITCODE -ne 0) { throw 'Integrated local services did not start.' }
            & node (Join-Path $repoRoot 'server/node_modules/tsx/dist/cli.mjs') (Join-Path $PSScriptRoot 'import-local-players.ts') $inputFile
            if ($LASTEXITCODE -ne 0) { throw 'Player import failed.' }
        }
    }
} finally { Pop-Location }
