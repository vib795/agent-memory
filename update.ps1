<#
.SYNOPSIS
  Updates a clone install: pull, then re-run the installer.

.DESCRIPTION
  The install logic is deliberately not repeated here. install.ps1 already relinks the
  skills, relinks the CLI and runs doctor; an update is exactly that plus a pull, and
  writing it a second time is how the two drift.

  Re-running setup is not optional on an upgrade. Prompt files are copies rather than
  links, so VS Code keeps reading the old text until something rewrites it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\update.ps1
#>

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot

if (-not (Test-Path (Join-Path $source '.git'))) {
    Write-Host "This is not a git checkout, so there is nothing to pull." -ForegroundColor Yellow
    Write-Host "If you installed from npm, update with:" -ForegroundColor Yellow
    Write-Host "  npm install -g @vib795/agent-memory@latest" -ForegroundColor Yellow
    Write-Host "  agent-memory setup" -ForegroundColor Yellow
    exit 1
}

Write-Host "Pulling" -ForegroundColor Cyan
# git writes ordinary progress to stderr, and `Stop` would treat that as terminating.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & git -C $source pull --ff-only 2>&1 | Write-Host
    $gitExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousPreference
}
if ($gitExit -ne 0) {
    Write-Error "git pull failed. Resolve that first, then run this again."
    exit 1
}

Write-Host ""
& powershell -ExecutionPolicy Bypass -File (Join-Path $source 'install.ps1')
