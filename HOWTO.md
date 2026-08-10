# How to use agent-memory

**A 10-minute read that will save you a lot of 10-minute re-explanations.**

You do not need to be a developer to follow this. If you can copy a line of text and
press Enter, you can do all of it.

---

## 1. The problem, in one scene

You spend forty minutes with an AI assistant working out why the checkout page is slow.
You try three things. Two are dead ends. The third works, and you learn *why* — some
cache setting nobody documented.

The next morning you open a new chat.

It knows nothing. Not the dead ends, not the fix, not the reason. So you explain it
again, from the top, and pay for the privilege — because those forty minutes cost real
requests out of your monthly allowance, and you are about to spend them twice.

Your assistant has no long-term memory. Every conversation starts at zero.

**agent-memory gives it one.** A small set of notes, stored as plain text files on your
own machine, that any AI assistant on that machine can read — tomorrow, next month, from
a completely different project folder.

---

## 2. What you actually get

Three commands you type into the chat box. That is the whole interface.

| You type | What happens |
|---|---|
| `/remember` | "Keep this." It writes down what was decided and why. |
| `/recall` | "What do we already know?" It answers from your notes instead of guessing. |
| `/handoff` | "Save my place." It bottles up the current work so another window can continue it. |

The most important one is `/recall`, and here is the trick: **you usually will not type
it.** Your assistant reads a one-line summary of everything in your memory at the start
of every conversation, so when you ask a question your notes can answer, it goes and
looks on its own.

You are not managing a database. You are leaving notes for your future self, and
somebody else does the filing.

---

## 3. Install it (about 60 seconds)

You will need **Node.js version 22.5 or newer**. To check, open a terminal —
on Windows that's **PowerShell**, on a Mac it's **Terminal** — and type:

```bash
node --version
```

If that prints something like `v22.5.0` or higher, you are set. If it prints an error or
a smaller number, install Node from [nodejs.org](https://nodejs.org) first.

Now run these two lines:

```bash
npm install -g @vib795/agent-memory
agent-memory setup
```

**Both lines matter.** The first downloads it. The second installs it into every AI tool
you have. Modern npm refuses to let a package run its own setup automatically — a
sensible security default — so the second line is you giving permission, by hand.

> No access to the npm registry at work? Clone it instead. This needs nothing but
> GitHub, and it is what to use if your company proxy blocks or quarantines npm:
> ```bash
> git clone https://github.com/vib795/agent-memory.git
> npm install -g ./agent-memory
> agent-memory setup
> ```
> Clone first — installing from the git URL directly does not work. See the README.

### What just happened

`setup` looked around your machine for AI tools, and installed itself into each one it
found — in whatever format that particular tool reads:

| If you have | It installs | Where |
|---|---|---|
| Claude Code | a skill | `~/.claude/skills/` |
| Codex CLI | a skill | `~/.codex/skills/` |
| VS Code, Insiders, Cursor, Windsurf | a prompt file | the editor's `prompts` folder |
| GitHub Copilot agent skills | a skill | `~/.agents/skills/` |

It prints exactly what it did. If your editor is not in that list, it will say so rather
than silently skipping it.

You should see something like:

```
Installed for 4 agents:
  Agent skills (shared convention)
    [link] /Users/you/.agents/skills/handoff
    ...
Store ready at /Users/you/.agents/memory (0 notes).
```

Zero notes is correct. It is a new notebook. You have not written in it yet.

---

## 4. Prove it works

```bash
agent-memory doctor
```

This is your one diagnostic. It checks the Node version, finds your tools, verifies the
files are where they should be, and tells you plainly if something is wrong. Run it any
time something feels off — it is designed to be the first thing you try, not the last.

---

## 5. Your first five minutes

Do this once. It takes longer to read than to do.

**Step one — open any AI assistant and teach it something.** Have a normal conversation
about a real project. Make a decision. Then type:

```
/remember
```

It will pull out what was actually decided, strip anything that looks like a password or
a key, and save it. You will see which notes it wrote.

**Step two — close that conversation entirely.** Open a fresh one. Ideally in a
different project folder, to prove the point.

**Step three — ask about the thing you just decided.** Not `/recall`. Just ask, the way
you would ask a colleague:

> Why did we go with the queue instead of a cron job?

If it comes back with your reasoning — including what you rejected and why — it is
working. That is the whole product. Everything else is plumbing.

---

## 6. The three commands, in more detail

### `/remember` — for things that stay true

Use it when something is settled and would be annoying to work out twice:

- **A decision**, and critically, *what you rejected and why.* "We chose X" ages badly.
  "We chose X over Y because Y needs a native build step our laptops can't run" is still
  useful in a year.
- **A constraint** you cannot see in the code. "The security team will not approve any
  new background service." No amount of reading the codebase reveals that.
- **A convention** your team follows that isn't written down anywhere.
- **How a system actually works**, once you have finally understood it.

You can also point it at something specific:

```
/remember the retry policy on the orders webhook
```

**Don't bother remembering** anything the code already says. If someone can find it by
opening a file, it does not need a note. Notes are for what lives in people's heads.

### `/handoff` — for moving work between windows

This one is not a chat summary. Summaries read nicely and still leave the next
conversation asking questions.

`/handoff` captures **working state**: the decisions with their reasoning, the
approaches you already tried that failed, what you were about to do next and what is
blocking it, which files you touched, and the exact `file:line` spots that matter.

Type `/handoff` and it hands you back a single line to paste elsewhere:

```
Read C:\Users\you\.agents\handoffs\fix-checkout-latency.md and continue this work.
Follow the Next action.
```

Paste that into any other window, in any project, and it picks up where you stopped.

Run `/handoff` again later on the same work and it updates the same file rather than
creating a second one — it recognises the thread even if you have started calling it
something slightly different. One previous version is kept, just in case.

**Bonus:** `/handoff` also does `/remember`'s job in the same breath, at no extra cost.
More on why that matters in a moment.

### `/recall` — for getting the answer back

Mostly automatic, as described above. Type it explicitly when you want to see
everything the memory holds on a subject, or when you suspect it knows something and
didn't volunteer it.

---

## 7. Notes for your specific tool

### Claude Code

Nothing to do. The three commands appear as skills in both the terminal version and
the VS Code extension. Type `/recall` and you will see them.

### Codex CLI

Nothing to do. Codex uses the same skill format, and `setup` installs into
`$CODEX_HOME/skills` (usually `~/.codex/skills`). Restart Codex once after installing so
it picks up the new skills.

### GitHub Copilot in VS Code (the chat sidebar)

This is the one most people use, so read this bit.

`setup` writes **prompt files** into VS Code's user folder. Open Copilot chat, type `/`,
and you should see `recall`, `remember` and `handoff` in the dropdown.

**If you don't see them:**

1. Restart VS Code. New prompt files are picked up on start.
2. Check that prompt files are switched on. Open Settings, search for `chat.promptFiles`,
   and make sure it is enabled. On older VS Code builds this is off by default.
3. Run `agent-memory doctor` to confirm the files landed in the folder VS Code is
   actually reading.

**One thing to remember:** when you upgrade the package, re-run `agent-memory setup`.
Prompt files are copies, not links, so they do not update themselves.

### GitHub Copilot CLI

**Not supported, deliberately.** It is detected, and `setup` tells you it is skipping it.

Copilot CLI has no user-wide place to put instructions, so there is nothing to install
into. Writing a file into its config folder on a hunch is how you ship something that
does nothing while claiming to work.

If you want memory in a specific repository with Copilot CLI, add the instructions to
that repo's `.github/copilot-instructions.md` by hand. That works, but you have to do it
per repository — which is the exact problem this package exists to solve everywhere
else.

---

## 8. Does this cost me extra requests?

Almost never, and the reason is worth knowing.

Your allowance is charged **per message you send**, not per action the assistant takes
while answering. So when `/handoff` saves your working state, it does it *inside* a turn
you already paid for. It is free.

`/remember` costs one request, because you sent one message. That is the only charge,
and you chose to spend it.

The savings run the other way. Every question your memory answers is a conversation you
did not have to have twice.

---

## 9. What it will not do

Being clear about this now saves disappointment later.

- **It does not save things on its own.** You invoke it, or `/handoff` does. Nothing
  runs in the background. This is a deliberate choice: memory that fills itself up
  becomes memory you cannot trust.
- **It does not sync between machines.** Your notes live on the computer that wrote
  them. There is no server, no account, no cloud.
- **It is not shared with your team.** One person, one machine, for now.

---

## 10. Where your things live, and who can see them

Everything is in one folder:

```
~/.agents/          (on Windows: C:\Users\you\.agents\)
  handoffs/         your saved working states
  memory/notes/     your notes, as plain markdown files
```

Three things worth knowing:

**Nothing leaves your machine.** No server, no account, no telemetry, no background
process, nothing to get approved by IT. It is a small program that writes text files.

**Passwords and keys never get written down.** Anything that looks like a token, a key,
a connection string or a session cookie is replaced with `<redacted>` *before* anything
is saved — not to a note, not to a temporary file. There is no way to switch this off,
which is the point.

**Your notes are just files.** Open them in any text editor. Read them, edit them, put
them in Dropbox, print them out. If you uninstall this tool tomorrow, every note stays
exactly where it is and remains perfectly readable. You are not locked in — there is
nothing to be locked into.

**Nothing is ever deleted.** Notes that get replaced or go stale move to an `archive`
folder rather than disappearing.

---

## 11. When something is wrong

**Start here, always:**

```bash
agent-memory doctor
```

| Symptom | What's going on |
|---|---|
| `/recall` doesn't appear in VS Code | Restart VS Code, then check the `chat.promptFiles` setting. See §7. |
| The commands vanished after an upgrade | Re-run `agent-memory setup`. |
| It answers with outdated information | Notes show their age. Anything captured long ago is flagged `verify before trusting` — that flag is doing its job, and you should. |
| `doctor` reports broken links | Usually means Node moved. Re-run `agent-memory setup`. |
| Something is badly confused | `agent-memory compact` tidies and rebuilds. Your notes are the source of truth, so this cannot lose anything. |

---

## 12. Removing it

**The order matters, and npm will not do it for you:**

```bash
agent-memory uninstall          # first — this removes the commands from your tools
npm uninstall -g @vib795/agent-memory
```

If you do it the other way round, npm deletes the program *including the part that
cleans up*, and your AI tools are left with commands that point at nothing. If that has
already happened, install it again and run `agent-memory setup` — that clears the dead
commands and puts working ones back.

Your notes are untouched either way. They are at `~/.agents/memory`, they are plain
text, and deleting them is your decision to make, not the uninstaller's.

---

## Cheat sheet

```bash
node --version                          # must be 22.5+
npm install -g @vib795/agent-memory     # 1. download
agent-memory setup                      # 2. install into your AI tools
agent-memory doctor                     # is everything OK?
```

Then, in any AI chat:

```
/remember      keep what we just worked out
/handoff       save my place so another window can continue
/recall        what do we already know about this?
```

And most of the time, just ask your question normally and let it find the answer itself.

---

*More detail, and the reasoning behind the design, is in the
[README](README.md). Problems and ideas go in
[issues](https://github.com/vib795/agent-memory/issues).*
