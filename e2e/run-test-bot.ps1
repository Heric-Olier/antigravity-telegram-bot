# Starts the bot against an isolated home directory so e2e runs never touch
# the real .env / settings.json / logs of the working copy.
#
# Usage:
#   .\e2e\run-test-bot.ps1
#   .\e2e\run-test-bot.ps1 -SkipBuild

[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$testHome = Join-Path $projectRoot ".tmp\e2e\home"
$sourceEnv = Join-Path $PSScriptRoot ".env"
$runtimeEnv = Join-Path $testHome ".env"

if (-not (Test-Path $testHome)) {
    New-Item -ItemType Directory -Force -Path $testHome | Out-Null
    Write-Host "Created test home: $testHome"
}

if (-not (Test-Path $sourceEnv)) {
    Copy-Item (Join-Path $PSScriptRoot ".env.example") $sourceEnv
    Write-Host "Created $sourceEnv from e2e/.env.example."
    Write-Host "Fill in TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID, then run again."
    exit 1
}

# e2e/.env is the single source of truth. The test home holds runtime state
# only (settings.json, logs), so the config is re-synced on every launch.
Copy-Item $sourceEnv $runtimeEnv -Force

# dotenv does not override variables that already exist in the environment, so
# anything inherited from the parent process would silently win over the test
# config. Clear every key the test .env defines.
Get-Content $runtimeEnv | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
        Remove-Item "env:$($Matches[1])" -ErrorAction SilentlyContinue
    }
}

if (-not $SkipBuild) {
    Write-Host "Building..."
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed."
        exit $LASTEXITCODE
    }
}

$env:OPENCODE_TELEGRAM_HOME = $testHome

Write-Host ""
Write-Host "Test home : $testHome"
Write-Host "Logs      : $(Join-Path $testHome 'logs')"
Write-Host "Settings  : $(Join-Path $testHome 'settings.json')"
Write-Host ""

node (Join-Path $projectRoot "dist\index.js")
