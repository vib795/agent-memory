<#
.SYNOPSIS
  Removes the skills and the CLI, in the order that is recoverable.

.DESCRIPTION
  npm will not enforce that order and gets it wrong on its own: `npm uninstall -g`
  deletes the package and leaves one link per skill per agent pointing at nothing,
  which every one of those agents still tries to load. By then the binary that would
  have cleaned them up is gone too, so tooling cannot fix it. This unlinks first and
  removes the package second.

  Your notes are never touched. They are plain markdown under
  %USERPROFILE%\.agents\memory, they outlive the tool that indexed them, and removing
  them is your call, not this script's.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>

# Not 'Stop': a half-finished uninstall is worse than a reported failure, so each step
# is allowed to fail and say so.
$ErrorActionPreference = 'Continue'

$source = $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "node not found on PATH. agent-memory needs Node >= 22.5."
    exit 1
}

Write-Host "Removing skills" -ForegroundColor Cyan
# Run from the checkout rather than the installed binary, so this still works when the
# global package is already gone.
& node (Join-Path $source 'src\cli.js') uninstall

Write-Host ""
Write-Host "Removing the CLI" -ForegroundColor Cyan
try {
    & npm uninstall -g '@vib795/agent-memory' 2>&1 | Out-Null
    $npmExit = $LASTEXITCODE
} catch {
    $npmExit = 1
}

if ($npmExit -eq 0) {
    Write-Host "  [npm] package removed" -ForegroundColor Green
} else {
    Write-Host "  [npm] not removed. It may not be installed globally:" -ForegroundColor Yellow
    Write-Host "        npm uninstall -g `"@vib795/agent-memory`"" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Your notes are untouched." -ForegroundColor Cyan
