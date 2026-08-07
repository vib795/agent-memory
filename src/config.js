import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// The store lives outside every repository on purpose. That is what makes a note
// written in one window readable from a window opened on a different project.
export const STORE_ROOT =
  process.env.AGENT_MEMORY_HOME ||
  join(process.env.USERPROFILE || homedir(), '.agents', 'memory');

export const NOTE_TYPES = ['system', 'decision', 'convention', 'constraint'];

export const paths = {
  root: STORE_ROOT,
  notes: join(STORE_ROOT, 'notes'),
  archive: join(STORE_ROOT, 'notes', 'archive'),
  db: join(STORE_ROOT, 'index.db'),
  routing: join(STORE_ROOT, 'ROUTING.md'),
  config: join(STORE_ROOT, 'config.json'),
  typeDir: (type) => join(STORE_ROOT, 'notes', type),
  archiveTypeDir: (type) => join(STORE_ROOT, 'notes', 'archive', type),
};

// Every cap in the spec is tunable. These defaults are judgment calls, not limits
// derived from anything, so they belong in config rather than frozen in code.
export const DEFAULTS = {
  digestChars: 400, // standing context cost, loaded on every chat
  treeLines: 80, // per-invocation cost, paid only when recall fires
  getBudgetBytes: 8192, // ceiling on note bodies returned by a single get
  decayDays: 90, // archive threshold for unreferenced, unread notes
  staleAnnotateCommits: 10, // below this, staleness is not worth mentioning
  staleReviewCommits: 100, // above this, doctor flags it for review
  compactThreshold: 10, // node-count delta that triggers an automatic compact
};

// Written by the installer: every SKILL.md whose description compact regenerates.
// The store cannot discover these on its own, because a skill may be symlinked
// from a checkout or copied into place, and both are legitimate installs.
export const LIST_KEYS = ['skillPaths'];

export function loadConfig() {
  if (!existsSync(paths.config)) return { ...DEFAULTS, skillPaths: [] };
  try {
    const raw = JSON.parse(readFileSync(paths.config, 'utf8'));
    const merged = { ...DEFAULTS, skillPaths: [] };
    for (const [k, v] of Object.entries(raw)) {
      if (k in DEFAULTS && typeof v === 'number' && Number.isFinite(v) && v > 0) merged[k] = v;
      if (LIST_KEYS.includes(k) && Array.isArray(v)) {
        merged[k] = v.filter((s) => typeof s === 'string' && s.trim());
      }
    }
    return merged;
  } catch {
    // A malformed config must not take the store down. Defaults are always valid.
    return { ...DEFAULTS, skillPaths: [] };
  }
}

/**
 * Merge a patch into config.json.
 *
 * Lives here rather than in the install scripts so that bash and PowerShell do not
 * each grow their own JSON merge, which is exactly the kind of duplication that
 * drifts and only shows up on the machine you cannot test from.
 *
 * Only keys that already mean something are persisted, so a typo in an installer
 * cannot quietly become permanent state.
 */
export function saveConfig(patch) {
  const current = existsSync(paths.config)
    ? (() => {
        try {
          return JSON.parse(readFileSync(paths.config, 'utf8'));
        } catch {
          return {};
        }
      })()
    : {};

  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in DEFAULTS && typeof v === 'number' && Number.isFinite(v) && v > 0) next[k] = v;
    if (LIST_KEYS.includes(k) && Array.isArray(v)) {
      next[k] = [...new Set(v.filter((s) => typeof s === 'string' && s.trim()))].sort();
    }
  }

  const tmp = `${paths.config}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, paths.config);
  return next;
}
