<#
.SYNOPSIS
  Removes the `handoff` skill. Leaves your handoff files alone.

.DESCRIPTION
  Deletes the two installed skill locations. Handoff content under
  %USERPROFILE%\.agents\handoffs is inert markdown and is NOT touched;
  delete it yourself if you want it gone.
#>

$ErrorActionPreference = 'Stop'

$targets = @(
    (Join-Path $env:USERPROFILE '.agents\skills\handoff'),
    (Join-Path $env:USERPROFILE '.claude\skills\handoff')
)

foreach ($link in $targets) {
    if (-not (Test-Path $link)) { Write-Host "  [skip]   not present: $link"; continue }
    $item = Get-Item $link -Force
    if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
        Remove-Item $link -Force
        Write-Host "  [unlink] $link" -ForegroundColor Green
    } else {
        Remove-Item $link -Recurse -Force
        Write-Host "  [delete] $link" -ForegroundColor Green
    }
}

$store = Join-Path $env:USERPROFILE '.agents\handoffs'
Write-Host ""
Write-Host "Skill removed. Your handoffs are untouched at:" -ForegroundColor Cyan
Write-Host "  $store"
