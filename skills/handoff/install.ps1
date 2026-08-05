<#
.SYNOPSIS
  Installs the `handoff` skill for GitHub Copilot and Claude Code.

.DESCRIPTION
  Links (or copies) skills\handoff into both user-level skill directories:
    %USERPROFILE%\.agents\skills\handoff   -> read by GitHub Copilot in every VS Code window and repo
    %USERPROFILE%\.claude\skills\handoff   -> read by Claude Code

  Junctions are preferred so `git pull` in this repo updates both agents at once.
  Junctions need no admin rights and no Developer Mode, but they can fail when the
  user profile sits on a network share (FSLogix, roaming profiles). A copy fallback
  handles that; the script tells you which one you got.

  Also creates the handoff store at %USERPROFILE%\.agents\handoffs with an empty index.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\skills\handoff\install.ps1
#>

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
if (-not (Test-Path (Join-Path $source 'SKILL.md'))) {
    Write-Error "SKILL.md not found in $source. Run this script from its place in the repo."
    exit 1
}

$targets = @(
    @{ Name = 'GitHub Copilot'; Path = (Join-Path $env:USERPROFILE '.agents\skills\handoff') },
    @{ Name = 'Claude Code';    Path = (Join-Path $env:USERPROFILE '.claude\skills\handoff') }
)

$copied = @()

foreach ($t in $targets) {
    $link = $t.Path
    $parent = Split-Path $link -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null

    if (Test-Path $link) {
        $item = Get-Item $link -Force
        if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
            Remove-Item $link -Force
        } else {
            Remove-Item $link -Recurse -Force
        }
    }

    try {
        New-Item -ItemType Junction -Path $link -Target $source -ErrorAction Stop | Out-Null
        Write-Host "  [junction] $($t.Name): $link" -ForegroundColor Green
    } catch {
        Copy-Item -Path $source -Destination $link -Recurse -Force
        $copied += $t.Name
        Write-Host "  [copy]     $($t.Name): $link" -ForegroundColor Yellow
        Write-Host "             junction unavailable ($($_.Exception.Message.Trim()))" -ForegroundColor DarkYellow
    }
}

$store = Join-Path $env:USERPROFILE '.agents\handoffs'
New-Item -ItemType Directory -Force -Path $store | Out-Null
$index = Join-Path $store 'index.md'
if (-not (Test-Path $index)) {
    $header = "| id | title | status | repos | updated |`n|----|-------|--------|-------|---------|`n"
    Set-Content -Path $index -Value $header -Encoding UTF8 -NoNewline
    Write-Host "  [store]    created $store with empty index" -ForegroundColor Green
} else {
    Write-Host "  [store]    $store already exists, index left alone" -ForegroundColor Green
}

Write-Host ""
Write-Host "Installed. Restart VS Code, then type /handoff in Copilot chat." -ForegroundColor Cyan
if ($copied.Count -gt 0) {
    Write-Host ""
    Write-Host "NOTE: these were copied, not linked: $($copied -join ', ')" -ForegroundColor Yellow
    Write-Host "      Re-run this script after every 'git pull' to pick up changes." -ForegroundColor Yellow
}
