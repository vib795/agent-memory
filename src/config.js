import { readFileSync, existsSync } from 'node:fs';
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

export function loadConfig() {
  if (!existsSync(paths.config)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(paths.config, 'utf8'));
    const merged = { ...DEFAULTS };
    for (const [k, v] of Object.entries(raw)) {
      if (k in DEFAULTS && typeof v === 'number' && Number.isFinite(v) && v > 0) merged[k] = v;
    }
    return merged;
  } catch {
    // A malformed config must not take the store down. Defaults are always valid.
    return { ...DEFAULTS };
  }
}
