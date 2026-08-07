import { DatabaseSync } from 'node:sqlite';
import { relative, sep } from 'node:path';
import { paths } from './config.js';
import { ensureStore, listNotes, contentHash, nowIso, touchNoteAccessed } from './store.js';

/**
 * The index is a cache, never a source of truth.
 *
 * Every row here is derived from a markdown note. Deleting index.db and running
 * `agent-memory index` must reproduce identical query output, which is what makes
 * it safe to throw the database away when anything looks wrong.
 */

// 2: nodes_fts gained the porter stemmer. Bumping rebuilds the index on next open,
// which costs nothing to get wrong because it is derived entirely from the markdown.
const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('system','decision','convention','constraint')),
  title        TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('repo','global')),
  confidence   TEXT NOT NULL CHECK (confidence IN ('observed','inferred')),
  source       TEXT,
  body         TEXT NOT NULL,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  captured_sha TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  created      TEXT NOT NULL,
  updated      TEXT NOT NULL,
  accessed     TEXT
);

CREATE TABLE IF NOT EXISTS node_repos (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  repo    TEXT NOT NULL,
  PRIMARY KEY (node_id, repo)
);

CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst TEXT NOT NULL,
  rel TEXT NOT NULL CHECK (rel IN ('depends-on','applies-to','supersedes','contradicts','evidence-for')),
  PRIMARY KEY (src, dst, rel)
);

CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS idx_node_repos_repo ON node_repos(repo);

-- The porter stemmer is what lets a question find a note. Without it "secrets"
-- misses "secret" and "written" misses "write", which is precisely the mismatch
-- natural questions produce, and asking questions is the entire use case.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
  USING fts5(title, body, content='nodes', content_rowid='rowid',
             tokenize='porter unicode61');
`;

const DROP = `
DROP TABLE IF EXISTS nodes_fts;
DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS node_repos;
DROP TABLE IF EXISTS nodes;
`;

/** Flipped off once we learn this build of node:sqlite lacks FTS5. */
let ftsAvailable = true;

/**
 * Open the index, creating or rebuilding it as needed.
 *
 * A schema version mismatch rebuilds from notes/ rather than migrating. Migrating
 * a cache is work with no payoff when the source of truth is sitting right there.
 */
export function openDb({ reindexOnCreate = true } = {}) {
  ensureStore();
  const db = new DatabaseSync(paths.db);
  // busy_timeout must come first. Every pragma below can contend with another VS
  // Code window, and until the timeout is set they fail instantly on SQLITE_BUSY
  // rather than waiting. Two windows open at once is the normal working mode here.
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    // WAL lets a reader in one window proceed while another window writes. It is a
    // persistent property of the file, so losing this race is harmless: whichever
    // process won already set it, and this connection inherits the result.
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    /* already WAL, or another connection is mid-switch */
  }
  db.exec('PRAGMA foreign_keys = ON');

  const version = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (version !== SCHEMA_VERSION) {
    db.exec(DROP);
    createSchema(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    if (reindexOnCreate) reindex(db);
  }
  return db;
}

function createSchema(db) {
  try {
    db.exec(DDL);
  } catch (err) {
    // A build without FTS5 still gets a working graph; only search degrades.
    if (!/fts5/i.test(String(err.message))) throw err;
    ftsAvailable = false;
    db.exec(DDL.slice(0, DDL.indexOf('CREATE VIRTUAL TABLE')));
  }
}

/** Store paths relative and slash-separated so the index is not machine-shaped. */
function relPath(abs) {
  return relative(paths.root, abs).split(sep).join('/');
}

/**
 * Rebuild every row from notes/. Idempotent by construction: it truncates first.
 *
 * Notes are sorted by id before insert so two rebuilds of the same store produce
 * the same rowids, which is what keeps `search` result order stable.
 */
export function reindex(db) {
  const all = listNotes();
  const malformed = all.filter((n) => n.__error).map((n) => ({ path: n.path, error: n.__error }));

  const good = all
    .filter((n) => !n.__error && typeof n.id === 'string' && n.id)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.path < b.path ? -1 : 1));

  const seen = new Map();
  const duplicates = [];
  const rows = [];
  for (const n of good) {
    if (seen.has(n.id)) {
      // Two files claiming one id. Keep the first by sort order and say so, rather
      // than letting INSERT OR REPLACE quietly pick a winner.
      duplicates.push({ id: n.id, kept: relPath(seen.get(n.id).path), dropped: relPath(n.path) });
      continue;
    }
    seen.set(n.id, n);
    rows.push(n);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM nodes');
    db.exec('DELETE FROM node_repos');
    db.exec('DELETE FROM edges');

    const insNode = db.prepare(`
      INSERT INTO nodes (id, type, title, scope, confidence, source, body, path,
                         content_hash, captured_sha, archived, created, updated, accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insRepo = db.prepare('INSERT OR IGNORE INTO node_repos (node_id, repo) VALUES (?, ?)');
    const insEdge = db.prepare('INSERT OR IGNORE INTO edges (src, dst, rel) VALUES (?, ?, ?)');

    for (const n of rows) {
      const ts = n.created || nowIso();
      insNode.run(
        n.id,
        n.type,
        n.title ?? '',
        n.scope || (n.repos?.length ? 'repo' : 'global'),
        n.confidence || 'observed',
        n.source ?? null,
        n.body ?? '',
        relPath(n.path),
        contentHash(n),
        n.captured_sha ?? null,
        n.archived ? 1 : 0,
        ts,
        n.updated || ts,
        n.accessed ?? null,
      );
      for (const repo of n.repos || []) insRepo.run(n.id, repo);
      for (const e of n.edges || []) insEdge.run(n.id, e.dst, e.rel);
    }

    if (ftsAvailable) {
      try {
        db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
      } catch {
        ftsAvailable = false;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { indexed: rows.length, malformed, duplicates };
}

export function hasFts() {
  return ftsAvailable;
}

export function nodeCount(db, { includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT COUNT(*) AS c FROM nodes'
    : 'SELECT COUNT(*) AS c FROM nodes WHERE archived = 0';
  return db.prepare(sql).get().c;
}

/** Attach repos, outbound edges and inbound edges to a bare node row. */
export function hydrate(db, row) {
  if (!row) return null;
  row.repos = db
    .prepare('SELECT repo FROM node_repos WHERE node_id = ? ORDER BY repo')
    .all(row.id)
    .map((r) => r.repo);
  row.edges = db.prepare('SELECT rel, dst FROM edges WHERE src = ? ORDER BY rel, dst').all(row.id);
  row.inbound = db.prepare('SELECT rel, src FROM edges WHERE dst = ? ORDER BY rel, src').all(row.id);
  return row;
}

export function getNodeRow(db, id, { includeArchived = true } = {}) {
  const row = db
    .prepare('SELECT * FROM nodes WHERE id = ? AND (? = 1 OR archived = 0)')
    .get(id, includeArchived ? 1 : 0);
  return hydrate(db, row);
}

/**
 * Full-text search, with a LIKE fallback.
 *
 * The fallback covers two real cases: a Node build without FTS5, and a query whose
 * punctuation is ordinary English but invalid FTS5 syntax. Returning worse results
 * beats returning a syntax error to someone who just asked a question.
 */
export function searchNodes(db, terms, { limit = 10, includeArchived = false } = {}) {
  const q = String(terms ?? '').trim();
  if (!q) return [];
  const arch = includeArchived ? 1 : 0;

  if (ftsAvailable) {
    const stmt = db.prepare(`
      SELECT n.*, bm25(nodes_fts) AS rank
        FROM nodes_fts
        JOIN nodes n ON n.rowid = nodes_fts.rowid
       WHERE nodes_fts MATCH ?
         AND (? = 1 OR n.archived = 0)
       ORDER BY rank, n.id
       LIMIT ?
    `);
    try {
      // Every term first, which is precise when the caller knows the vocabulary.
      // Then any term, because people ask questions rather than name keywords, and
      // "why did we avoid a native build step" shares only three words with the note
      // that answers it. Requiring all of them means a question never matches.
      // bm25 does the discriminating: rare words outrank "why" and "we" on their own.
      for (const mode of ['all', 'any']) {
        const expr = ftsQuery(q, mode);
        if (!expr) break;
        const rows = stmt.all(expr, arch, limit);
        if (rows.length) return rows.map((r) => hydrate(db, r));
      }
      return [];
    } catch {
      // Fall through to LIKE rather than surfacing an FTS5 error to the caller.
    }
  }

  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  return db
    .prepare(`
      SELECT * FROM nodes
       WHERE (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
         AND (? = 1 OR archived = 0)
       ORDER BY id
       LIMIT ?
    `)
    .all(like, like, arch, limit)
    .map((r) => hydrate(db, r));
}

/**
 * Quote each term so user punctuation cannot be read as an FTS5 operator.
 *
 * 'all' joins with a space, which FTS5 reads as AND. 'any' joins with OR.
 * Returns null when there is nothing to search for, so the caller can stop.
 */
function ftsQuery(q, mode = 'all') {
  const terms = q.match(/[\p{L}\p{N}_]+/gu) || [];
  if (!terms.length) return null;
  const quoted = terms.map((t) => `"${t}"`);
  return mode === 'any' ? quoted.join(' OR ') : quoted.join(' ');
}

/**
 * Record that these nodes were read.
 *
 * Written through to the markdown as well, because decay reads `accessed` and the
 * index can be deleted at any time. Skipped when the stored date is already today,
 * so a read-heavy session does not rewrite the same file over and over.
 */
export function markAccessed(db, ids) {
  const ts = nowIso();
  const today = ts.slice(0, 10);
  const touched = [];
  const upd = db.prepare('UPDATE nodes SET accessed = ? WHERE id = ?');
  const sel = db.prepare('SELECT type, accessed, archived FROM nodes WHERE id = ?');
  for (const id of ids) {
    const row = sel.get(id);
    if (!row) continue;
    if (typeof row.accessed === 'string' && row.accessed.slice(0, 10) === today) continue;
    upd.run(ts, id);
    if (touchNoteAccessed(row.type, id, ts, !!row.archived)) touched.push(id);
  }
  return touched;
}
