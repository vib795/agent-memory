# agent-memory

**Durable memory for Claude Code and GitHub Copilot — that survives an IT security review.**

Your agent forgets everything between windows. Most tools that fix that cannot be
installed where you actually work.

This one has **zero runtime dependencies, zero dev dependencies, and no install
script**. Nothing runs when you install it; granting it your agents is a second,
separate command. It has been [independently scanned](#independently-scanned) and
passed. `npm ls -g --depth 0` shows nothing underneath it, because there is nothing
underneath it.

## Install

Two commands, and the second one is not optional — it creates the store and installs
into every agent on the machine, in whatever format that tool reads:

```bash
npm install -g @vib795/agent-memory
agent-memory setup
```

Node >= 22.5, and nothing else.

In Claude Code you can take the three skills as a plugin instead of letting `setup`
link them:

```
/plugin marketplace add vib795/agent-memory
/plugin install agent-memory@vib795
```

The plugin carries the skills; `npm` carries the store. You want both — the skills
will tell you so if you only have one.

Behind a proxy that quarantines npm, or want the GitHub Packages mirror?
[Every install path is here](#install-1).

## What you get

Three user-level Agent Skills over one local markdown store:

| Skill | What it does |
|---|---|
| `/handoff` | Writes a portable working-state file so another window can pick up this thread |
| `/remember` | Captures durable knowledge into a cross-repo graph — and fires on its own when a juncture passes |
| `/recall` | Answers from that graph before deriving anything again |

The store is plain markdown in `~/.agents/memory/`, outside every repository — which
is what lets a note written in one project be read from another. Nothing leaves the
machine: no daemon, no scheduled task, no telemetry.

**New here?** [HOWTO.md](HOWTO.md) — install, first five minutes, and the per-tool
notes for Claude Code, Codex and Copilot.

**How does it work?** [ARCHITECTURE.md](ARCHITECTURE.md) — the source-of-truth split,
the write and read paths, the tiered context cost, and the invariants underneath.

[![npm](https://img.shields.io/npm/v/@vib795/agent-memory)](https://www.npmjs.com/package/@vib795/agent-memory)
[![test](https://github.com/vib795/agent-memory/actions/workflows/test.yml/badge.svg)](https://github.com/vib795/agent-memory/actions/workflows/test.yml)
[![release](https://github.com/vib795/agent-memory/actions/workflows/release.yml/badge.svg)](https://github.com/vib795/agent-memory/actions/workflows/release.yml)
[![provenance](https://img.shields.io/badge/provenance-attested-brightgreen)](https://www.npmjs.com/package/@vib795/agent-memory)
[![node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

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
- **An empty graph says so.** Staleness cannot tell you a repo has nothing in it —
  a repo nobody captured in has no stale notes either, so it reads as fully covered.
  `tree` and `doctor` print `47 commits since anything was captured here` instead.
  Silence has to mean covered, never empty.
- **Capture does not wait to be asked.** The agent invokes `/remember` itself when a
  decision settles, a constraint surfaces or a root cause is found, and says so in one
  line. Judged by the model in the turn where the context still exists — never on a
  timer or a tool count, because volume is what makes a graph useless.
- **Redaction is fail-closed.** Keys, tokens, connection strings, private keys,
  session cookies, internal hosts and foreign email addresses are replaced before any
  byte reaches disk — not to a note, not to a temp file, not to the index.
- **Truncation is never silent.** Whenever the tree or the retrieval budget drops
  something, the omitted ids are printed. Silent truncation reads as full coverage.
- **Constraints are never dropped.** At any cap, in either tier. A constraint is what
  stops an agent burning a retry loop on an approach that was never going to ship.

## Carrying knowledge between machines

Client work usually lives in its own environment, and when the engagement ends the
environment goes with it. What should survive is the part that was never the
client's — the constraints your org imposes, the conventions you follow, what you
have learned about working under them. What must not survive is their architecture.

```bash
agent-memory export --out carry.json     # global scope only, by default
agent-memory import carry.json --dry-run # see what would land
agent-memory import carry.json
```

**The default is the safe one.** `export` emits `scope: global` notes and nothing
else, so a note tied to a client repository cannot leave by forgetting a flag.
Taking one is possible — `--scope all` — but it takes saying so.

Two things are deliberately dropped on the way through:

- **`captured_sha` is not carried.** It names a commit that exists in one repository
  on one machine. Carried across, it would either read as current forever or claim
  the history was rewritten; a staleness signal you cannot check is worse than none.
- **`source` becomes `import`.** How a note was originally captured describes an
  environment that no longer exists. Here the honest answer to where it came from is
  that someone brought it in, and an audit should be able to tell which notes those
  are.

Importing the same file twice updates rather than duplicates, so re-running after a
change is safe.

### Sharing an export with another person

Scope decides *whose* knowledge travels. It does not decide whether the file can be
handed to a person, and those are separate questions. Every export is scanned for
personal identifiers on the way out, and the file carries a receipt naming the rule
set that ran and what it took.

```
$ agent-memory export --out carry.json
Exported 41 global-scope notes to carry.json.
rule set: pii/v1
redacted: 6 phone, 2 payment-card, 1 ssn
withheld: 1 note
  oncall-roster — 8 identifiers (phone)

Structured identifiers only. Have an agent review this file for names and
identifying prose before sharing it outside your team.
```

Notes are **redacted in place**, so the knowledge survives and the identifier does
not. A note that is *mostly* identifiers — a roster, a contact sheet — is withheld
whole and named in the receipt, because a redacted skeleton is useless to the reader
and still re-identifiable from the structure that remains.

**Two layers, and the markers tell you which one acted.**

| | Runs at | Asks | Marker |
|---|---|---|---|
| `src/redact.js` | capture | could this authenticate as someone? | `<redacted:kind>` |
| `src/pii.js` | export | could this identify a person? | `[redacted:kind]` |

They disagree about your own email address on purpose. Capture keeps it, because it
is already public in every commit you have ever pushed. Export removes it, because it
is not yours to hand to someone else alongside a hundred notes about how a client
works.

**What the deterministic layer does not catch.** Names, job titles, postal addresses
and identifying prose have no shape to match on. They are language, and the honest
place to judge them is the model already in the conversation — so the receipt says so
instead of letting a pattern imply a completeness it does not have. Ask your agent to
review the export before it leaves your team.

## Evals and governance

Disclosure control is a claim until it is measured, so it is measured on every run of
`npm test`:

```
[pii/v1] recall by kind
  email          2/2
  ip-address     2/2
  payment-card   3/3
  phone          4/4
  ssn            2/2
[pii/v1] precision 15/15 on the negative corpus
[pii/v1] 3 known gaps pass through by design: person name, postal address, bare internal identifier
```

The practices behind that number, which are the transferable part:

- **Both error directions are costed, not just the obvious one.** A miss discloses one
  identifier. A false hit shreds a sentence, and a tool that mangles ordinary prose
  gets switched off, which discloses everything. Recall is held at 1.0 because no
  number of leaked identifiers is acceptable; precision is held at 1.0 against a
  corpus built to tempt each detector with what it most resembles — a git SHA for a
  card, a four-part version for an address, a date for a phone number.
- **Gaps are asserted as gaps.** `test/pii.eval.test.js` proves that names and
  addresses pass through, so closing one has to be a deliberate act rather than a
  silent change in what an old receipt meant.
- **The eval is checked for teeth.** Removing the Luhn validation drops precision to
  14/15 and fails the build. A green suite that cannot go red is decoration.
- **Corpora are synthetic.** Reserved ranges only — RFC 5737 addresses, the card
  networks' published test numbers — so the file that tests for leaks is not one.
- **Rule sets are versioned.** A receipt means something only against the rules that
  produced it, so `pii/v1` is stamped into every export and changing a detector
  changes the name.

For sharing outside your team: keep the receipt with the file, re-export rather than
hand-editing a file you already sent, and treat `--scope all` as a decision with your
name on it. What this is not: it is not encryption, access control, or a DLP product.
It is one command that refuses to hand over identifiers, and it says exactly what it
checked.

### Independently scanned

Public supply-chain scanners index every package published to npm, so this one is
reviewed by people who owe it nothing. That is worth more than a clean claim from its
author.

[LPM Firewall](https://firewall.lpm.dev/npm/@vib795/agent-memory) currently reports
**Passed — safe to install**, with no policy match and no flagged code. Its reading of
the artefact — signed, provenance attached, zero dependencies, no install hooks — is a
third-party check on what this README says about itself. Four low-signal patterns
remain, and they are descriptive rather than policy: environment variables, scripts
present, filesystem, high-entropy strings. That is what a CLI which reads
`AGENT_MEMORY_HOME` and writes files in your home directory looks like from outside.

**It did not start there.** Version 0.3.1 was flagged **Critical — AI Agent Control
Hijack**, because `postinstall` wrote skill files into `~/.claude`, `~/.codex` and your
editor's prompt folder. The finding was correct. An install script that grants an AI
agent new instructions without the user asking is indistinguishable from an attack
that does exactly that, and good intent is not observable to a scanner. The hook was
removed in 0.4.0 rather than argued with, which is why `agent-memory setup` is a
command you type.

The 0.3.1 report is still public and still says Critical. Old version pages do not
come down, and they should not: a supply-chain record that could be edited after the
fact would be worth nothing. What a project can offer is the next version and the
reason for it.

## Engagements

If you work for more than one client on one machine, knowledge from one of them is
not the next one's to see. An engagement is a **separate store**, and switching is a
path change rather than a filter:

```bash
agent-memory engagement                    # which one is active, and why
agent-memory engagement list               # all of them, with note counts
agent-memory engagement use acme           # the fallback for every window
agent-memory engagement purge acme --yes   # delete that client's store entirely
```

Pin a client's whole tree instead of remembering to switch. One file at the top of
it, and every repository beneath is in that engagement:

```bash
echo acme > ~/clients/acme/.agent-memory-engagement
```

Resolution order is `AGENT_MEMORY_ENGAGEMENT`, then the nearest marker file walking
up from where you are, then the machine-wide pointer, then `default`. `doctor` and
`engagement` both print which one decided it, because the failure worth preventing is
believing you are in one client's store while writing to another.

**The isolation is structural, not a filter.** Each engagement is its own directory,
its own markdown and its own index, so `search`, `get` and `tree` cannot reach across
even by exact id — there is no query to forget. Filtering would have to be remembered
at fourteen separate read paths, and two of them were already missed before this
existed.

That also makes removal something you can evidence rather than assert: `purge` deletes
a directory and reports the count, and refuses without `--yes` after telling you
exactly what would go.

Everything already captured stays in `default`, at the same path as before. Nothing
migrates and nothing changes until you create a second engagement.

**Two things sit outside the boundary, deliberately.** Skill installation is shared,
because every engagement reads the same three skill files and registering them per
engagement would leave the description stale after a switch. Handoff files are shared
too — they live in `~/.agents/handoffs`, not in a store — so `purge` does not remove
them and says so every time rather than letting "the store is gone" be mistaken for
"their context is gone".

Most people need none of this. If each client already gives you a separate machine,
that boundary is stronger than anything here, and the default engagement is all you
will ever touch.

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
cd agent-memory && npm pack
npm install -g ./vib795-agent-memory-*.tgz
agent-memory setup
```

**Pack first; do not install the directory.** `npm install -g ./agent-memory` looks
equivalent and is not: npm links the global install to that folder rather than copying
it, which shows up as an arrow in `npm list -g`:

```
`-- @vib795/agent-memory@0.6.5 -> .\..\..\..\agent-memory
```

Move or delete the clone afterwards and the global install points at nothing — the same
breakage as the git-URL case below, arriving later and harder to trace. Installing a
packed tarball copies, so the clone becomes disposable. Verified on npm 11.x.

**Do not install from the git URL directly either.** `npm install -g <git-url>` does not
work for this package: npm resolves a git install through
`~/.npm/_cacache/tmp/git-clone*` and then removes that directory, leaving the global
install pointing at a path that no longer exists. Verified on npm 11.18.

**And run the installed binary, not the checkout.** Skill links resolve relative to the
code that creates them, so `npm run setup` inside a clone aims every link at that clone.
Use `agent-memory setup`, which runs the copy npm installed.

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

**Why it is not automatic.** Installing the package writes nothing to your machine.
There is no `postinstall` hook, and its absence is a security decision rather than an
omission: an install script that writes into *other* tools' agent directories —
`~/.claude`, `~/.codex`, your editor's prompt folder — is mechanically
indistinguishable from a supply-chain attack that hijacks an AI agent, and
supply-chain scanners classify it as exactly that. Installing this package and
granting it your agents are two separate decisions, so they are two commands.
`agent-memory setup` is the one that asks.

`agent-memory doctor` tells you where you stand. It checks the files
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
/plugin install agent-memory@vib795
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

Needs Node 22.5 or newer; `doctor` says so plainly if the version is too old.

Run `npm test` for the suite (91 tests, no dependencies). CI runs it on Linux,
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
nothing else.

You will also see it fire without being asked, when a decision settles, a constraint
surfaces, a root cause is found or a convention is agreed. It reports one line at the
end of whatever it was already answering and carries on:

```
captured 2 notes [decision, constraint]
```

That costs nothing — a request is charged per prompt, not per tool call, so capture
inside a turn you already paid for is free. Only typing `/remember` yourself spends
one.

Either way it makes one terminal call, and `write` reports each id:

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

The inverse is reported too. Staleness answers *is this note still true*; it cannot
answer *is there anything here yet*, and those fail in opposite directions — a repo
nobody has ever captured in has no stale notes either, so it reads exactly like one
that is fully covered. `tree` and `doctor` both say so:

```
47 commits since anything was captured for orders-api — /remember is behind
```

Measured to the *nearest* capture, so one fresh note closes the gap however old the
rest of the graph is, and silent below `captureGapCommits` (50) so a young repo is
never nagged. Silence has to mean covered, never empty.

Not built yet, by choice:

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
