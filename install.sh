#!/usr/bin/env bash
# Installs agent-memory and all three skills from a checkout, on macOS/Linux.
#
# The package ships no install hook, on purpose: an install script that writes into
# another tool's agent directory is the shape of a supply-chain agent hijack. Nothing
# is linked until someone asks, and this script is that ask for a clone.
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
