---
name: remember
version: 0.1.0
description: Capture durable project knowledge from this conversation into a cross-repo memory graph, so a later conversation anywhere already knows it. Use when the user says remember this, save this, note this for later, or /remember. Also invoke it unasked when a juncture passes - a decision settled, a constraint found, a root cause identified, a convention agreed - then say so in one line and carry on.
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

## Three forms

- **`/remember`** — you select the durable knowledge from the conversation so far.
- **`/remember <what>`** — the user named the thing. Write that, with full context
  from the conversation, and write nothing unrelated to it.
- **Unasked** — you noticed a juncture pass and captured it without being told.

### Capturing unasked

A memory that only grows when someone remembers to grow it stays thin, and thin is
how it dies: the one fact worth having is the one nobody stopped to write down.

Invoke this yourself the moment one of these has just happened, in the same turn:

- a **decision** was settled, and the reasons and rejected options are still in view
- a **constraint** surfaced — a blocked tool, a policy, an environment restriction
- a **tool you reached for was not there** — not on `PATH`, not installed, not
  permitted. A command that failed because the machine does not have it is a
  `constraint`, and an unrecorded one is a tool call you will spend again in every
  future session on that machine
- a **root cause** was found, as opposed to a symptom worked around
- a **convention** was agreed, or discovered by reading the code
- a **procedure** ran end to end and worked — the order of the steps is now known,
  and it is about to be forgotten

Do not capture on a timer, on a tool count, or at every reply. Those produce volume,
and volume is what makes a graph useless — a store full of task chatter is worse than
an empty one, because it buries the four notes that mattered.

Never capture: task status, what you are about to do next, anything already in the
graph, or anything that will be false next month. If you captured a juncture earlier
in this conversation, do not capture it again because it came up a second time.

**It is free, and that is the point.** A request is charged per prompt, not per tool
call, so capturing inside a turn you were already answering costs nothing. Only a
user typing `/remember` spends a request. That is the whole reason to do this
yourself rather than wait to be asked.

**Report it in one line, then carry on:**

```
captured 2 notes [decision, constraint]
```

At the end of the answer you were already giving. Do not print the JSON, do not
summarize what you wrote, and do not make it the subject of the reply — the user
asked you about something else and is still waiting for it. One line is enough for
them to know it happened and to run `/recall` if they want the detail.

If nothing durable happened, say nothing at all. Silence is the correct output for
most turns.

---

## Step 1 — Select what is durable

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

Types:

| type | what it holds |
|---|---|
| `system` | how a thing works, anchored to a `path:line` |
| `decision` | what was chosen, why, and what was rejected |
| `convention` | how this codebase does something, and the gotcha — including multi-step procedures, branch choreography, and deploy ordering |
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
agent-memory write --from-json - --source remember <<'JSON'
<the JSON from Step 2>
JSON
```

**PowerShell (Windows / AVD):**

```powershell
@'
<the JSON from Step 2>
'@ | Set-Content -Path .agent-memory-write.json -Encoding UTF8
agent-memory write --from-json .agent-memory-write.json --source remember
Remove-Item -Force .agent-memory-write.json
```

**Use these as written. Do not introduce a variable.** Some agent terminals rewrite
`$`-prefixed lines before the shell sees them, which turns the payload into malformed
JSON and costs you two retries diagnosing a corruption that never reached disk. Both
recipes above are free of variables for that reason.

PowerShell writes a file rather than piping, because Windows PowerShell pipes to a
native command using `$OutputEncoding`, which is not UTF-8 by default and would mangle
any non-ASCII character in a body. `-Encoding UTF8` on a file is explicit and safe. The
file is written next to you and removed on the next line; if you see it left behind,
the write failed and the JSON is still there to read.

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
