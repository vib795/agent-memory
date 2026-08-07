#!/usr/bin/env bash
# Installs agent-memory and all three skills on macOS/Linux.
# Windows (AVD) users: run install.ps1 instead.
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skills=(handoff recall remember)

for s in "${skills[@]}"; do
  [ -f "$source_dir/skills/$s/SKILL.md" ] || { echo "missing skills/$s/SKILL.md" >&2; exit 1; }
done

# node:sqlite ships inside Node core from 22.5 onward. That is the whole reason this
# package has no runtime dependencies, so the version check is not optional.
if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH. agent-memory needs Node >= 22.5." >&2
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<5)){console.error(`Node ${process.versions.node} is too old; need >= 22.5 for node:sqlite.`);process.exit(1)}'

echo "Installing skills"
for s in "${skills[@]}"; do
  for base in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
    target="$base/$s"
    mkdir -p "$base"
    if [ -e "$target" ] || [ -L "$target" ]; then rm -rf "$target"; fi
    ln -s "$source_dir/skills/$s" "$target"
    echo "  [symlink] $target"
  done
done

# Only `recall` is registered. `compact` overwrites the description of every path it
# is given with the store digest, and handoff and remember describe themselves.
# Registering all three would silently replace two good descriptions with a third.
# The canonical file is registered rather than a symlink: both links resolve to it.
recall_skill="$source_dir/skills/recall/SKILL.md"

echo
echo "Initialising the store"
node "$source_dir/src/cli.js" init --skills "$recall_skill"

echo
echo "Linking the CLI"
if npm install -g "$source_dir" >/dev/null 2>&1; then
  echo "  [npm] agent-memory installed globally"
else
  # A global install needing sudo is common and is not worth aborting on. Everything
  # else already works, and the user can finish this one step by hand.
  echo "  [npm] global install failed (permissions?). Run this yourself:"
  echo "        npm install -g \"$source_dir\""
fi

echo
node "$source_dir/src/cli.js" doctor || true

echo
echo "Installed. Restart VS Code, then try /recall, /remember, or /handoff."
