import { loadConfig, NOTE_TYPES } from './config.js';
import { createHash } from 'node:crypto';
import { captureGap, currentRepo } from './staleness.js';

/**
 * Tiers 1 and 2 of a three-tier ladder.
 *
 * Tier 1 is a skill description, loaded into every chat whether or not memory is ever
 * used. It is standing cost, so it has to read like a description rather than a
 * document. It has two occupants, not one: `recall`'s description advertises what the
 * store knows; `remember`'s advertises what it is missing. Both are the same mechanism
 * — a line of frontmatter that code regenerates and every conversation loads —
 * pointed at opposite halves of the same problem.
 *
 * Tier 2 is printed only when a skill actually fires: the tree for `recall`, the
 * capture brief for `remember`. Per-invocation cost, paid once, and only when someone
 * is already looking something up or about to write one down.
 *
 * Tier 3 — note bodies, and the colliding note that `write` hands back — lives
 * outside this module, because by then the question is which note rather than which
 * of them.
 *
 * Neither tier here costs a premium request. A request is charged per prompt, not per
 * tool call, so both of these ride inside a turn that was already paid for.
 */

// Never dropped from either tier. A constraint is what stops an agent from burning
// a retry loop on an approach the org forbids, which is where requests actually go.
// Everything else here is negotiable; this is not.
const PRIVILEGED = 'constraint';

const TYPE_ORDER = ['constraint', 'decision', 'convention', 'system'];

const USE_WHEN =
  'Use when you need to know how a system works, why a decision was made, ' +
  'what convention applies, or what the environment forbids.';

/**
 * A repository name safe to put in front of a model.
 *
 * `currentRepo` is `basename(git rev-parse --show-toplevel)` — a directory name. That
 * value reaches Tier 1, the one string loaded into every conversation, and
 * `writeSkillDescription` only JSON-quotes the line, which keeps the YAML valid and
 * does nothing about the content.
 *
 * The charset filter alone is not enough, and the reason is specific: a GitHub
 * repository name is drawn from exactly this charset, so
 * `SYSTEM-ignore-previous-instructions` survives it unchanged and arrives by nothing
 * more exotic than `git clone`. Hyphens separate words as well as spaces do.
 *
 * So shape decides. A repository name is one to three segments and short; an
 * instruction needs more words than that. Anything outside that shape is rendered as a
 * stable non-semantic identifier instead — the name is still distinguishable from
 * another repository's, and still tells a reader in the wrong tree that the numbers are
 * not theirs, which is the only job it had.
 *
 * The cost is honest: a legitimate four-segment name shows as `repo-<hash>`. That is a
 * deliberate trade of some legibility for a Tier-1 string that cannot be authored by
 * whoever chose the directory name.
 *
 * Display only. Every query still matches on the real name, because a repository whose
 * notes stopped being found would be a worse bug than the one this closes.
 */
export function safeRepo(name) {
  if (typeof name !== 'string' || !name) return 'unnamed';
  // Filtering must not be able to *make* a name look ordinary. Stripping the spaces
  // out of "Ignore previous instructions" collapses it into one long token that would
  // pass the shape test below, so a name that had to be modified at all is already
  // outside the shape and goes straight to an identifier.
  const untouched = /^[A-Za-z0-9._-]+$/.test(name);
  const segments = name.split(/[-._]+/).filter(Boolean);
  if (untouched && segments.length <= 3 && name.length <= 32) return name;
  // Stable across runs and machines, so the same repository always reads the same and
  // two repositories never collide in the description.
  return `repo-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}


function typeRank(type) {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
}

/** id -> total edges touching it, in one query rather than one per node. */
function degreeMap(db) {
  const map = new Map();
  for (const row of db
    .prepare(`
      SELECT n.id AS id, COUNT(e.rowid) AS degree
        FROM nodes n
        LEFT JOIN edges e ON e.src = n.id OR e.dst = n.id
       GROUP BY n.id
    `)
    .all()) {
    map.set(row.id, row.degree);
  }
  return map;
}

/**
 * Tier 1: the skill description.
 *
 * Composition order is constraint count, then repos by note count, then topics by
 * edge degree. On overflow the lowest-degree topics go first, then repos. Two
 * pieces are structural and never dropped: the constraint count, and the closing
 * "use when" clause, which is the entire reason an agent decides to invoke at all.
 * Cutting that to save characters would save the cost of a feature by deleting it.
 */
export function buildDigest(db, { cfg = loadConfig() } = {}) {
  const cap = cfg.digestChars;
  const total = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE archived = 0').get().c;
  if (!total) {
    // USE_WHEN belongs here too. This branch used to return without it, which stripped
    // the routing triggers from Tier 1 on exactly the machines that need them most: a
    // fresh install, where the store is empty and the skill still has to earn its
    // first use. An empty store is a reason to say when to call recall, not to stop.
    return (
      'Durable project knowledge store, currently empty. ' +
      `Run /remember to capture the first note. ${USE_WHEN}`
    );
  }

  const constraints = db
    .prepare("SELECT COUNT(*) AS c FROM nodes WHERE archived = 0 AND type = 'constraint'")
    .get().c;

  const repos = db
    .prepare(`
      SELECT r.repo AS repo, COUNT(*) AS c
        FROM node_repos r JOIN nodes n ON n.id = r.node_id
       WHERE n.archived = 0
       GROUP BY r.repo
       ORDER BY c DESC, r.repo
    `)
    .all()
    .map((r) => safeRepo(r.repo));

  const topics = db
    .prepare(`
      SELECT n.title AS title, COUNT(e.rowid) AS degree
        FROM nodes n
        LEFT JOIN edges e ON e.src = n.id OR e.dst = n.id
       WHERE n.archived = 0
       GROUP BY n.id
       ORDER BY degree DESC, n.title
    `)
    .all()
    .map((r) => r.title.toLowerCase());

  const head =
    `Durable project knowledge: ${total} note${total === 1 ? '' : 's'}` +
    (constraints ? `, ${constraints} constraint${constraints === 1 ? '' : 's'}` : '');

  // Shed the elastic middle one whole item at a time. Cutting mid-word would leave
  // the description looking corrupted, which is worse than saying less.
  const useRepos = repos.slice();
  const useTopics = topics.slice();
  const compose = () => {
    let s = head;
    if (useRepos.length) s += ` across ${useRepos.join(', ')}`;
    s += '.';
    if (useTopics.length) s += ` Topics: ${useTopics.join(', ')}.`;
    return `${s} ${USE_WHEN}`;
  };

  let out = compose();
  while (out.length > cap && useTopics.length) {
    useTopics.pop();
    out = compose();
  }
  while (out.length > cap && useRepos.length) {
    useRepos.pop();
    out = compose();
  }
  // If the head plus the use-when clause alone exceed the cap, the cap is too small
  // for a usable description. Return the structural minimum; `doctor` reports it.
  return out;
}

// The routing clause for `remember`, and the mirror of USE_WHEN. It carries both the
// asked form and the unasked one, because the unasked one is the entire reason this
// description is regenerated at all: a memory that only grows when someone remembers
// to grow it stays thin. Never dropped, for the same reason USE_WHEN is never dropped.
const CAPTURE_WHEN =
  'Use when the user says remember this, save this or note this down — and invoke it ' +
  'unasked the moment a decision settles, a constraint surfaces, a root cause is ' +
  'found or a convention is agreed.';

const NUDGE_GENERIC = 'Capture durable project knowledge into a cross-repo memory graph.';

/**
 * Notes that speak for this repository, counted the way `captureGap` scopes them.
 *
 * A node with no repos is global and applies everywhere, so it counts here; a node
 * claiming other repos does not. This mirrors `captureGap`'s filter deliberately —
 * two different answers to "does this note cover me" in one description would be a
 * bug the reader could see.
 */
function repoScopedCount(db, repo, type = null) {
  // Bound in SQL order: the type predicate precedes the repo one in the statement.
  return db
    .prepare(`
      SELECT COUNT(*) AS c
        FROM nodes n
       WHERE n.archived = 0 ${type ? 'AND n.type = ?' : ''}
         AND (NOT EXISTS (SELECT 1 FROM node_repos r WHERE r.node_id = n.id)
              OR EXISTS (SELECT 1 FROM node_repos r WHERE r.node_id = n.id AND r.repo = ?))
    `)
    .get(...(type ? [type, repo] : [repo])).c;
}

/**
 * Tier 1, second occupant: the `remember` skill description.
 *
 * `captureGap` has known since 0.5 how far a repository has moved with nothing written
 * down in it, and that answer went only to `doctor` — a command a person runs on
 * purpose, which is precisely the person who did not need telling. The signal never
 * reached the one reader who could act on it mid-conversation. This routes it to the
 * surface that is already loaded into every turn.
 *
 * Written as a *state*, never as an instruction. "340 commits since anything was
 * captured here" is a fact the model can weigh against what just happened in the
 * conversation; "remember to capture things" is wallpaper it stops seeing by the third
 * turn. The distinction is the whole design: code supplies the timing signal, the model
 * still decides whether anything durable actually happened.
 *
 * It goes quiet on a covered repository. A description that nags at a store which is
 * already current teaches the reader to discount the line, and then it is worth nothing
 * on the day it has something to say.
 *
 * Scoping caveat, stated because it is visible in the output: the gap is per repository
 * and `compact` runs wherever the user happens to be, so this describes the repo where
 * compaction last ran. That is why every variant names the repo out loud — a reader in
 * a different tree can see the mismatch rather than act on a number that is not theirs.
 * `maybeCompact` re-points it on the next write, so it self-corrects with use.
 */
export function buildCaptureNudge(db, { cfg = loadConfig(), cwd = process.cwd(), repo, gap } = {}) {
  const g = gap !== undefined ? gap : captureGap(db, { cwd, cfg, repo });

  const compose = (head) => {
    const out = head ? `${head} ${CAPTURE_WHEN}` : `${NUDGE_GENERIC} ${CAPTURE_WHEN}`;
    // Nothing here is a list, so there is no elastic middle to shed one item at a
    // time. Over the cap, drop the whole head rather than truncate mid-sentence: a
    // description that stops in the middle of a number reads as corrupted, and the
    // routing clause is the part that must survive either way.
    return out.length > cfg.digestChars ? `${NUDGE_GENERIC} ${CAPTURE_WHEN}` : out;
  };

  // Outside a repository there is no gap to report and no repo to name. Say what the
  // skill is for and stop, rather than inventing a number.
  if (!g) return compose(null);

  // Never captured in this repository. `captureGap` counts only notes carrying a
  // `captured_sha`, so this is its answer to "has anyone written anything down here",
  // and the commit branches below stay on that same definition. The broader count is
  // reserved for the covered branches, where the question is how much knowledge applies
  // here rather than how much of it was captured here.
  // Display only. `repoScopedCount` below is still given the real name.
  const label = safeRepo(g.repo);

  if (g.notes === 0) {
    // captureGap withholds its note on a repository too young for the absence to mean
    // anything. Stay silent with it: nagging on commit three is how a signal gets
    // discounted long before the day it matters.
    return compose(
      g.note ? `Nothing has ever been captured for ${label} — ${g.commits} commits of history.` : null,
    );
  }

  // Captured, but the repository has moved a long way since the most recent one.
  if (g.note) return compose(`${g.commits} commits since anything was captured for ${label}.`);

  // Current on commits, but blind in the type that matters most. `digest` privileges
  // constraints and never drops them from Tier 1; a store holding none has not recorded
  // the thing most likely to save a future session a wasted retry loop.
  const notes = repoScopedCount(db, g.repo);
  if (repoScopedCount(db, g.repo, PRIVILEGED) === 0) {
    return compose(
      `${notes} note${notes === 1 ? '' : 's'} for ${label} and no constraint recorded — ` +
        'what this environment forbids has never been written down.',
    );
  }

  // Covered. Report the state plainly and let the routing clause do the rest.
  return compose(`${notes} note${notes === 1 ? '' : 's'} for ${label}, capture is current.`);
}

/**
 * Tier 2: the routing tree, scoped.
 *
 * A repo view returns that repo's nodes plus every `scope: global` node, because a
 * global constraint applies here too and hiding it is exactly the failure this
 * design cares about.
 */
export function buildTree(db, { repo = null, all = false, cfg = loadConfig() } = {}) {
  const rows = repo
    ? db
        .prepare(`
          SELECT DISTINCT n.id AS id, n.type AS type, n.title AS title,
                          n.archived AS archived, n.scope AS scope
            FROM nodes n
            LEFT JOIN node_repos r ON r.node_id = n.id
           WHERE n.scope = 'global' OR r.repo = ?
        `)
        .all(repo)
    : db.prepare('SELECT id, type, title, archived, scope FROM nodes').all();

  const degrees = degreeMap(db);
  const entries = rows.map((r) => ({ ...r, degree: degrees.get(r.id) ?? 0 }));

  entries.sort(
    (a, b) =>
      a.archived - b.archived ||
      typeRank(a.type) - typeRank(b.type) ||
      b.degree - a.degree ||
      (a.id < b.id ? -1 : 1),
  );

  const total = entries.length;
  // One line for the header, one for the truncation notice.
  const cap = Math.max(1, cfg.treeLines - 2);
  if (all || total <= cap) {
    return { repo, total, shown: total, omitted: [], lines: entries, truncated: false };
  }

  // Drop archived first, then by ascending degree. Least connected means least
  // likely to be the hub anyone needed. Constraints are exempt at any cap.
  const droppable = entries
    .filter((e) => e.type !== PRIVILEGED)
    .sort((a, b) => b.archived - a.archived || a.degree - b.degree || (a.id < b.id ? 1 : -1));

  const dropped = new Set();
  for (const e of droppable) {
    if (total - dropped.size <= cap) break;
    dropped.add(e.id);
  }

  const kept = entries.filter((e) => !dropped.has(e.id));
  return {
    repo,
    total,
    shown: kept.length,
    omitted: entries.filter((e) => dropped.has(e.id)).map((e) => ({ id: e.id, type: e.type })),
    lines: kept,
    truncated: true,
    // True when constraints alone exceed the cap. Reported, not silently fixed.
    overCap: kept.length > cap,
  };
}

export function renderTree(result) {
  const scope = result.repo ? safeRepo(result.repo) : 'all repos';
  const out = [`# memory: ${scope} — ${result.total} notes`];
  const width = result.lines.reduce((w, e) => Math.max(w, e.id.length), 0);
  for (const e of result.lines) {
    const mark = e.archived ? ' (archived)' : '';
    out.push(`${e.type.padEnd(10)} ${e.id.padEnd(width)}  ${e.title}${mark}`);
  }
  if (result.omitted.length) {
    // Always printed. Silent truncation that reads as full coverage is the single
    // most dangerous thing this tool could do, because it looks like an answer.
    out.push(`${result.omitted.length} nodes not shown, run agent-memory tree --all`);
  }
  // The map is what recall reads before answering, so it is where a thin graph has to
  // admit that it is thin. A short list and a silent footer read as full coverage.
  if (result.gap?.note) out.push(result.gap.note);
  return out.join('\n');
}

/**
 * What each type is for, shown only where one is missing.
 *
 * Taken from the table in the remember skill so there is one wording, not two that
 * drift. Printed against a zero count it answers the question the count raises: not
 * "you have none of these" but "here is what one would have said".
 */
const TYPE_HINT = {
  constraint: 'what the environment or the org forbids',
  decision: 'what was chosen, why, and what was rejected',
  convention: 'how this codebase does something, and the gotcha',
  system: 'how a thing works, anchored to a path:line',
};

/** Notes per type under the same scoping the tree uses, zeros included. */
function typeCounts(db, repo) {
  const rows = repo
    ? db
        .prepare(`
          SELECT n.type AS type, COUNT(DISTINCT n.id) AS c
            FROM nodes n
            LEFT JOIN node_repos r ON r.node_id = n.id
           WHERE n.archived = 0 AND (n.scope = 'global' OR r.repo = ?)
           GROUP BY n.type
        `)
        .all(repo)
    : db.prepare('SELECT type, COUNT(*) AS c FROM nodes WHERE archived = 0 GROUP BY type').all();

  // Seeded from NOTE_TYPES so a type with no rows reports 0 rather than going absent.
  // The absent ones are the entire point of this section.
  const counts = new Map(NOTE_TYPES.map((t) => [t, 0]));
  for (const r of rows) counts.set(r.type, r.c);
  return counts;
}

/**
 * Ids written recently enough that capturing them again would be a duplicate.
 *
 * The skill already forbids re-capturing a juncture that came up twice in one
 * conversation, and that rule currently depends on the model remembering across a
 * long turn. This makes it data instead.
 *
 * Recency is a proxy and is labelled as one: the CLI has no notion of a session, and
 * inventing one would mean tracking state this tool deliberately does not keep. A
 * window wide enough to cover the working session is the honest approximation.
 */
function recentlyCaptured(db, repo, cfg, now) {
  // Bound straight into SQLite's `LIMIT ?`, which rejects a REAL with `datatype
  // mismatch`. Callers may hand in a cfg that never went through loadConfig -- every
  // test does -- so the floor lives here as well as there.
  const cap = Math.max(1, Math.floor(cfg.briefRecentIds));
  // Same format store.js writes, so a lexicographic compare is a chronological one.
  const cutoff = new Date(now - cfg.briefRecentMinutes * 60000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  // One row past the cap is the cheap overflow probe.
  const rows = repo
    ? db
        .prepare(`
          SELECT DISTINCT n.id AS id, n.updated AS updated
            FROM nodes n
            LEFT JOIN node_repos r ON r.node_id = n.id
           WHERE n.archived = 0 AND n.updated >= ? AND (n.scope = 'global' OR r.repo = ?)
           ORDER BY n.updated DESC, n.id
           LIMIT ?
        `)
        .all(cutoff, repo, cap + 1)
    : db
        .prepare(`
          SELECT id, updated FROM nodes
           WHERE archived = 0 AND updated >= ? ORDER BY updated DESC, id
           LIMIT ?
        `)
        .all(cutoff, cap + 1);

  if (rows.length <= cap) return { ids: rows.map((r) => r.id), omitted: 0 };

  // The exact count is only worth a second query when there is something to report.
  const total = repo
    ? db
        .prepare(`
          SELECT COUNT(DISTINCT n.id) AS c
            FROM nodes n
            LEFT JOIN node_repos r ON r.node_id = n.id
           WHERE n.archived = 0 AND n.updated >= ? AND (n.scope = 'global' OR r.repo = ?)
        `)
        .get(cutoff, repo).c
    : db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE archived = 0 AND updated >= ?').get(cutoff).c;
  return { ids: rows.slice(0, cap).map((r) => r.id), omitted: total - cap };
}

/**
 * Tier 2 of the capture pipeline: what `remember` reads before it composes.
 *
 * The mirror of `buildTree`, scoped for a writer rather than a reader. Without it the
 * skill composes blind, and blind composition has three failure modes this answers
 * directly: it rewords a note that already exists (dedup is by exact content hash, so
 * a paraphrase becomes a second node), it invents an `edges[].dst` id that never
 * connects because a missing dst is legal, and it cannot see which type the store is
 * missing at the one moment it is about to write something.
 *
 * One call, inside a turn that was already paid for. That economy is why the brief is
 * a command the skill runs rather than anything loaded standing — and it matters more
 * on Copilot, where a second round trip is a second premium request.
 *
 * The list is `buildTree`'s, deliberately: two answers to "which notes speak for this
 * repo" in one tool would be a bug the reader could see.
 */
export function buildBrief(db, { repo, cwd = process.cwd(), cfg = loadConfig(), gap, now = Date.now() } = {}) {
  const here = repo === undefined ? currentRepo(cwd) : repo;
  const g = gap !== undefined ? gap : here ? captureGap(db, { cwd, cfg, repo: here }) : null;
  const tree = buildTree(db, { repo: here, cfg });
  const counts = typeCounts(db, here);
  const recent = recentlyCaptured(db, here, cfg, now);

  return {
    repo: here,
    gap: g,
    tree,
    counts: Object.fromEntries(counts),
    missing: NOTE_TYPES.filter((t) => counts.get(t) === 0),
    recent: recent.ids,
    recentOmitted: recent.omitted,
    recentMinutes: cfg.briefRecentMinutes,
    total: tree.total,
  };
}

export function renderBrief(result) {
  const { repo, gap, tree, counts, missing, recent, recentOmitted, recentMinutes } = result;
  const scope = repo ? safeRepo(repo) : 'all repos';

  // The header carries the same signal the remember description does, at the same
  // moment it is being acted on. A brief that opens with a note count while the repo
  // has moved 300 commits since anyone wrote anything is burying its own headline.
  // Composed from the gap fields rather than reusing \`gap.note\` verbatim: that string
  // names the repo, and the header already has, so borrowing it stutters.
  const state = !repo
    ? `${tree.total} notes in the store`
    : gap?.note && gap.notes === 0
      ? `nothing captured here yet, over ${gap.commits} commits of history`
      : gap?.note
        ? `${gap.commits} commits since anything was captured here`
        : `${tree.total} note${tree.total === 1 ? '' : 's'} here, capture is current`;
  const out = [`# capture brief: ${scope} — ${state}`];

  if (tree.lines.length) {
    out.push('', 'already known here — write the gap, not these');
    const width = tree.lines.reduce((w, e) => Math.max(w, e.id.length), 0);
    for (const e of tree.lines) {
      out.push(`${e.type.padEnd(10)} ${e.id.padEnd(width)}  ${e.title}${e.archived ? ' (archived)' : ''}`);
    }
    // Never silent. A truncated list that reads as the whole store is how a duplicate
    // gets written against a note that was there the entire time.
    if (tree.omitted.length) {
      out.push(`${tree.omitted.length} more not shown, run agent-memory tree --all`);
    }
    out.push('', 'These ids are real. Use them as an `edges[].dst` or `supersedes` target;');
    out.push('an id you invent is accepted and then never connects to anything.');
  }

  if (missing.length) {
    out.push('', 'nothing captured yet in these types');
    const width = missing.reduce((w, t) => Math.max(w, t.length), 0);
    for (const t of missing) out.push(`  ${t.padEnd(width)}  ${TYPE_HINT[t]}`);
  }

  const present = Object.entries(counts).filter(([, c]) => c > 0);
  if (present.length) {
    out.push('', `counts: ${present.map(([t, c]) => `${t} ${c}`).join(', ')}`);
  }

  if (recent.length) {
    // Written as the reason rather than the rule, because the rule is already in the
    // skill and the model is being asked to apply it, not to learn it again.
    // Bounded, and it says so. A bulk write or import stamps every note with the same
    // minute; printing all of them would spend the context this brief exists to
    // conserve, while reading as the whole list -- the exact failure the tree refuses.
    const more = recentOmitted ? ` (+${recentOmitted} more)` : '';
    out.push(
      '',
      `captured in the last ${recentMinutes} minutes, so already covered: ${recent.join(', ')}${more}`,
    );
  }

  if (!tree.lines.length && !recent.length) {
    out.push('', 'The store holds nothing for this repository yet. Anything durable is new.');
  }
  return out.join('\n');
}
