# copilot-memory-everywhere

Continue a chat thread in a different VS Code window, on a different repo, without
re-explaining it.

One user-level Agent Skill, `/handoff`, that both **GitHub Copilot** and
**Claude Code** can invoke from a single file. It writes a portable working-state
file outside every repository, so a window opened on a different project can read it.

## Why this exists

Moving context between windows today means copy-pasting the chat, retyping from
memory, and re-explaining. That costs 10 to 15 minutes per switch and burns premium
request credits re-deriving conclusions already reached.

Nothing in the platform closes the gap:

| Mechanism | Why it doesn't help |
|---|---|
| Copilot Memory | Repo-scoped by design. Facts "can only be used in operations on the same repository", and expire after 28 days |
| `/fork` | Copies a conversation inside one workspace |
| Prompt files in `.github/prompts/` | Workspace-scoped, so every repo needs its own copy |
| Third-party memory plugins | Blocked in many managed environments |

## It is not a chat summary

A transcript summary reads fine and still leaves the next agent asking questions.
`/handoff` reconstructs **working state** instead:

- **Decisions** with the *why* and what was rejected
- **Constraints** that are invisible in the code
- **Rejected approaches**, so the next agent stops re-deriving your dead ends
- **Next action** and what's blocking it
- **Uncommitted work** as a file list, never inline diffs
- **Anchors** — the `file:line` references that matter
- **Open questions** only you can answer

## Install

### Windows (Azure Virtual Desktop)

```powershell
git clone https://github.com/vib795/copilot-memory-everywhere.git
cd copilot-memory-everywhere
powershell -ExecutionPolicy Bypass -File .\skills\handoff\install.ps1
```

### macOS / Linux

```bash
git clone https://github.com/vib795/copilot-memory-everywhere.git
cd copilot-memory-everywhere
./skills/handoff/install.sh
```

Both installers link the skill into the two paths the agents actually read:

| Path | Read by |
|---|---|
| `~/.agents/skills/handoff` | GitHub Copilot, in every VS Code window and every repo |
| `~/.claude/skills/handoff` | Claude Code |

Junctions (Windows) and symlinks (POSIX) are preferred, so `git pull` updates both
agents at once. Junctions need no admin rights and no Developer Mode, but they can
fail when the user profile lives on a network share (FSLogix, roaming profiles).
The installer falls back to a copy and tells you which one you got. If you were
copied, re-run the installer after each `git pull`.

Restart VS Code after installing.

## Use

**Window A**, when you're wrapping up or switching:

```
/handoff
```

It prints a pickup line. **Window B**, any repo, paste it:

```
Read C:\Users\you\.agents\handoffs\migrate-orders-to-result-type.md and continue this work. Follow the Next action.
```

That's the whole loop. One command, one paste.

## Where things live

```
%USERPROFILE%\.agents\handoffs\      (Windows)
~/.agents/handoffs/                  (macOS / Linux)
  index.md              one row per thread, kept small so lookup stays cheap
  <thread-id>.md        current handoff
  <thread-id>.detail.md overflow, only when a thread outgrows the soft target
  <thread-id>.prev.md   exactly one prior version
```

Re-running `/handoff` on the same thread updates it in place and keeps one `.prev`
backup. Threads are matched by judgment, not by string-comparing titles, so a title
that drifts as the work progresses does not create a duplicate.

## Design constraints it holds to

- **One model request per handoff.** No tool loops, no re-reading source, no
  interrogating you. Credits are the reason this exists.
- **Zero infrastructure.** Files only. No daemon, no server, no network call,
  nothing for an IT policy to approve.
- **Secrets never hit disk.** Tokens, keys, and connection strings are replaced
  with `<redacted:kind>` before the file is written.
- **Reversible.** `uninstall.ps1` removes the skill; your handoffs are inert
  markdown you can keep or delete.

## Status

v1 is **write-only** and deliberate. You invoke it; it never fires on its own.

Not built yet, by choice:

- `/resume` reader skill (v1 uses a file reference, which both agents support natively)
- Automatic or ambient capture
- Team sharing, multi-machine sync
- An MCP server (it would read this same directory, so it's an addition, not a rewrite)

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\skills\handoff\uninstall.ps1
```

Removes both skill locations. Leaves `~/.agents/handoffs` untouched.

## Spec

Full spec, acceptance criteria, and testing plan: [issue #1](https://github.com/vib795/copilot-memory-everywhere/issues/1).
