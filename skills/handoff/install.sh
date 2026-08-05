#!/usr/bin/env bash
# Installs the `handoff` skill for GitHub Copilot and Claude Code on macOS/Linux.
# Windows (AVD) users: run install.ps1 instead.
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$source_dir/SKILL.md" ] || { echo "SKILL.md not found in $source_dir" >&2; exit 1; }

for target in "$HOME/.agents/skills/handoff" "$HOME/.claude/skills/handoff"; do
  mkdir -p "$(dirname "$target")"
  if [ -e "$target" ] || [ -L "$target" ]; then rm -rf "$target"; fi
  ln -s "$source_dir" "$target"
  echo "  [symlink] $target"
done

store="$HOME/.agents/handoffs"
mkdir -p "$store"
if [ ! -f "$store/index.md" ]; then
  printf '| id | title | status | repos | updated |\n|----|-------|--------|-------|---------|\n' > "$store/index.md"
  echo "  [store]   created $store with empty index"
else
  echo "  [store]   $store already exists, index left alone"
fi

echo
echo "Installed. Restart VS Code, then type /handoff in Copilot chat."
