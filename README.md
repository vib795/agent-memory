# agent-memory

[![test](https://github.com/vib795/agent-memory/actions/workflows/test.yml/badge.svg)](https://github.com/vib795/agent-memory/actions/workflows/test.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

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

Two commands, and the second one is not optional:

```bash
npm install -g @vib795/agent-memory
agent-memory setup
```

Straight from git works too, and needs no registry access:

```bash
npm install -g https://github.com/vib795/agent-memory.git
agent-memory setup
```

`setup` probes for every agent on the machine and installs into each one it finds,
in whatever format that tool reads. It then creates the store and generates the
routing digest.

| Detected | Installed as | Where |
|---|---|---|
| Agent skills (shared convention) | linked skill directory | `~/.agents/skills/<name>/` |
| Claude Code, CLI and VS Code extension | linked skill directory | `~/.claude/skills/<name>/` |
| VS Code, Insiders, VSCodium, Cursor, Windsurf | prompt file | `<user data>/prompts/<name>.prompt.md` |
| Copilot CLI | *detected, skipped* | it documents no user-global prompt directory; use `.github/copilot-instructions.md` per repo |

Prompt files are what GitHub Copilot chat reads, and they appear as `/recall`,
`/remember` and `/handoff` in the chat box. They are **generated from the same
`SKILL.md` files** rather than maintained separately, so the two formats cannot
drift, and `compact` regenerates the routing digest into both.

`agent-memory doctor` lists what it detected, so an install that appears to do
nothing tells you whether your editor was missed or simply ignored the files.

**Why it is not automatic.** There is a `postinstall` hook that does exactly this,
but current npm refuses to run package install scripts unless you opt in per
package, and prints only a warning when it skips them. Managed environments go
further and set `ignore-scripts=true` globally. Rather than pretend, the second
command is documented as part of the install. If you would rather have it automatic:

```bash
npm install -g --allow-scripts=@vib795/agent-memory @vib795/agent-memory
```

Either way `agent-memory doctor` tells you where you stand; it reports
`skills linked: none registered` when setup has not run.

Windows uses directory junctions, which need neither admin rights nor Developer
Mode. On a network-backed profile (FSLogix, roaming) junctions fail and the skills
are copied instead — setup says which one you got, and copies need
`agent-memory setup` re-run after each upgrade.

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

Run `npm test` for the suite (68 tests, no dependencies). CI runs it on Linux,
macOS and Windows across Node 22 and 24, and separately installs the packed tarball
and exercises it end to end on all three.

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

## Use

Two different jobs, and it is worth being clear about which is which.

**Moving a thread between windows.** In window A:

```
/handoff
```

It prints a pickup line. In window B, any repo, paste it:

```
Read C:\Users\you\.agents\handoffs\migrate-orders-to-result-type.md and continue this work. Follow the Next action.
```

**Keeping what stays true.** `/handoff` also writes durable knowledge into the graph
in the same request — same turn, no extra credit. Mid-session, when something worth
keeping is established and you are not switching windows:

```
/remember
/remember the retry policy on the orders webhook
```

And in any repo, later, ask a question that memory should already answer. The agent
invokes `/recall` on its own, because the skill description tells it what is in
there.

## Where things live

```
%USERPROFILE%\.agents\        (Windows; ~/.agents/ on macOS and Linux)
  handoffs/
    index.md            one row per thread, kept small so lookup stays cheap
    <thread-id>.md      current handoff
    <thread-id>.prev.md exactly one prior version
  memory/
    notes/<type>/<id>.md  the source of truth, plain markdown
    notes/archive/        superseded, merged and decayed notes; never deleted
    index.db              disposable SQLite cache, rebuildable at any time
    ROUTING.md            generated map of everything known
    config.json           every cap in the design, tunable
```

Re-running `/handoff` on the same thread updates it in place and keeps one `.prev`
backup. Threads are matched by judgment, not by string-comparing titles, so a title
that drifts as the work progresses does not create a duplicate.

## Design constraints it holds to

- **Memory work costs no extra requests.** A premium request is charged per prompt,
  not per tool call, so capture rides inside a turn you already paid for. Only
  `/remember` costs a request, and only because you chose to spend it.
- **Zero infrastructure.** Files and Node core. No daemon, no server, no scheduled
  task, no network call, nothing for an IT policy to approve.
- **Secrets never hit disk.** Tokens, keys, and connection strings become
  `<redacted:kind>` before any byte is written — not to a note, not to a temp file,
  not to the index. There is no bypass flag.
- **Nothing is deleted.** Superseded, merged and decayed notes move to `archive/`
  and stay reachable with `--include-archived`.
- **Reversible.** `npm uninstall -g agent-memory` removes the links and leaves every
  note in place, readable with nothing installed.

## Status

Capture is **explicit**. You invoke it, or `/handoff` does; nothing fires on its own.

Not built yet, by choice:

- Automatic or ambient capture
- Team sharing, multi-machine sync
- An MCP server. It would read this same store, so it is an addition, not a rewrite.

What is deliberately unproven, and where you will find out: the cold-read test — a
fresh chat in a repo untouched for a month, answering correctly from the digest
alone. That needs real elapsed time and cannot be faked in a test suite.

## Uninstall

Order matters, and npm will not do it for you:

```bash
agent-memory uninstall      # first — removes the six skill links
npm uninstall -g @vib795/agent-memory
```

npm 7 dropped support for uninstall lifecycle hooks, so `npm uninstall -g` on its
own deletes the package and leaves six symlinks pointing at nothing — which both
agents will still try to load. Running it in the other order is unrecoverable by
tooling, because the binary that would clean up has already been removed.

If that already happened, reinstalling repairs it — `postinstall` re-creates every
link. If you are not reinstalling, delete `~/.agents/skills/{handoff,recall,remember}`
and the `.claude` equivalents by hand.

`agent-memory doctor` reports broken links by path under `no broken skill links`.
That catches the case reinstalling does not: links pointing at a global prefix that
moved, which is what an `nvm` version switch does to a globally installed package.

`uninstall` only removes links that resolve back to this package — a skill you put
there yourself is left alone. Your notes stay at `~/.agents/memory`: they are plain
markdown, they outlive the tool that indexed them, and removing them is your call.

## Specs

- [issue #1](https://github.com/vib795/agent-memory/issues/1) — `/handoff`
- [issue #4](https://github.com/vib795/agent-memory/issues/4) — the memory
  graph, with a comment listing every place the shipped code diverged from the spec
