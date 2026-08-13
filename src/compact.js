import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { loadConfig, paths } from './config.js';
import { listNotes, archiveNote, contentHash, nowIso, serializeNote } from './store.js';
import { atomicWrite } from './atomic.js';
import { openDb, reindex } from './index-db.js';
import { buildDigest, buildTree, renderTree } from './digest.js';

/**
 * Compaction is pure code. No model is involved, and none should be.
 *
 * Everything here is a rule an operator can predict and check by hand: identical
 * content merges, superseded knowledge steps aside, unread and unreferenced notes
 * move to the archive. Because it needs no model, it never needs a schedule and
 * never costs a premium request.
 */

function ageDays(iso, now) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 86400000 : Infinity;
}

function unionEdges(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const e of list || []) {
      if (e?.rel && e?.dst) seen.set(`${e.rel} ${e.dst}`, { rel: e.rel, dst: e.dst });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.dst < b.dst ? -1 : 1,
  );
}

/** Rewrite a note in place, preserving `updated`. Graph repair, not an edit. */
function rewrite(node) {
  atomicWrite(node.path, serializeNote(node));
}

/**
 * Merge notes whose content is identical.
 *
 * The keeper is the earliest `created`, because the first capture is the one other
 * notes are most likely to already point at. Timestamps are second-precision, so two
 * notes captured in the same turn tie routinely; the tie goes to whichever node more
 * things already reference, which is the same rationale stated directly rather than
 * approximated by a timestamp. Id is the last resort, purely for determinism.
 *
 * Repos and edges are unioned so nothing a duplicate knew is lost, and inbound edges
 * are repointed at the keeper so the merge leaves no dangling reference behind.
 */
function dedupe(active) {
  const inbound = new Map();
  for (const n of active) {
    for (const e of n.edges || []) inbound.set(e.dst, (inbound.get(e.dst) || 0) + 1);
  }

  const groups = new Map();
  for (const n of active) {
    const h = contentHash(n);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(n);
  }

  const merged = [];
  const remap = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(
      (a, b) =>
        (a.created || '').localeCompare(b.created || '') ||
        (inbound.get(b.id) || 0) - (inbound.get(a.id) || 0) ||
        a.id.localeCompare(b.id),
    );
    const [keeper, ...dups] = group;
    keeper.repos = [
      ...new Set([...(keeper.repos || []), ...dups.flatMap((d) => d.repos || [])]),
    ].sort();
    keeper.edges = unionEdges(keeper.edges, ...dups.map((d) => d.edges))
      // A merged node must not end up pointing at an id it just absorbed.
      .filter((e) => !dups.some((d) => d.id === e.dst));
    rewrite(keeper);

    for (const d of dups) {
      archiveNote(d.type, d.id);
      remap.set(d.id, keeper.id);
      merged.push({ id: d.id, into: keeper.id });
    }
  }

  // Repoint every edge that referenced an absorbed id.
  if (remap.size) {
    for (const n of active) {
      if (remap.has(n.id)) continue;
      const before = JSON.stringify(n.edges || []);
      n.edges = unionEdges(
        (n.edges || []).map((e) => ({ rel: e.rel, dst: remap.get(e.dst) || e.dst })),
      ).filter((e) => e.dst !== n.id);
      if (JSON.stringify(n.edges) !== before) rewrite(n);
    }
  }
  return merged;
}

/**
 * A node that supersedes another archives it.
 *
 * The superseded note keeps its edges and stays reachable through
 * `get --include-archived`, because "we used to do it this way and stopped" is
 * often the exact thing someone needs six months later.
 */
function collapseSupersedes(active) {
  const byId = new Map(active.map((n) => [n.id, n]));
  const archived = [];
  for (const n of active) {
    if (!n.supersedes) continue;
    const old = byId.get(n.supersedes);
    if (!old || old.archived) continue;
    if (archiveNote(old.type, old.id)) {
      old.archived = 1;
      archived.push({ id: old.id, by: n.id });
    }
  }
  return archived;
}

/**
 * Archive notes nobody points at and nobody has read in `decayDays`.
 *
 * Inbound edges are the exemption: a note other notes depend on is load-bearing
 * whether or not anyone has opened it recently.
 */
function decay(active, cfg, now) {
  const referenced = new Set(active.flatMap((n) => (n.edges || []).map((e) => e.dst)));
  const archived = [];
  for (const n of active) {
    if (n.archived || referenced.has(n.id)) continue;
    const last = n.accessed || n.updated || n.created;
    if (ageDays(last, now) < cfg.decayDays) continue;
    if (archiveNote(n.type, n.id)) archived.push({ id: n.id, lastSeen: last });
  }
  return archived;
}

/**
 * Rewrite the `description:` line of an installed skill.
 *
 * This is the whole Tier-1 mechanism. An agent decides whether to invoke a skill by
 * reading its description, so regenerating that line is how the store advertises
 * what it now knows without costing anything at chat time.
 */
// The directory this package was installed into. `setup` links skill directories at
// `<package>/skills/<name>`, so every description write lands in the package's own
// files. That is correct for an installed package and wrong for a git checkout, where
// those files are tracked: one developer's digest gets committed and then published to
// everyone. It shipped that way for twenty releases, advertising one machine's five
// notes to every user who installed the plugin.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Is this path inside the package's own git checkout?
 *
 * Resolved through `realpathSync` because the path arrives as a symlink planted by
 * `setup`; the link sits outside the checkout even when its target is inside it, which
 * is the whole reason this went unnoticed. The `.git` test separates a developer's
 * working tree from an ordinary install, which has no `.git` and must keep being
 * written to — that write is the Tier-1 mechanism, not a bug.
 */
export function insideCheckout(file) {
  if (!existsSync(join(PACKAGE_ROOT, '.git'))) return false;
  let real;
  let root;
  try {
    real = realpathSync(file);
    root = realpathSync(PACKAGE_ROOT);
  } catch {
    return false;
  }
  if (root.endsWith(sep)) root = root.slice(0, -1);
  return real === root || real.startsWith(root + sep);
}

export function writeSkillDescription(skillPath, description) {
  if (!existsSync(skillPath)) return false;
  if (insideCheckout(skillPath)) return false;
  const src = readFileSync(skillPath, 'utf8');
  if (!src.startsWith('---')) return false;
  const end = src.indexOf('\n---', 3);
  if (end === -1) return false;

  const head = src.slice(0, end);
  const rest = src.slice(end);
  // JSON quoting is valid YAML double-quoting, and the digest contains colons and
  // commas that would otherwise break the frontmatter.
  const line = `description: ${JSON.stringify(description)}`;
  const updated = /^description:.*$/m.test(head)
    ? head.replace(/^description:.*$/m, line)
    : `${head}\n${line}`;

  atomicWrite(skillPath, updated + rest);
  return true;
}

/** Regenerate everything derived: ROUTING.md and each installed skill description. */
function regenerate(db, cfg) {
  const digest = buildDigest(db, { cfg });
  const tree = buildTree(db, { all: true, cfg });

  const routing = [
    '<!-- Generated by `agent-memory compact`. Edits here are overwritten. -->',
    '',
    digest,
    '',
    renderTree(tree),
    '',
  ].join('\n');
  atomicWrite(paths.routing, routing);

  const skills = [];
  const skipped = [];
  for (const p of cfg.skillPaths || []) {
    // Reported, never swallowed. A description that silently did not update reads
    // exactly like one that did, and this is the line that routes every recall.
    if (insideCheckout(p)) {
      skipped.push(p);
      continue;
    }
    if (writeSkillDescription(p, digest)) skills.push(p);
  }
  return { digest, digestChars: digest.length, routing: paths.routing, skills, skipped };
}

/**
 * Dedup, collapse, decay, reindex, regenerate.
 *
 * Order matters: dedup before supersede collapse, because a merge can be what makes
 * two supersede chains agree; decay last, because both steps before it change which
 * nodes have inbound edges.
 */
export function compact({ cfg = loadConfig(), now = Date.now(), db: existing = null } = {}) {
  const db = existing || openDb({ reindexOnCreate: false });
  const all = listNotes();
  const malformed = all.filter((n) => n.__error).map((n) => ({ path: n.path, error: n.__error }));
  const active = all.filter((n) => !n.__error && !n.archived && n.id);

  const merged = dedupe(active);
  const mergedIds = new Set(merged.map((m) => m.id));
  const remaining = active.filter((n) => !mergedIds.has(n.id));

  const superseded = collapseSupersedes(remaining);
  const supersededIds = new Set(superseded.map((s) => s.id));

  const decayed = decay(remaining.filter((n) => !supersededIds.has(n.id)), cfg, now);

  const indexed = reindex(db);
  const derived = regenerate(db, cfg);
  if (!existing) db.close();

  return {
    at: nowIso(),
    merged,
    superseded,
    decayed,
    malformed,
    indexed: indexed.indexed,
    duplicateIds: indexed.duplicates,
    ...derived,
  };
}

/**
 * Compact automatically when the store has changed enough to be worth it.
 *
 * Runs on install and after a write that moves the node count past the threshold,
 * so compaction never needs a scheduler, a daemon, or a model. Anything that needed
 * one of those would not survive a locked-down desktop.
 */
export function maybeCompact(db, before, after, cfg = loadConfig()) {
  if (Math.abs(after - before) < cfg.compactThreshold) return null;
  return compact({ cfg, db });
}
