#!/usr/bin/env bash
# Removes the skills and the CLI, in the order that is recoverable.
#
# npm will not enforce that order and gets it wrong on its own: `npm uninstall -g`
# deletes the package and leaves one link per skill per agent pointing at nothing,
# which every one of those agents still tries to load. By then the binary that would
# have cleaned them up is gone too, so tooling cannot fix it. Unlink first, remove
# the package second.
#
# Your notes are never touched. They are plain markdown under ~/.agents/memory, they
# outlive the tool that indexed them, and removing them is your call, not this script's.
#
# No `set -e`: a half-finished uninstall is worse than a reported failure, so each
# step is allowed to fail and say so.
set -uo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH. agent-memory needs Node >= 22.5." >&2
  exit 1
fi

echo "Removing skills"
# Run from the checkout rather than the installed binary, so this still works when
# the global package is already gone.
node "$source_dir/src/cli.js" uninstall

echo
echo "Removing the CLI"
if npm uninstall -g @vib795/agent-memory >/dev/null 2>&1; then
  echo "  [npm] package removed"
else
  echo "  [npm] not removed. It may not be installed globally, or may need sudo:"
  echo "        npm uninstall -g @vib795/agent-memory"
fi

echo
echo "Done. Your notes are untouched at ${AGENT_MEMORY_HOME:-$HOME/.agents/memory}."
