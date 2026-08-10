import { loadConfig } from './config.js';

/**
 * Two-tier routing.
 *
 * Tier 1 is the `recall` skill's description, which is loaded into every chat
 * whether or not memory is ever used. It is standing cost, so it has to read like
 * a description rather than a document.
 *
 * Tier 2 is the tree, printed only when `recall` actually fires. Per-invocation
 * cost, paid once, and only when someone is already looking something up.
 *
 * Neither tier costs a premium request. A request is charged per prompt, not per
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
    return 'Durable project knowledge store, currently empty. Run /remember to capture the first note.';
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
    .map((r) => r.repo);

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
  const scope = result.repo ? result.repo : 'all repos';
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
