# agent-memory

[![npm](https://img.shields.io/npm/v/@vib795/agent-memory)](https://www.npmjs.com/package/@vib795/agent-memory)
[![test](https://github.com/vib795/agent-memory/actions/workflows/test.yml/badge.svg)](https://github.com/vib795/agent-memory/actions/workflows/test.yml)
[![release](https://github.com/vib795/agent-memory/actions/workflows/release.yml/badge.svg)](https://github.com/vib795/agent-memory/actions/workflows/release.yml)
[![provenance](https://img.shields.io/badge/provenance-attested-brightgreen)](https://www.npmjs.com/package/@vib795/agent-memory)
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

**New here? Read the [HOW-TO](HOWTO.md)** — install, first five minutes, and the
per-tool notes for Claude Code, Codex and Copilot, written for people who do not
want to read the rest of this file.

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
                     --from-json -         read the JSON from stdin instead
agent-memory compact                       dedup, decay, reindex, regenerate
agent-memory doctor                        preflight and health report
```

Every command takes `--json`. Every cap lives in `config.json` and is tunable.

### Where they run

**Anywhere. There is one store per machine, not one per repository.** Everything
lives under `~/.agents/memory`, nothing is written into the projects you point it
at, and there is no per-repo setup step. `cd` between projects freely: the store
does not move, split, or reset.

One exception, and it is this repository rather than yours: if you installed from a
clone, `npm install -g .` symlinks rather than copies, so `compact` regenerating the
skill descriptions lands in your working tree and `skills/recall/SKILL.md` shows as
modified. That is generated state, and [From a clone](#from-a-clone) says so. No
project repository is ever written to.

What the working directory changes is *scope*, never location.

| Command | Reads | What the current repo changes |
|---|---|---|
| `init` | whole store | nothing |
| `index` | whole store | nothing |
| `compact` | whole store | nothing |
| `doctor` | whole store | nothing |
| `search` | whole store | nothing — full text hits every note in every repo |
| `get` | whole store | the staleness line only; the note is found by id either way |
| `tree` | whole store | **filters it** — defaults to the current repo |
| `write` | whole store | **is stamped into the note** — see below |

The current repo is `git rev-parse --show-toplevel` reduced to its directory name.
Outside a git repository it is `null` and every command still works: `tree` comes
back unscoped, and a new note carries no repo and no capture SHA, so it gets no
staleness signal for the rest of its life.

`write` is the one worth understanding, because it is the one that fixes facts in
place. Run from `~/work/orders-api` it stamps `repos: [orders-api]`, records that
repo's HEAD as `captured_sha`, and adds your `git config user.email` to the
redactor's keep list so your own address survives while every other one is removed.
Run the same JSON from your home directory and you get a note with no repo and no
staleness anchor. **Capture from inside the repository the knowledge is about** —
that is the whole reason `/remember` is worth invoking where you are working.

Two flags that do not mean what they look like:

- `agent-memory tree --repo`, with no value, means *all repos*. A bare `--repo`
  clears the default scope rather than confirming it; `--repo <name>` points it at
  a different repo.
- `--all` is unrelated to scope. It prints every node instead of truncating to the
  `treeLines` cap, which is what the `run agent-memory tree --all` hint at the
  bottom of a truncated tree is telling you.

One sharp edge: repo identity is the **directory name**, not the remote URL. Two
clones both sitting in a directory called `utils` are one repo as far as the store
is concerned. If you work across orgs, clone into distinct directory names.

### How often they run

Only `init` is a once-per-machine command, and `agent-memory setup` already ran it.

| Command | When |
|---|---|
| `init` | once, via `setup`. Again only to register extra skill paths |
| `write` | every capture |
| `tree`, `get`, `search` | every lookup |
| `index` | repair only — `write` reindexes on every call. Run it after hand-editing or deleting notes, or after deleting `index.db` |
| `compact` | occasionally. Nothing schedules it: no daemon, no cron, no hook |
| `doctor` | after install, after an upgrade, and whenever something looks wrong |

**You will not type most of these.** `/remember` and `/handoff` call `write`;
`/recall` calls `tree`, `get` and `search`. They are documented so you can see what
the skills are doing and drive it by hand when you want to, but the daily loop is
two slash commands in a chat box. The ones a person actually types are `setup`,
`doctor`, and `compact` now and then.

## Install

Two commands, and the second one is not optional:

```bash
npm install -g @vib795/agent-memory
agent-memory setup
```

No registry access? Clone it and install the directory. This needs nothing but
GitHub, and it is the path to use behind a proxy that blocks or quarantines npm:

```bash
git clone https://github.com/vib795/agent-memory.git
npm install -g ./agent-memory
agent-memory setup
```

**Do not install from the git URL directly.** `npm install -g <git-url>` fails for
this package: npm links the package into `~/.npm/_cacache/tmp/git-clone*`, a
directory it then cleans, and `postinstall` dies with `Cannot find module` before it
can run. Cloning first avoids npm's git handling entirely. Verified on npm 11.18.

Every release is mirrored to **GitHub Packages**. Treat that as redundancy rather
than a second front door: GitHub Packages requires authentication even for public
packages, so installing from it costs you a token that npmjs does not ask for.

```bash
npm config set @vib795:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken <a PAT with read:packages>
npm install -g @vib795/agent-memory
agent-memory setup
```

Prefer npmjs unless you have a specific reason not to. Releases there are published
by CI from a tag and carry a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements),
so `npm audit signatures` will tell you the tarball you installed was built from the
commit it claims. Neither the git nor the GitHub Packages path gives you that.

`setup` probes for every agent on the machine and installs into each one it finds,
in whatever format that tool reads. It then creates the store and generates the
routing digest.

| Detected | Installed as | Where |
|---|---|---|
| Agent skills (shared convention) | linked skill directory | `~/.agents/skills/<name>/` |
| Claude Code, CLI and VS Code extension | linked skill directory | `~/.claude/skills/<name>/` |
| Codex CLI | linked skill directory | `$CODEX_HOME/skills/<name>/` |
| VS Code, Insiders, VSCodium, Cursor, Windsurf | prompt file | `<user data>/prompts/<name>.prompt.md` |
| GitHub Copilot CLI | linked skill directory | `~/.copilot/skills/<name>/` |

GitHub documents two personal skill directories, `~/.copilot/skills` and
`~/.agents/skills`, and Copilot reads both. The shared one is always written, so
Copilot is served even on a machine that has never run the CLI.

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

Either way `agent-memory doctor` tells you where you stand. It checks the files
rather than the tools, and names any agent it found that has no skills in it:

```
FAIL skills installed: GitHub Copilot CLI: handoff, recall, remember — run `agent-memory setup`
```

Detecting an agent is not the same as having installed into it, and a check that
conflated the two would report healthy on exactly the machine where nothing ran.

### The skills on their own

The three skills are also published as [agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills),
so they can be installed without the package:

```bash
gh skill install vib795/agent-memory --scope user
```

That gives you `/handoff`, `/remember` and `/recall` in every agent that reads the
shared skill directories, and nothing else — no CLI, so no store. The skills say so
when you run them and name the one command that fixes it. Use this to try the
prompts; use npm when you want the memory.

Claude Code can take the same three as a plugin:

```
/plugin marketplace add vib795/agent-memory
/plugin install agent-memory@agent-memory
```

The same caveat applies: the plugin carries the skills, `npm` carries the store.

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

Run `npm test` for the suite (74 tests, no dependencies). CI runs it on Linux,
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

Three commands, two different jobs. You type the slash command in your agent; the
agent runs the CLI. The terminal equivalents are shown so you can see what it did,
and drive it by hand when you want to.

### `/remember` — keep what stays true

Mid-session, when something worth keeping has been established:

```
/remember
/remember the retry policy on the orders webhook
```

Bare, it selects the durable knowledge itself. With an argument, it writes that and
nothing else. Either way it makes one terminal call, and `write` reports each id:

```
created auth-service [system]
created use-sessions [decision]
warning: use-sessions: redacted 1x github-token
```

That warning is the redactor firing before anything reached disk. The skill then
repeats the list back to you with titles attached, so you can see what was captured
without opening the files.

What it ran, which you can run yourself:

```bash
agent-memory write --from-json - --source remember <<'JSON'
{"nodes":[
  {"id":"use-sessions","type":"decision",
   "title":"Chose server sessions over JWT",
   "body":"Why: revocation had to take effect immediately.\nRejected: short-TTL JWT, because logout would lag by the TTL.\nImplemented in src/auth/session.js:42.",
   "edges":[{"rel":"evidence-for","dst":"auth-service"}]}
]}
JSON
```

### `/recall` — answer from memory before deriving again

You rarely type this one. Ask a question memory should already answer and the agent
invokes it on its own, because the skill description advertises what is in the store:

```
Why do we use sessions instead of JWT here?
/recall the auth decision
```

It reads the routing map first, then pulls only the notes it needs:

```bash
agent-memory tree                      # what exists, scoped to this repo
agent-memory get use-sessions --depth 1   # that note plus its neighbourhood
agent-memory search "session revocation"  # full text, when the tree misses
```

A note that is still current prints clean, with its edges:

```
## use-sessions  [decision]  depth 0
Chose server sessions over JWT

Why: revocation had to take effect immediately.

  -> evidence-for auth-service
```

Once the code has moved on underneath it, the same note arrives carrying the warning.
This is the part that keeps the store honest:

```
## use-sessions  [decision]  depth 0  [captured 47 commits ago — verify before trusting]
```

### `/handoff` — move a thread to another window

In window A:

```
/handoff
```

It writes the working-state file and prints a pickup line. In window B, any repo,
paste it:

```
Read ~/.agents/handoffs/migrate-orders-to-result-type.md and continue this work. Follow the Next action.
```

`/handoff` also writes durable knowledge into the graph in the same request — same
turn, no extra request charged. To see what it produced:

```bash
ls ~/.agents/handoffs/           # index.md, <thread>.md, one <thread>.prev.md
agent-memory tree                # the nodes it captured on the way past
```

### Housekeeping

```bash
agent-memory doctor              # after install, after an upgrade, when something looks off
agent-memory compact             # dedup, decay, regenerate the routing digest
agent-memory tree --repo         # every repo, not just this one
```

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

Capture is **judged, not scheduled.** You invoke it, `/handoff` does, or the agent
does on its own when a juncture has just passed — a decision settled, a constraint
found, a root cause identified, a convention agreed. It says so in one line and
carries on with what you actually asked:

```
captured 2 notes [decision, constraint]
```

Nothing fires on a timer, on a tool count, or on every reply. That distinction is the
whole design: a store full of task chatter is worse than an empty one, because it
buries the four notes that mattered. The judgment of what is durable belongs to the
model, in the turn where the context still exists; there is no keyword list deciding
it. And because a request is charged per prompt rather than per tool call, capture
that rides inside a turn you already paid for is free — which is why it can afford to
happen at the moment the knowledge is fresh instead of whenever someone remembers.

Not built yet, by choice:

- A capture-gap signal — the store knows when a note has gone stale, but not yet when
  a repo has moved a hundred commits with nothing captured at all
- Team sharing, multi-machine sync
- An MCP server. It would read this same store, so it is an addition, not a rewrite.

What is deliberately unproven, and where you will find out: the cold-read test — a
fresh chat in a repo untouched for a month, answering correctly from the digest
alone. That needs real elapsed time and cannot be faked in a test suite.

## Update

An upgrade is not finished until `setup` has run again. Prompt files are copies
rather than links, so an editor keeps reading the old text until something rewrites
them, and nothing warns you.

**Installed from npm:**

```bash
npm install -g @vib795/agent-memory@latest
agent-memory setup
```

**Installed from a clone** — one command, which pulls and re-runs the installer:

```bash
./update.sh                                            # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\update.ps1  # Windows
```

Both end in `agent-memory doctor`, so you find out immediately if an agent was left
holding stale files. Your notes are never touched by an upgrade.

## Uninstall

Order matters, and npm will not do it for you:

```bash
./uninstall.sh                                            # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1  # Windows
```

Or by hand, which is the same two steps in the same order:

```bash
agent-memory uninstall      # first — removes every skill link and prompt file
npm uninstall -g @vib795/agent-memory
```

npm 7 dropped support for uninstall lifecycle hooks, so `npm uninstall -g` on its
own deletes the package and leaves a symlink per skill per agent pointing at nothing
— which every one of those agents will still try to load. Running it in the other
order is unrecoverable by
tooling, because the binary that would clean up has already been removed.

If that already happened, reinstalling and re-running `agent-memory setup` repairs it:
`setup` clears each stale link before writing the new one. Reinstalling alone is not
enough unless you passed `--allow-scripts`, since that is the same hook npm declines to
run. If you are not reinstalling, delete `~/.agents/skills/{handoff,recall,remember}`
and the equivalents under the other agent directories by hand.

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
