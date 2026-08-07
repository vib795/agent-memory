---
name: handoff
version: 0.1.0
description: Capture the working state of the current conversation into a portable handoff file, so an agent in a different VS Code window or a different repository can continue the work without the user re-explaining it. Use when the user says handoff, hand this off, save context, wrap this up, or continue this elsewhere.
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
triggers:
  - handoff
  - hand this off
  - save context for another window
  - continue this in another repo
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
Write-Output "--- STATUS ---"
git status --porcelain 2>$null
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
echo "--- STATUS ---"; git status --porcelain 2>/dev/null
echo "UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

If the directory is not a git repository, `ROOT`/`BRANCH`/`HEAD` come back empty.
That is not an error. Record the working directory path and omit the git fields.

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
agent: copilot | claude-code
---

## Orientation

3 to 5 sentences. What this thread is trying to accomplish and where it stands.
Written for a reader with zero prior context.

## Decisions

| # | Decision | Why | Alternatives rejected |
|---|----------|-----|----------------------|

## Constraints

Things not discoverable by reading the code: environment restrictions,
unavailable tooling, plan limits, deadlines, taste calls already settled.

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

### Quality rules

These separate a useful handoff from a readable paragraph that still leaves questions.

1. Write for a reader with zero context. No pronoun without a stated antecedent.
2. Every decision carries its **why**. Rationale is what never survives
   re-explanation and is the whole reason a handoff beats a transcript.
3. Never quote or paraphrase the transcript. Record conclusions, not the path to them.
4. Anchor claims to a file path or a decision number. "We refactored the service
   layer" is a failure. "`src/services/order.ts:42` now returns `Result<T>` instead
   of throwing" is not.
5. Record only what the conversation actually established. Prefix anything you
   inferred with `inferred:` so the next agent knows to verify it.
6. Never inline a diff or a patch. List changed files with one line each.
7. Soft target 150 lines. On overflow, move detail into `<id>.detail.md` and
   reference it. Never drop Decisions or Rejected approaches to hit the target.
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

Your Decisions table and Constraints section are usually already the durable part.
The Current task state section never is.

### Write it (ONE terminal call)

Types are `system`, `decision`, `convention`, `constraint`. Edge relations are
`depends-on`, `applies-to`, `supersedes`, `contradicts`, `evidence-for`.

```bash
tmp="$(mktemp)"
cat > "$tmp" <<'JSON'
{"nodes":[
  {"id":"use-sessions","type":"decision",
   "title":"Chose server sessions over JWT",
   "body":"Why: revocation had to take effect immediately.\nRejected: short-TTL JWT, because logout would lag by the TTL.\nImplemented in src/auth/session.js:42.",
   "edges":[{"rel":"evidence-for","dst":"auth-service"}]}
]}
JSON
agent-memory write --from-json "$tmp" --source handoff
rm -f "$tmp"
```

```powershell
$tmp = [System.IO.Path]::GetTempFileName()
@'
<the JSON>
'@ | Set-Content -Path $tmp -Encoding UTF8
agent-memory write --from-json $tmp --source handoff
Remove-Item -Force $tmp
```

`write` redacts before anything reaches disk and reports every validation error at
once. Surface its warnings verbatim; a `title collision` warning means two ids now
describe the same thing and the user should know.

---

## Step 8 — Print the pickup line

End your reply with exactly this, and nothing after it:

```
Handoff written: <absolute path to id.md>
Thread: <id> (<created|updated>)

Paste this in the other window:
Read <absolute path to id.md> and continue this work. Follow the Next action.
```

---

## Self-check before you write

Answer all five. If any is no, fix the file before writing it.

1. Could a fresh agent execute **Next action** from this file alone?
2. Does every decision state why, and what was rejected?
3. Is Rejected approaches non-empty, or explicitly `None.`?
4. Is every claim anchored to a path or a decision number?
5. Is there a single secret, token, or connection string left in the body?

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
