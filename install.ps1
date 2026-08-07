<#
.SYNOPSIS
  Installs agent-memory and all three skills for GitHub Copilot and Claude Code.

.DESCRIPTION
  Links (or copies) skills\handoff, skills\recall and skills\remember into both
  user-level skill directories:
    %USERPROFILE%\.agents\skills\<name>   -> read by GitHub Copilot in every window
    %USERPROFILE%\.claude\skills\<name>   -> read by Claude Code

  Junctions are preferred so `git pull` updates both agents at once. They need no
  admin rights and no Developer Mode, but they fail when the user profile sits on a
  network share (FSLogix, roaming profiles). A copy fallback handles that, and the
  script tells you which one you got.

  Then creates the memory store at %USERPROFILE%\.agents\memory, registers each
  SKILL.md so `agent-memory compact` can regenerate its description, and runs doctor.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
#>

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$skills = @('handoff', 'recall', 'remember')

foreach ($s in $skills) {
    if (-not (Test-Path (Join-Path $source "skills\$s\SKILL.md"))) {
        Write-Error "skills\$s\SKILL.md not found in $source. Run this script from its place in the repo."
        exit 1
    }
}

# node:sqlite ships inside Node core from 22.5 onward. That is the whole reason this
# package has no runtime dependencies, so the version check is not optional.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "node not found on PATH. agent-memory needs Node >= 22.5."
    exit 1
}
$version = (& node -e 'process.stdout.write(process.versions.node)')
$parts = $version.Split('.')
if (([int]$parts[0] -lt 22) -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 5)) {
    Write-Error "Node $version is too old; agent-memory needs >= 22.5 for node:sqlite."
    exit 1
}

$copied = @()
# Only `recall` is registered for description regeneration. `compact` overwrites the
# description of every path it is given with the store digest, and handoff and
# remember describe themselves; registering all three would replace two good
# descriptions with a third. A junction resolves to the canonical file, so one
# rewrite reaches every agent. A copy does not, so a copied recall registers too.
$skillPaths = New-Object System.Collections.Generic.List[string]
$skillPaths.Add((Join-Path $source 'skills\recall\SKILL.md'))

foreach ($s in $skills) {
    $skillSource = Join-Path $source "skills\$s"

    $targets = @(
        @{ Name = 'GitHub Copilot'; Path = (Join-Path $env:USERPROFILE ".agents\skills\$s") },
        @{ Name = 'Claude Code';    Path = (Join-Path $env:USERPROFILE ".claude\skills\$s") }
    )

    foreach ($t in $targets) {
        $link = $t.Path
        New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null

        if (Test-Path $link) {
            $item = Get-Item $link -Force
            if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
                Remove-Item $link -Force
            } else {
                Remove-Item $link -Recurse -Force
            }
        }

        try {
            New-Item -ItemType Junction -Path $link -Target $skillSource -ErrorAction Stop | Out-Null
            Write-Host "  [junction] $s -> $($t.Name)" -ForegroundColor Green
        } catch {
            Copy-Item -Path $skillSource -Destination $link -Recurse -Force
            $copied += "$s ($($t.Name))"
            if ($s -eq 'recall') { $skillPaths.Add((Join-Path $link 'SKILL.md')) }
            Write-Host "  [copy]     $s -> $($t.Name)" -ForegroundColor Yellow
            Write-Host "             junction unavailable ($($_.Exception.Message.Trim()))" -ForegroundColor DarkYellow
        }
    }
}

Write-Host ""
Write-Host "Initialising the store" -ForegroundColor Cyan
& node (Join-Path $source 'src\cli.js') init --skills ($skillPaths -join ',')

Write-Host ""
Write-Host "Linking the CLI" -ForegroundColor Cyan
& npm install -g $source 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [npm] agent-memory installed globally" -ForegroundColor Green
} else {
    # A global install failing on a managed desktop is common and not worth aborting
    # on. Everything else already works and this one step can be finished by hand.
    Write-Host "  [npm] global install failed. Run this yourself:" -ForegroundColor Yellow
    Write-Host "        npm install -g `"$source`"" -ForegroundColor Yellow
}

Write-Host ""
& node (Join-Path $source 'src\cli.js') doctor

Write-Host ""
Write-Host "Installed. Restart VS Code, then try /recall, /remember, or /handoff." -ForegroundColor Cyan
if ($copied.Count -gt 0) {
    Write-Host ""
    Write-Host "NOTE: these were copied, not linked: $($copied -join ', ')" -ForegroundColor Yellow
    Write-Host "      Re-run this script after every 'git pull' to pick up changes." -ForegroundColor Yellow
}
