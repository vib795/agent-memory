---
name: handoff
version: 0.1.0
description: Capture the working state of the current conversation into a portable handoff file, so an agent in a new chat, a different VS Code window, or a different repository can continue the work without the user re-explaining it. Use when the user says handoff, hand this off, save context, wrap this up, or continue this elsewhere.
license: MIT
allowed-tools: Bash Read Write Glob
triggers:
  - handoff
  - hand this off
  - save context for another window
  - continue this in another repo
  - pick this up in a new chat
---

# handoff

Write one file that lets a different agent, in a different window, on a different
repo, pick up this thread cold.

You are not summarizing the conversation. You are reconstructing **working state**.
A transcript summary is a failure mode: it reads fine and still leaves the next
agent asking the questions the user is trying to avoid answering twice.

Do the whole job in **one pass**. Gather facts in a single terminal call, then
write. Do not loop, do not re-read source files, do not interrogate the user.
Every extra request costs the user credits, which is the reason this skill exists.

---

## Scope

Bare `/handoff`: you decide what the working state is.

`/handoff <focus>` — "just the auth work", "the migration, skip the CI detour" — names
which thread of a braided conversation to carry forward. Treat it as a filter on Step 2
and Step 3, not as a title. Work outside that focus stays out of Orientation, Decisions
and Current task state even when it was the more recent work: a long conversation
usually holds more than one thread, and carrying both is how a handoff becomes the
transcript summary this skill exists to avoid.

If the focus names a thread you cannot find in the conversation, say so in one line and
hand off what you did find. Do not invent a thread to match the words.

---

## Step 0 — Resolve the store path

| Platform | Store |
|---|---|
| Windows | `$env:USERPROFILE\.agents\handoffs` |
| macOS / Linux | `$HOME/.agents/handoffs` |

The store lives outside every repository on purpose. That is what makes a handoff
readable from a window opened on a different project.

---

## Step 1 — Gather deterministic facts (ONE terminal call)

Run one command that creates the store, reads the index, and collects git state.
Everything the deterministic layer contributes comes from this single call.

**PowerShell (Windows / AVD):**

```powershell
$store = Join-Path $env:USERPROFILE '.agents\handoffs'
New-Item -ItemType Directory -Force -Path $store | Out-Null
Write-Output "STORE=$store"
Write-Output "--- INDEX ---"
if (Test-Path (Join-Path $store 'index.md')) { Get-Content (Join-Path $store 'index.md') } else { Write-Output "(no index yet)" }
Write-Output "--- GIT ---"
Write-Output "ROOT=$(git rev-parse --show-toplevel 2>$null)"
Write-Output "BRANCH=$(git branch --show-current 2>$null)"
Write-Output "HEAD=$(git rev-parse --short HEAD 2>$null)"
Write-Output "--- BRANCHES ---"
git branch --sort=-committerdate --format='%(refname:short)' 2>$null | Select-Object -First 10
Write-Output "--- LOG ---"
git log --oneline -8 2>$null
Write-Output "--- STATUS ---"
git status --porcelain 2>$null
Write-Output "--- ORIGIN ---"
Write-Output "HOST=$env:COMPUTERNAME"
$sid = $env:CLAUDE_CODE_SESSION_ID
if (-not $sid) { $sid = $env:COPILOT_SESSION_ID }
if (-not $sid) { $sid = 'unknown' }
Write-Output "SESSION=$sid"
Write-Output "CWD=$($PWD.Path)"
Write-Output "UTC=$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
```

**bash (macOS / Linux):**

```bash
store="$HOME/.agents/handoffs"; mkdir -p "$store"
echo "STORE=$store"
echo "--- INDEX ---"; [ -f "$store/index.md" ] && cat "$store/index.md" || echo "(no index yet)"
echo "--- GIT ---"
echo "ROOT=$(git rev-parse --show-toplevel 2>/dev/null)"
echo "BRANCH=$(git branch --show-current 2>/dev/null)"
echo "HEAD=$(git rev-parse --short HEAD 2>/dev/null)"
echo "--- BRANCHES ---"; git branch --sort=-committerdate --format='%(refname:short)' 2>/dev/null | head -10
echo "--- LOG ---"; git log --oneline -8 2>/dev/null
echo "--- STATUS ---"; git status --porcelain 2>/dev/null
echo "--- ORIGIN ---"
echo "HOST=$(hostname -s 2>/dev/null)"
echo "SESSION=${CLAUDE_CODE_SESSION_ID:-${COPILOT_SESSION_ID:-unknown}}"
echo "CWD=$PWD"
echo "UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

If the directory is not a git repository, `ROOT`/`BRANCH`/`HEAD` come back empty.
That is not an error. Record the working directory path and omit the git fields.

`BRANCHES` is there because the current branch is rarely the whole story. Work that
stages a change across two branches — one holding the old configuration for a first
run, another carrying the new one — leaves the second branch invisible to
`--show-current`, and a branch you were never shown is a branch you cannot record.
Read the list before writing Execution protocol.

`ORIGIN` is what lets a later reader work out *which* of three jobs it has. A repo path
alone cannot: the same repository is open in the window that wrote this file, in the next
chat the user starts on it tomorrow, and in the window they paste the replicate line into
by mistake. `SESSION` separates the first two. `SESSION=unknown` is a normal result — not
every agent exposes one — and costs only the Resuming row of the table in Step 3; Host and
cwd still separate machines and trees.

---

## Step 2 — Identify the thread

Read the `--- INDEX ---` output and decide, **by judgment**, whether this
conversation continues an existing thread or starts a new one. Do not string-match
titles; a title drifts as work progresses and the thread is still the same thread.

- Same goal as an existing row, even under a different name → reuse that `id`.
- Same repo but a genuinely different goal → new `id`.
- Nothing close → new `id`.

New ids are kebab-case, 3 to 6 words, naming the **goal**, not the topic:
`migrate-orders-to-result-type`, not `orders-work`.

State your choice in the final output: "Updating thread `<id>`" or
"Creating thread `<id>`". If you guessed wrong the user corrects it in one line,
which is cheaper than asking.

---

## Step 3 — Compose the handoff

Use this exact structure.

```markdown
---
id: <kebab-slug>
title: <one line, states the goal not the topic>
status: active | blocked | done
created: <ISO 8601 UTC>
updated: <ISO 8601 UTC>
repos:
  - name: <repo name>
    path: <absolute path>
    branch: <branch>
    head: <short sha>
surfaces:
  - kind: <confluence | sharepoint | local-file | dashboard | ticket>
    ref: <page id, path or URL — never a credential>
origin:
  agent: copilot | claude-code
  session: <SESSION from Step 1, or `unknown`>
  host: <HOST>
  cwd: <CWD>
---

> **Work out which of these you are before you touch anything.** Read your own identity
> first: `pwd` works on both shells, and for the session id use
> `echo "${CLAUDE_CODE_SESSION_ID:-${COPILOT_SESSION_ID:-unknown}}"` on bash or
> `$env:CLAUDE_CODE_SESSION_ID` on PowerShell. Then take the **first** row below that matches. The rows are ordered and they overlap
> on purpose: the row that stops you is checked before the rows that let you work.

| What you observe | You are | What this file is to you |
|---|---|---|
| you were told to replicate, but your repo IS under `repos:` | **Conflict — stop** | Checked first, because it also matches Continuing below and the wrong one is silent. Say so in one line and ask which repository was meant. Do not pick a reading: continuing redoes finished work, replicating duplicates it into the tree it already lives in. One question is cheaper than either. |
| your session id equals `origin.session` | **Resuming** | The same chat, after a restart or a compaction. Next action is yours; do not re-derive what is already recorded here. |
| session differs, and your repo IS under `repos:` | **Continuing** | A different chat — a new session in the same window counts — on the same tree. Next action applies, but read `git status` and `git log` first: `updated:` records when this was true, not that it still is. |
| your repo is NOT under `repos:` | **Replicating** | Next action is wrong by construction — it names branches, paths and versions belonging to another tree. Follow Execution protocol, re-derive every specific from the repository you are actually in, and read Next action as a record of what happened elsewhere. Do not open the repository this was written in. |

`origin.session` of `unknown` collapses Resuming into Continuing: you cannot tell the two
apart, so take the safer one and re-check git state. Nothing else in the table changes.

`status: done` overrides all four rows. There is no next action, only an outcome.
Report what the file records and ask what is wanted before changing anything.

A `surfaces:` entry with no counterpart in your repository is not replicable. Name it
and leave it alone. Inventing a repo-side equivalent for a Confluence page or a file on
someone's desktop is how a handoff turns into invented work.

## Orientation

3 to 5 sentences. What this thread is trying to accomplish and where it stands.
Written for a reader with zero prior context.

## Decisions

| # | Decision | Why | Alternatives rejected |
|---|----------|-----|----------------------|

## Constraints

Things not discoverable by reading the code: environment restrictions,
unavailable tooling, plan limits, deadlines, taste calls already settled.

## Execution protocol

The sequence this work is run in, when the sequence is not obvious from the code.
Branch choreography, pipeline order, which environment goes first, what has to be
staged before what, what must be true before a step is safe to repeat.

Write the shape of the operation, not this run's position in it. "Run the pipeline
from a branch holding the old configuration, then from the working branch with the
new one" belongs here. "Dev is done, UAT is next" does not — that is Current task
state. Mandatory. `None.` when the work genuinely has no ordering.

## Rejected approaches

What was tried and why it failed. Mandatory. This is the section that stops the
next agent re-deriving known dead ends on the user's credits.

## Current task state

**Next action:** <one imperative sentence>
**Blocked on:** <specific blocker, or "nothing">

### Uncommitted work

| File | State | What changed |
|------|-------|--------------|

### Anchors

| Path | Why it matters |
|------|----------------|

## Open questions

Numbered. Only questions the user can answer.
```

`State` in Uncommitted work comes from `git status --porcelain`: `modified`,
`added`, `deleted`, `untracked`, `renamed`.

`surfaces:` is `[]` when every part of the work lived inside a repository, and that is
the common case. Fill it only for work with no file in any tree — a wiki page, a ticket,
a dashboard, a file on the desktop. It exists because `repos:` quietly claims to describe
the whole work surface, and a reader asked to replicate what is not in a repository will
invent something rather than say it cannot.

`origin.session` is whatever Step 1 printed, verbatim. Write `unknown` when Step 1 said
so, and never substitute a different id: a session id that is wrong is worse than absent,
because the Resuming row of the table above tells a reader to trust Next action without
re-checking it.

### Quality rules

These separate a useful handoff from a readable paragraph that still leaves questions.

1. Write for a reader with zero context. No pronoun without a stated antecedent.
2. Every decision carries its **why**. Rationale is what never survives
   re-explanation and is the whole reason a handoff beats a transcript.
3. Never quote or paraphrase the transcript. Record conclusions, not the path to them.
4. Anchor claims to a file path or a decision number. "We refactored the service
   layer" is a failure. "`src/services/order.ts:42` now returns `Result<T>` instead
   of throwing" is not. When the thread spans more than one repository, name the repo
   alongside the path: an unqualified path in a two-repo thread is a path the reader
   goes looking for in the wrong tree, and finding it there is worse than not finding it.
5. Record only what the conversation actually established. Prefix anything you
   inferred with `inferred:` so the next agent knows to verify it.
6. Never inline a diff or a patch. List changed files with one line each.
7. Soft target 150 lines. On overflow, move detail into `<id>.detail.md` and
   reference it. Never drop Decisions, Execution protocol, or Rejected approaches
   to hit the target.
8. Empty sections say `None.` They are never deleted. A missing section reads as
   an oversight; an explicit `None.` reads as a fact.

---

## Step 4 — Redact before writing

Scan the drafted body and replace any of these with `<redacted:kind>`:

API keys, access tokens, bearer tokens, passwords, connection strings, private
keys, session cookies, internal hostnames or IPs, and personal email addresses
that are not the user's own git identity.

The store is plaintext on a corporate machine. Never write the raw value, not even
once, not even to a temp file.

---

## Step 5 — Write the files

Prefer your file-write tool targeting the absolute store path. If it refuses to
write outside the workspace root, fall back to the terminal.

Order matters:

1. If `<id>.md` exists, move it to `<id>.prev.md`, overwriting any existing `.prev`.
   Exactly one prior version is kept. There is no version history.
2. Write the new body to `<id>.md.tmp`.
3. Rename `<id>.md.tmp` to `<id>.md`.
4. Only if the soft target overflowed, write `<id>.detail.md` the same way.

**PowerShell fallback.** Use a single-quoted here-string so `$` and backticks in
the content are not expanded:

```powershell
$store = Join-Path $env:USERPROFILE '.agents\handoffs'
$id = '<id>'
$cur = Join-Path $store "$id.md"
if (Test-Path $cur) { Move-Item -Force $cur (Join-Path $store "$id.prev.md") }
$body = @'
<the full handoff body>
'@
Set-Content -Path (Join-Path $store "$id.md.tmp") -Value $body -Encoding UTF8
Move-Item -Force (Join-Path $store "$id.md.tmp") $cur
```

---

## Step 6 — Update the index

`index.md` is what makes retrieval cheap later. Keep it to one row per thread.

```markdown
| id | title | status | repos | updated |
|----|-------|--------|-------|---------|
```

Replace the row whose `id` matches. Append only when the id is new. Never let two
rows share an id.

---

## Step 7 — Capture durable knowledge

Skip this step entirely if `agent-memory` is not installed. It is optional
machinery; the handoff above is complete without it.

A handoff carries this thread. The graph carries what stays true after the thread
ends. You already hold the whole conversation, so writing both costs the same single
request, which is the only reason this step belongs here rather than in its own skill.

### What is durable

<!-- extraction-rules:start -->
- A node is durable only if it will still be true next month. Task state is not
  durable and belongs in a handoff file, not in the graph.
- A repeatable **procedure** is durable even though it reads like task state, and it
  is the exception most often missed. "Run the pipeline from a branch holding the old
  configuration, then from the working branch carrying the new one" is a `convention`:
  it will be true the next time anyone does this. The test is whether the sentence
  describes *this run* — not durable — or *how this kind of run is done* — durable.
  Branch choreography, deploy ordering and staging sequences all pass that test and
  are routinely dropped because the previous rule makes them look like status.
- Every `decision` node carries its why and its rejected alternatives, or it is not
  written. Rationale is the thing that never survives re-explanation.
- Anything the conversation did not actually establish is `confidence: inferred`,
  and the body says what would confirm it.
- Prefer updating an existing node over creating a near-duplicate. `write` returns
  the existing id on a content-hash match.
- A decision that replaces a known prior sets `supersedes` to that prior's id.
- Constraints are the highest-value type. An environment restriction, a blocked
  tool, a policy that forbids an approach: write it, because it is what stops a
  future agent burning a retry loop on something that was never going to ship.
- Zero durable knowledge is a valid outcome. Writing nothing beats writing noise.
<!-- extraction-rules:end -->

Your Decisions table, Constraints section and **Execution protocol** are usually already
the durable part. Write the protocol as a `convention`: it is the section a second
repository actually needs, and the one most easily lost, because a sequence of steps
reads like status even when it describes how every run of this kind is done. A handoff
that records the protocol while the graph does not still leaves the next repository
guessing — the handoff is read once, by whoever was handed the path, and the graph is
what `/recall` reaches for afterwards.

The Current task state section never is durable.

### Write it (ONE terminal call)

Types are `system`, `decision`, `convention`, `constraint`. Edge relations are
`depends-on`, `applies-to`, `supersedes`, `contradicts`, `evidence-for`.

```bash
agent-memory write --from-json - --source handoff <<'JSON'
{"nodes":[
  {"id":"use-sessions","type":"decision",
   "title":"Chose server sessions over JWT",
   "body":"Why: revocation had to take effect immediately.\nRejected: short-TTL JWT, because logout would lag by the TTL.\nImplemented in src/auth/session.js:42.",
   "edges":[{"rel":"evidence-for","dst":"auth-service"}]}
]}
JSON
```

```powershell
@'
<the JSON>
'@ | Set-Content -Path .agent-memory-write.json -Encoding UTF8
agent-memory write --from-json .agent-memory-write.json --source handoff
Remove-Item -Force .agent-memory-write.json
```

**Use these as written. Do not introduce a variable.** Some agent terminals rewrite
`$`-prefixed lines before the shell sees them, corrupting the payload into malformed
JSON. PowerShell writes a file rather than piping because Windows PowerShell pipes to
a native command using `$OutputEncoding`, which is not UTF-8 by default.

`write` redacts before anything reaches disk and reports every validation error at
once. Surface its warnings verbatim; a `title collision` warning means two ids now
describe the same thing and the user should know.

---

## Step 8 — Print the pickup lines

Three different jobs pick up a handoff, and one line cannot serve all of them.

**Continuing** is the same work in another chat or another window: same repository,
same branch, the Next action is the next thing to do. A new chat on the same repo is
this case, not a fresh start — the context is in the file, so the user should not be
retyping it.

**Replicating** is the same *kind* of work in a different repository. There the Next
action is wrong by construction — it names branches, paths and environments that
belong to the repo this file was written in. An agent told to "follow the Next
action" in a different repo will either execute the wrong step or go read the
original repo off disk to work out what was meant, and both burn the user's credits
to arrive somewhere worse than a cold start.

Each pickup line now carries the claim it makes about where it is being pasted, so the
reader can check that claim against `origin:` and `repos:` and refuse when it is false.
That check is what the Conflict row in Step 3 exists for, and the line has to assert
something for the row to catch it.

End your reply with exactly this, and nothing after it:

```
Handoff written: <absolute path to id.md>
Thread: <id> (<created|updated>) — status <status>, origin session <session>

Continue in a new chat or another window (same repo):
Read <absolute path to id.md> and continue this work. You are Continuing, not
Replicating: <repo name> is the repo this describes. Check git state against the
file's `updated:` before you act on Next action.

Replicate in a different repo:
Read <absolute path to id.md>. It describes work done in <repo name>. If that IS the
repo you have open, stop and tell me — I pasted the wrong line. Otherwise follow
Execution protocol and re-derive every specific — branch names, file paths, module
versions — from this repository. Do not open <repo name> and do not assume its Next
action applies. Tell me the plan before you edit.
```

Print both. The user knows which window they are pasting into; you do not.

When `status: done`, print neither. There is nothing to continue and nothing whose
Next action could be replicated. Print one Reference line instead:

```
Reference (this thread is done):
Read <absolute path to id.md>. It records completed work in <repo name>; its Next
action is already done. Tell me what you want from it before changing anything.
```

---

## Self-check before you write

Answer all six. If any is no, fix the file before writing it.

1. Could a fresh agent execute **Next action** from this file alone?
2. Could an agent **in a different repository** replicate this work from this file
   alone, without opening the repo it was written in? If it would have to go read
   the original source to understand the shape of the change, Execution protocol is
   too thin. This is the question that catches a handoff which reads well and is
   still not portable.
3. Does every decision state why, and what was rejected?
4. Is Rejected approaches non-empty, or explicitly `None.`?
5. Is every claim anchored to a path or a decision number?
6. Is there a single secret, token, or connection string left in the body?
7. Does `origin:` carry a session, host and cwd, so a reader in a new chat on this
   same repo can tell Resuming from Continuing rather than guessing?
8. Is every part of the work surface either under `repos:` or under `surfaces:`? Work
   that lived in a wiki page, a ticket or a file outside the tree has no repo-side
   equivalent, and a reader asked to replicate it will either invent one or stall.

---

## Failure handling

- **File-write tool refuses paths outside the workspace.** Use the PowerShell or
  bash fallback in Step 5. Expected on some configurations; not an error.
- **Terminal commands are approval-gated.** Proceed anyway. One approval click is
  worth minutes of re-explanation. Do not ask the user to disable the gate.
- **Both write paths blocked.** Print the complete handoff body in the chat with
  its intended absolute path and tell the user to save it manually. Never silently
  fail, and never claim you wrote a file you did not write.
- **Not a git repository.** Omit git fields, record the working directory path,
  continue.
