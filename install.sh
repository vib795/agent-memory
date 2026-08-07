#!/usr/bin/env bash
# Installs agent-memory and all three skills from a checkout, on macOS/Linux.
#
# `npm install -g .` does this on its own via the postinstall hook. This script
# exists for two cases: installing straight from a clone without npm, and finishing
# the job when a managed npm config sets ignore-scripts=true and silently skips it.
#
# The linking itself lives in src/setup.js, not here. One implementation, three entry
# points, so this script and its PowerShell twin cannot drift from each other.
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH. agent-memory needs Node >= 22.5." >&2
  exit 1
fi

node "$source_dir/src/cli.js" setup

echo
echo "Linking the CLI"
if npm install -g "$source_dir" >/dev/null 2>&1; then
  echo "  [npm] agent-memory installed globally"
else
  # A global install needing sudo is common and is not worth aborting on. The skills
  # are already linked, and the user can finish this one step by hand.
  echo "  [npm] global install failed (permissions?). Run this yourself:"
  echo "        npm install -g \"$source_dir\""
fi

echo
node "$source_dir/src/cli.js" doctor || true

echo
echo "Installed. Restart VS Code, then try /recall, /remember, or /handoff."
