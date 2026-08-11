import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, parse as parsePath } from 'node:path';
import { homedir } from 'node:os';
import { atomicWrite } from './atomic.js';

// The store lives outside every repository on purpose. That is what makes a note
// written in one window readable from a window opened on a different project.
export const STORE_BASE =
  process.env.AGENT_MEMORY_HOME ||
  join(process.env.USERPROFILE || homedir(), '.agents', 'memory');

export const DEFAULT_ENGAGEMENT = 'default';

/** Where the pointer to the active engagement lives, outside every engagement. */
export const ENGAGEMENT_POINTER = join(STORE_BASE, '.engagement');

/** Engagement names become directory names, so they have to be safe as one. */
export const ENGAGEMENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The file a client tree carries to pin itself to an engagement. */
export const ENGAGEMENT_MARKER = '.agent-memory-engagement';

/**
 * Which engagement this process is working in, and how that was decided.
 *
 * A consultant runs several clients through one machine, and knowledge from one is
 * not the next one's to see. The boundary is a separate store per engagement rather
 * than a column to filter on, because filtering has to be remembered at every read
 * and there are fourteen of them; two were already missed. A separate directory
 * cannot be forgotten, and purging one is a directory removal that can be shown to
 * have happened.
 *
 * The marker file is what makes this survive real use: drop one at the root of a
 * client's tree and every repository beneath it is in that engagement, with nothing
 * to remember when switching windows.
 */
export function resolveEngagement(cwd = process.cwd()) {
  const env = process.env.AGENT_MEMORY_ENGAGEMENT?.trim();
  if (env) return { name: env, source: 'AGENT_MEMORY_ENGAGEMENT' };

  let dir = cwd;
  for (;;) {
    const marker = join(dir, ENGAGEMENT_MARKER);
    if (existsSync(marker)) {
      try {
        const name = readFileSync(marker, 'utf8').trim().split('\n')[0].trim();
        if (name) return { name, source: marker };
      } catch {
        // An unreadable marker is not a reason to fall back silently to another
        // client's store. Treat it as unset and let the pointer or default decide.
      }
    }
    const parent = dirname(dir);
    if (parent === dir || dir === parsePath(dir).root) break;
    dir = parent;
  }

  if (existsSync(ENGAGEMENT_POINTER)) {
    try {
      const name = readFileSync(ENGAGEMENT_POINTER, 'utf8').trim();
      if (name) return { name, source: ENGAGEMENT_POINTER };
    } catch {
      /* fall through to the default */
    }
  }
  return { name: DEFAULT_ENGAGEMENT, source: 'default' };
}

/** The store directory for an engagement. The default one is the base itself. */
export function engagementRoot(name) {
  return name === DEFAULT_ENGAGEMENT ? STORE_BASE : join(STORE_BASE, 'engagements', name);
}

export const ENGAGEMENT = resolveEngagement();

// Resolved once per process, like everything else here. One process, one answer.
export const STORE_ROOT = engagementRoot(ENGAGEMENT.name);

export const NOTE_TYPES = ['system', 'decision', 'convention', 'constraint'];

export const paths = {
  root: STORE_ROOT,
  notes: join(STORE_ROOT, 'notes'),
  archive: join(STORE_ROOT, 'notes', 'archive'),
  db: join(STORE_ROOT, 'index.db'),
  routing: join(STORE_ROOT, 'ROUTING.md'),
  config: join(STORE_ROOT, 'config.json'),
  // Machine-scoped keys live beside every engagement rather than inside one.
  machineConfig: join(STORE_BASE, 'config.json'),
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
  captureGapCommits: 50, // repo movement with no capture at all before it is worth saying
  compactThreshold: 10, // node-count delta that triggers an automatic compact
};

// Written by the installer: every SKILL.md whose description compact regenerates.
// The store cannot discover these on its own, because a skill may be symlinked
// from a checkout or copied into place, and both are legitimate installs.
export const LIST_KEYS = ['skillPaths'];

/** A malformed config must not take the store down. Absent and unreadable are equal. */
function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Config comes from two files, split by what each key actually describes.
 *
 * Where the skills are installed is a fact about this machine. Every engagement
 * shares one set of skill files, so registering them per engagement meant `compact`
 * had nothing to regenerate after a switch and the recall description kept
 * advertising the previous engagement's topics — into the agent's context, which is
 * the worst place for it. Caps like the digest size really are per-store, and stay
 * there. For the default engagement both files are the same path and nothing moves.
 */
export function loadConfig() {
  const merged = { ...DEFAULTS, skillPaths: [] };

  for (const [k, v] of Object.entries(readJson(paths.config))) {
    if (k in DEFAULTS && typeof v === 'number' && Number.isFinite(v) && v > 0) merged[k] = v;
  }
  const machine = readJson(paths.machineConfig);
  for (const k of LIST_KEYS) {
    if (Array.isArray(machine[k])) {
      merged[k] = machine[k].filter((s) => typeof s === 'string' && s.trim());
    }
  }
  return merged;
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
  const sameFile = paths.config === paths.machineConfig;
  const caps = readJson(paths.config);
  const machine = sameFile ? caps : readJson(paths.machineConfig);

  let capsDirty = false;
  let machineDirty = false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in DEFAULTS && typeof v === 'number' && Number.isFinite(v) && v > 0) {
      caps[k] = v;
      capsDirty = true;
    }
    if (LIST_KEYS.includes(k) && Array.isArray(v)) {
      machine[k] = [...new Set(v.filter((s) => typeof s === 'string' && s.trim()))].sort();
      machineDirty = true;
    }
  }

  if (sameFile) {
    if (capsDirty || machineDirty) {
      mkdirSync(dirname(paths.config), { recursive: true });
      atomicWrite(paths.config, `${JSON.stringify(caps, null, 2)}\n`);
    }
    return { ...caps };
  }
  if (capsDirty) {
    mkdirSync(dirname(paths.config), { recursive: true });
    atomicWrite(paths.config, `${JSON.stringify(caps, null, 2)}\n`);
  }
  if (machineDirty) {
    mkdirSync(dirname(paths.machineConfig), { recursive: true });
    atomicWrite(paths.machineConfig, `${JSON.stringify(machine, null, 2)}\n`);
  }
  return { ...caps, ...Object.fromEntries(LIST_KEYS.map((k) => [k, machine[k]]).filter(([, v]) => v)) };
}
