<#
.SYNOPSIS
  Installs agent-memory and all three skills from a checkout.

.DESCRIPTION
  `npm install -g .` does this on its own via the postinstall hook. This script
  exists for two cases: installing straight from a clone without npm, and finishing
  the job when a managed npm config sets ignore-scripts=true and silently skips it.

  The linking itself lives in src\setup.js, not here. That is deliberate: a PowerShell
  reimplementation could only be tested on Windows, and the machine this was written
  on is not Windows. One implementation, three entry points, no drift.

  Skills are linked into both agent directories:
    %USERPROFILE%\.agents\skills\<name>   -> read by GitHub Copilot in every window
    %USERPROFILE%\.claude\skills\<name>   -> read by Claude Code

  Directory junctions are used, which need neither admin rights nor Developer Mode.
  They fail on a network-backed profile (FSLogix, roaming), and setup falls back to
  copying and says so.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
#>

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "node not found on PATH. agent-memory needs Node >= 22.5."
    exit 1
}

& node (Join-Path $source 'src\cli.js') setup

Write-Host ""
Write-Host "Linking the CLI" -ForegroundColor Cyan
# npm writes its warnings to stderr, and `2>&1` turns each one into an ErrorRecord,
# which $ErrorActionPreference = 'Stop' then treats as terminating. A managed npm
# config makes that certain rather than unlikely: an unknown key such as `always-auth`
# produces a warning on every single npm invocation, so this step could never succeed
# on the desktops this script exists for. It aborted the whole install — no fallback
# message, no doctor, no closing instructions — over a warning about an unrelated
# config key. Scope the preference to this one call.
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & npm install -g $source 2>&1 | Out-Null
    $npmExit = $LASTEXITCODE
} catch {
    $npmExit = 1
} finally {
    $ErrorActionPreference = $previousPreference
}

if ($npmExit -eq 0) {
    Write-Host "  [npm] agent-memory installed globally" -ForegroundColor Green
} else {
    # A global install failing on a managed desktop is common and not worth aborting
    # on. The skills are already linked; this one step can be finished by hand.
    Write-Host "  [npm] global install failed. Run this yourself:" -ForegroundColor Yellow
    Write-Host "        npm install -g `"$source`"" -ForegroundColor Yellow
}

Write-Host ""
& node (Join-Path $source 'src\cli.js') doctor

Write-Host ""
Write-Host "Installed. Restart VS Code, then try /recall, /remember, or /handoff." -ForegroundColor Cyan
