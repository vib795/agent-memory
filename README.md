# copilot-memory-everywhere

Give **GitHub Copilot** and **Claude Code** a memory that outlives the window, the
repository, and the week — using nothing an IT security review would need to approve.

Three user-level Agent Skills over one local store:

| Skill | What it does |
|---|---|
| `/handoff` | Writes a portable working-state file so another window can pick up this thread |
| `/remember` | Captures durable knowledge into a cross-repo graph |
| `/recall` | Answers from that graph before deriving anything again |

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

## Zero runtime dependencies

`node:sqlite` has shipped inside Node core since 22.5, so the graph index needs no
package, no service, and no network. `npm ls -g --depth 0` shows nothing under it.
On a locked-down desktop that is the difference between "a Node script" and "a new
database", which is the entire argument you will have to make to get this approved.

- **Markdown is the source of truth.** `index.db` is a disposable cache; delete it
  and `agent-memory index` rebuilds it byte-identically.
- **Nothing leaves the machine.** No daemon, no scheduled task, no telemetry.
- **Uninstalling leaves readable notes behind.** The store is plain markdown and
  stays useful with no tooling at all.

## The memory graph

Notes live at `%USERPROFILE%\.agents\memory\notes\<type>\<id>.md`, outside every
repository — that is what makes a note written in one project readable from another.

```yaml
id: auth-service
type: system            # system | decision | convention | constraint
title: Auth uses server sessions
scope: repo             # repo | global
confidence: observed    # observed | inferred
captured_sha: a1b2c3d   # repo HEAD at capture; drives the staleness signal
repos: [orders-api]
edges:
  - rel: depends-on     # depends-on | applies-to | supersedes | contradicts | evidence-for
    dst: postgres-primary
```

Traversal is a SQLite recursive CTE. There is no graph layer on top of SQLite; the
recursive CTE *is* the graph engine, and `UNION` plus a depth bound is what keeps a
`contradicts` cycle from recursing forever.

### What keeps it honest

- **Staleness is visible at the moment of use.** Every note records the repo HEAD it
  was captured at. On recall, `get` prints `captured 47 commits ago — verify before
  trusting`. A note that quietly rots is worse than no note.
- **Redaction is fail-closed.** Keys, tokens, connection strings, private keys,
  session cookies, internal hosts and foreign email addresses are replaced before any
  byte reaches disk — not to a note, not to a temp file, not to the index.
- **Truncation is never silent.** Whenever the tree or the retrieval budget drops
  something, the omitted ids are printed. Silent truncation reads as full coverage.
- **Constraints are never dropped.** At any cap, in either tier. A constraint is what
  stops an agent burning a retry loop on an approach that was never going to ship.

## CLI

```
agent-memory init [--skills "<p1>,<p2>"]   create the store, register skill files
agent-memory index                         rebuild index.db from notes/
agent-memory tree [--repo <name>] [--all]  routing map, scoped to a repo
agent-memory get <id> [--depth N]          a note plus its neighborhood
                     [--budget N] [--include-archived]
agent-memory search <terms> [--limit N]    full-text fallback when the tree misses
agent-memory write --from-json <file>      validated upsert; used by the skills
agent-memory compact                       dedup, decay, reindex, regenerate
agent-memory doctor                        preflight and health report
```

Every command takes `--json`. Every cap lives in `config.json` and is tunable.

## Install

Installing the package installs everything — the CLI, all three skills, and the
store. There is no second step.

```bash
npm install -g https://github.com/vib795/copilot-memory-everywhere.git
```

The `postinstall` hook links `handoff`, `recall` and `remember` into both agent
directories (`~/.agents/skills` and `~/.claude/skills`, or `%USERPROFILE%\...` on
Windows), creates the store, and generates the routing digest. Restart VS Code and
`/recall`, `/remember` and `/handoff` are all live.

Windows uses directory junctions, which need neither admin rights nor Developer
Mode. On a network-backed profile (FSLogix, roaming) junctions fail and the skills
are copied instead — setup says which one you got, and copies need
`agent-memory setup` re-run after each upgrade.

### If nothing appears to happen

Managed npm configurations often set `ignore-scripts=true`, which skips
`postinstall` with no warning at all. One command fixes it:

```bash
agent-memory setup
```

`agent-memory doctor` reports `skills linked: none registered` when this is the
situation, so it is visible rather than mysterious.

### From a clone

```bash
./install.sh                                          # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\install.ps1 # Windows
```

Both are thin wrappers over `agent-memory setup`; the linking logic lives in
`src/setup.js` so there is one implementation rather than three that drift.

Note that `npm install -g .` from a clone *symlinks* rather than copies, so
`compact` regenerates the description in your working tree and
`skills/recall/SKILL.md` will show as modified. That is expected — the description
is generated state, and the committed value is only a placeholder.

Needs Node 22.5 or newer; `doctor` says so plainly if the version is too old, and
`postinstall` refuses rather than failing your install.

Run `npm test` for the suite (59 tests, no dependencies).

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
