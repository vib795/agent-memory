import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { loadConfig } from './config.js';

/**
 * Staleness detection.
 *
 * A `system` note claiming "auth uses JWT" after the code moved to sessions is
 * worse than no memory at all, because it misleads with confidence. This module
 * cannot prevent that. What it does is make the age of a note visible at the exact
 * moment the note is being used, which is the only moment anyone can act on it.
 *
 * Deterministic, no model involved, no scheduled job: just a commit count.
 */

const cache = new Map();

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  }).trim();
}

/** Repository name for the working directory, or null when not inside one. */
export function currentRepo(cwd = process.cwd()) {
  const key = `repo\0${cwd}`;
  if (cache.has(key)) return cache.get(key);
  let repo = null;
  try {
    repo = basename(git(['rev-parse', '--show-toplevel'], cwd));
  } catch {
    repo = null;
  }
  cache.set(key, repo);
  return repo;
}

/**
 * How many commits have landed since `sha`.
 *
 * Reachability is checked first so that a rebased or pruned commit reports
 * `unreachable` instead of surfacing a git error to someone who only asked a
 * question about their own codebase.
 */
export function commitsSince(sha, cwd = process.cwd()) {
  if (!sha) return { status: 'no-sha' };
  const key = `count\0${cwd}\0${sha}`;
  if (cache.has(key)) return cache.get(key);

  let result;
  try {
    git(['rev-parse', '--git-dir'], cwd);
  } catch (err) {
    result = { status: err.code === 'ENOENT' ? 'no-git' : 'no-repo' };
    cache.set(key, result);
    return result;
  }

  try {
    git(['cat-file', '-e', `${sha}^{commit}`], cwd);
  } catch {
    result = { status: 'unreachable' };
    cache.set(key, result);
    return result;
  }

  try {
    const count = Number.parseInt(git(['rev-list', '--count', `${sha}..HEAD`], cwd), 10);
    result = Number.isFinite(count) ? { status: 'ok', count } : { status: 'unreachable' };
  } catch {
    // Reachable but not countable: HEAD may be unborn on a fresh repository.
    result = { status: 'unreachable' };
  }
  cache.set(key, result);
  return result;
}

/**
 * The annotation for a node, or null when there is nothing worth saying.
 *
 * Only annotates when the current repository is one the note claims, because a
 * commit count taken against unrelated history is noise dressed as a signal. A note
 * scoped to another project is left alone rather than flagged as rewritten.
 */
export function annotate(node, { cwd = process.cwd(), cfg = loadConfig(), repo } = {}) {
  if (!node?.captured_sha) return null;
  const here = repo ?? currentRepo(cwd);
  if (!here) return null;
  if (Array.isArray(node.repos) && node.repos.length && !node.repos.includes(here)) return null;

  const res = commitsSince(node.captured_sha, cwd);
  if (res.status === 'unreachable') return 'history rewritten, verify';
  if (res.status !== 'ok') return null;
  if (res.count < cfg.staleAnnotateCommits) return null;
  return `captured ${res.count} commits ago — verify before trusting`;
}

/** The same signal in structured form, for `--json` consumers. */
export function staleness(node, opts = {}) {
  const note = annotate(node, opts);
  if (!note) return null;
  const res = commitsSince(node.captured_sha, opts.cwd ?? process.cwd());
  return {
    status: res.status === 'ok' ? 'stale' : 'rewritten',
    commits: res.status === 'ok' ? res.count : null,
    note,
  };
}

/**
 * Nodes far enough behind to be worth a deliberate review, for `doctor`.
 *
 * Annotation happens where knowledge is used; this list exists so an operator can
 * also go looking, rather than waiting to be told one note at a time.
 */
export function reviewCandidates(db, { cwd = process.cwd(), cfg = loadConfig() } = {}) {
  const here = currentRepo(cwd);
  if (!here) return [];

  const rows = db
    .prepare(`
      SELECT id, type, title, captured_sha
        FROM nodes
       WHERE archived = 0 AND captured_sha IS NOT NULL
       ORDER BY id
    `)
    .all();

  const repoStmt = db.prepare('SELECT repo FROM node_repos WHERE node_id = ?');
  const out = [];
  for (const row of rows) {
    const repos = repoStmt.all(row.id).map((r) => r.repo);
    if (repos.length && !repos.includes(here)) continue;

    const res = commitsSince(row.captured_sha, cwd);
    if (res.status === 'unreachable') {
      out.push({ ...row, reason: 'history rewritten', commits: null });
    } else if (res.status === 'ok' && res.count >= cfg.staleReviewCommits) {
      out.push({ ...row, reason: 'far behind HEAD', commits: res.count });
    }
  }
  return out;
}

/** Testing seam: the per-process cache would otherwise outlive a fixture repo. */
export function resetCache() {
  cache.clear();
}
