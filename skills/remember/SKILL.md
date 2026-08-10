---
name: remember
version: 0.1.0
description: Capture durable project knowledge from the current conversation into the shared memory graph, so a later conversation in any window or repository already knows it. Use when the user says remember this, save this, note this for later, or /remember.
license: MIT
allowed-tools: Bash Read Write
triggers:
  - remember this
  - save this for later
  - note this down
  - remember
---

# remember

Write down what this conversation established, so the next one does not have to
establish it again.

`/handoff` only fires when you switch windows. The best insight of a session dies if
the user simply closes the tab, so this exists as a deliberate mid-session capture.
It costs one request. Spend it well: write the knowledge, not the transcript.

Do the whole job in **one pass**. Compose, write one JSON file, make one terminal
call. Do not ask the user to confirm each node.

---

## Two forms

- **`/remember`** — you select the durable knowledge from the conversation so far.
- **`/remember <what>`** — the user named the thing. Write that, with full context
  from the conversation, and write nothing unrelated to it.

---

## Step 1 — Select what is durable

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

Types:

| type | what it holds |
|---|---|
| `system` | how a thing works, anchored to a `path:line` |
| `decision` | what was chosen, why, and what was rejected |
| `convention` | how this codebase does something, and the gotcha |
| `constraint` | what the environment or the org forbids |

---

## Step 2 — Compose the JSON

One file, one array. Ids are kebab-case and name the subject, not the session.

```json
{
  "nodes": [
    {
      "id": "use-sessions",
      "type": "decision",
      "title": "Chose server sessions over JWT",
      "body": "Why: revocation had to take effect immediately.\nRejected: short-TTL JWT, because logout would lag by the TTL.\nImplemented in src/auth/session.js:42.",
      "confidence": "observed",
      "edges": [{ "rel": "evidence-for", "dst": "auth-service" }]
    }
  ]
}
```

Fields you may set: `id`, `type`, `title`, `body`, `repos`, `scope`, `confidence`,
`supersedes`, `edges`. Everything else is filled in for you.

- `repos` defaults to the current repository. Set `"scope": "global"` with an empty
  `repos` for something true everywhere, such as an org-wide restriction.
- `edges` relations: `depends-on`, `applies-to`, `supersedes`, `contradicts`,
  `evidence-for`. A `dst` that does not exist yet is allowed; it connects when that
  note is written.
- Write the body for someone with zero context, and anchor it to a `path:line`.

---

## Step 3 — Write it (ONE terminal call)

**bash (macOS / Linux):**

```bash
tmp="$(mktemp)"
cat > "$tmp" <<'JSON'
<the JSON from Step 2>
JSON
agent-memory write --from-json "$tmp" --source remember
rm -f "$tmp"
```

**PowerShell (Windows / AVD):**

```powershell
$tmp = [System.IO.Path]::GetTempFileName()
@'
<the JSON from Step 2>
'@ | Set-Content -Path $tmp -Encoding UTF8
agent-memory write --from-json $tmp --source remember
Remove-Item -Force $tmp
```

Redaction runs inside `write`, before any bytes reach disk, and cannot be turned
off. You still must not paste a raw secret into the JSON: the guard is a backstop,
not a licence.

---

## Step 4 — Report

Print every id written, one per line, with what it is:

```
created use-sessions [decision]  Chose server sessions over JWT
updated auth-service [system]    Auth uses server sessions
```

Then stop. Do not summarize the conversation.

Warnings from `write` are worth surfacing verbatim:

- `title collision` means an existing note reads as the same thing under a different
  id. Tell the user which two, and offer to merge or link them with `contradicts`.
- `redacted Nx <kind>` means the guard caught something. Say what kind was caught so
  the user knows a secret was in play, never what the value was.

---

## Failure handling

- **Validation failed.** `write` reports every error at once. Fix them all and retry
  once. If it fails again, print the errors and stop; do not guess at the schema.
- **`agent-memory: command not found`.** Print the JSON in the chat first, so the
  work is not lost, then say the store needs `npm install -g @vib795/agent-memory`
  (Node >= 22.5). Do not run it yourself. This is the expected state when the skill
  was installed on its own with `gh skill install` rather than with the package.
- **Nothing durable in the conversation.** Say so in one line. That is a correct
  outcome, not a failure.
