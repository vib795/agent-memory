#!/usr/bin/env bash
# Updates a clone install: pull, then re-run the installer.
#
# The install logic is deliberately not repeated here. install.sh already relinks the
# skills, relinks the CLI and runs doctor; an update is exactly that plus a pull, and
# writing it a second time is how the two drift.
#
# Re-running setup is not optional on an upgrade. Prompt files are copies rather than
# links, so an editor keeps reading the old text until something rewrites it.
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$source_dir/.git" ]; then
  echo "This is not a git checkout, so there is nothing to pull." >&2
  echo "If you installed from npm, update with:" >&2
  echo "  npm install -g @vib795/agent-memory@latest" >&2
  echo "  agent-memory setup" >&2
  exit 1
fi

echo "Pulling"
git -C "$source_dir" pull --ff-only

echo
exec "$source_dir/install.sh"
