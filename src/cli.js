#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig, saveConfig, paths, NOTE_TYPES } from './config.js';
import { ensureStore, writeNote, normalizeTitle, listNotes } from './store.js';
import {
  openDb, reindex, searchNodes, getNodeRow, markAccessed, nodeCount, hasFts,
} from './index-db.js';
import { neighborhood, applyBudget } from './graph.js';
import { buildTree, renderTree, buildDigest } from './digest.js';
import { compact, maybeCompact } from './compact.js';
import { staleness, currentRepo, reviewCandidates } from './staleness.js';
import { setup as runSetup, unlinkSkills, danglingSkillLinks, SKILLS } from './setup.js';
import { detectTargets, installableTargets } from './targets.js';
import { join } from 'node:path';

/**
 * One process, one answer.
 *
 * Every command completes in a single invocation with no daemon and no server,
 * because a background process is the first thing a locked-down desktop refuses to
 * run and the first thing that breaks after a reboot.
 */

const MIN_NODE = [22, 5];

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i++;
    }
  }
  return opts;
}

function num(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nodeVersionOk() {
  const [maj, min] = process.versions.node.split('.').map((s) => Number.parseInt(s, 10));
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
}

function git(args, cwd = process.cwd()) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

const USAGE = `agent-memory — durable cross-repo knowledge for coding agents

  setup                                  link all three skills, build the store
                                         (runs automatically on npm install)
  uninstall                              remove the skill links; keeps every note
  init [--skills "<p1>,<p2>"]            create the store; register skill files
  index                                  rebuild index.db from notes/
  tree [--repo <name>] [--all]           routing map, scoped to a repo
  get <id> [--depth N] [--budget N]      a note plus its neighborhood
           [--include-archived]
  search <terms> [--limit N]             full-text fallback when the tree misses
  write --from-json <file>               validated upsert; used by the skills
        [--source <name>] [--repo <name>]
  compact                                dedup, decay, reindex, regenerate
  doctor                                 preflight and health report

Add --json to any command for machine-readable output.
Store: ${paths.root}`;

// --- commands ---------------------------------------------------------------

function cmdInit(opts) {
  ensureStore();

  // Registered before the compact below, so the very first run already writes the
  // digest into each skill description rather than leaving it as a placeholder.
  let registered = [];
  if (typeof opts.skills === 'string') {
    const existing = loadConfig().skillPaths || [];
    const incoming = opts.skills.split(',').map((s) => s.trim()).filter(Boolean);
    registered = [...new Set([...existing, ...incoming])];
    saveConfig({ skillPaths: registered });
  }

  const db = openDb();
  const result = compact({ db });
  db.close();
  return {
    ok: true,
    store: paths.root,
    notes: result.indexed,
    skills: registered,
    digest: result.digest,
    text: [
      `Store ready at ${paths.root}`,
      `${result.indexed} notes indexed.`,
      ...registered.map((s) => `registered skill ${s}`),
    ].join('\n'),
  };
}

/**
 * Link the skills into both agents and build the store.
 *
 * Runs automatically from npm postinstall, but exists as a command because managed
 * npm configurations often set `ignore-scripts=true`, which skips postinstall with
 * no warning. When that happens the recovery is one command rather than hunting for
 * a shell script inside a global node_modules directory.
 */
function cmdSetup() {
  ensureStore();
  const r = runSetup({ compactFn: () => compact() });

  const lines = [];
  for (const t of r.targets) {
    lines.push(`  ${t.label}`);
    for (const s of r.installed.filter((i) => i.target === t.id)) {
      lines.push(`    [${s.mode}] ${s.path}`);
    }
  }

  // Detected but not written to. Saying so is the point: silence would read as
  // "supported" for a tool we deliberately skipped.
  const skipped = detectTargets().filter((t) => t.kind === 'unsupported');
  if (skipped.length) {
    lines.push('', '  Detected but not installable:');
    for (const t of skipped) lines.push(`    ${t.label} — ${t.note}`);
  }
  if (r.copies.length) {
    lines.push(
      '',
      '  Some skills were copied rather than linked, which happens on a network-backed',
      '  profile. Re-run `agent-memory setup` after upgrading to refresh them.',
    );
  }

  return {
    ok: true,
    ...r,
    text: [
      `Installed for ${r.targets.length} agent${r.targets.length === 1 ? '' : 's'}:`,
      ...lines,
      '',
      `Store ready at ${paths.root} (${r.notes} notes).`,
      'Restart your editor, then try /recall, /remember or /handoff.',
    ].join('\n'),
  };
}

/**
 * Remove the skill links, leaving every note in place.
 *
 * Runs from npm's preuninstall hook so that `npm uninstall -g` does not leave links
 * pointing into a deleted package. The store is deliberately untouched: it is plain
 * markdown, it is the user's own writing, and it stays readable with no tooling.
 */
function cmdUninstall() {
  const r = unlinkSkills();
  return {
    ok: true,
    ...r,
    store: paths.root,
    text: [
      ...r.removed.map((p) => `  [removed] ${p}`),
      ...r.kept.map((p) => `  [kept]    ${p} (not ours)`),
      r.removed.length ? '' : 'No skill links found.',
      `Your notes are untouched at ${paths.root}.`,
      'They are plain markdown and stay readable with nothing installed.',
    ].filter(Boolean).join('\n'),
  };
}

function cmdIndex() {
  const db = openDb({ reindexOnCreate: false });
  const r = reindex(db);
  db.close();
  const warnings = [
    ...r.malformed.map((m) => `unparseable: ${m.path} (${m.error})`),
    ...r.duplicates.map((d) => `duplicate id ${d.id}: kept ${d.kept}, ignored ${d.dropped}`),
  ];
  return {
    ok: r.malformed.length === 0,
    indexed: r.indexed,
    warnings,
    text: [`${r.indexed} notes indexed.`, ...warnings].join('\n'),
  };
}

function cmdTree(opts) {
  const cfg = loadConfig();
  const db = openDb();
  const repo = opts.repo === true ? null : (opts.repo ?? currentRepo());
  const result = buildTree(db, { repo, all: !!opts.all, cfg });
  db.close();
  return { ok: true, ...result, text: renderTree(result) };
}

function cmdGet(opts) {
  const cfg = loadConfig();
  const id = opts._[0];
  if (!id) return { ok: false, error: 'get requires a node id', text: 'get requires a node id' };

  const db = openDb();
  const includeArchived = !!opts['include-archived'];
  // Looked up permissively so that an archived node can be reported as archived.
  // Without this the traversal below would silently prune the root and return an
  // empty result that reads exactly like "this note does not exist".
  const root = getNodeRow(db, id, { includeArchived: true });
  if (root?.archived && !includeArchived) {
    db.close();
    return {
      ok: false,
      error: `${id} is archived`,
      archived: true,
      text: `${id} is archived (superseded, merged, or decayed).\nRetrieve it with: agent-memory get ${id} --include-archived`,
    };
  }
  if (!root) {
    // A miss is a routing failure, not a dead end. Offer what search would find.
    const near = searchNodes(db, id, { limit: 5 }).map((n) => ({ id: n.id, title: n.title }));
    db.close();
    return {
      ok: false,
      error: `no note with id ${id}`,
      suggestions: near,
      text: [`No note with id ${id}.`, ...near.map((n) => `  did you mean ${n.id} — ${n.title}`)].join('\n'),
    };
  }

  const depth = num(opts.depth, 1);
  const budget = num(opts.budget, cfg.getBudgetBytes);
  const hood = neighborhood(db, id, { depth, includeArchived });
  const { kept, omitted, overBudget, bytes } = applyBudget(hood, budget);

  markAccessed(db, kept.map((n) => n.id));
  const cwd = process.cwd();
  const repo = currentRepo(cwd);
  const nodes = kept.map((n) => ({ ...n, stale: staleness(n, { cwd, cfg, repo }) }));
  db.close();

  const lines = [];
  for (const n of nodes) {
    const note = n.stale ? `  [${n.stale.note}]` : '';
    lines.push(`## ${n.id}  [${n.type}]  depth ${n.depth}${note}`);
    lines.push(n.title);
    lines.push('');
    lines.push(n.body);
    if (n.edges.length) lines.push('', ...n.edges.map((e) => `  -> ${e.rel} ${e.dst}`));
    lines.push('');
  }
  if (omitted.length) {
    lines.push(`${omitted.length} nodes omitted for budget: ${omitted.map((o) => o.id).join(', ')}`);
    lines.push('Ask for one by id with: agent-memory get <id>');
  }
  if (overBudget) {
    lines.push(
      `Note: ${bytes} bytes returned, over the ${budget} budget, because constraints are never dropped.`,
    );
  }
  return { ok: true, root: id, depth, bytes, nodes, omitted, overBudget, text: lines.join('\n') };
}

function cmdSearch(opts) {
  const terms = opts._.join(' ');
  const db = openDb();
  const hits = searchNodes(db, terms, {
    limit: num(opts.limit, 10),
    includeArchived: !!opts['include-archived'],
  });
  db.close();
  return {
    ok: true,
    query: terms,
    hits: hits.map((n) => ({ id: n.id, type: n.type, title: n.title })),
    text: hits.length
      ? hits.map((n) => `${n.type.padEnd(10)} ${n.id}  ${n.title}`).join('\n')
      : `No match for ${JSON.stringify(terms)}.`,
  };
}

function readNodesFrom(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.nodes)) return raw.nodes;
  return [raw];
}

function cmdWrite(opts) {
  const file = opts['from-json'];
  if (!file || file === true || !existsSync(file)) {
    return {
      ok: false,
      error: 'write requires --from-json <file>',
      text: 'write requires --from-json <file>',
    };
  }

  const cfg = loadConfig();
  const cwd = process.cwd();
  const repo = opts.repo === true ? currentRepo(cwd) : (opts.repo ?? currentRepo(cwd));
  const sha = git(['rev-parse', 'HEAD'], cwd);
  const selfEmail = git(['config', 'user.email'], cwd) || '';

  let incoming;
  try {
    incoming = readNodesFrom(file);
  } catch (err) {
    return {
      ok: false,
      error: `unreadable JSON: ${err.message}`,
      text: `Unreadable JSON: ${err.message}`,
    };
  }

  const db = openDb();
  const before = nodeCount(db, { includeArchived: true });

  // Normalized titles of what already exists, so two agents naming one thing two
  // different ways surface as a collision instead of quietly becoming two nodes.
  const titles = new Map();
  for (const row of db.prepare('SELECT id, title, content_hash FROM nodes').all()) {
    titles.set(normalizeTitle(row.title), { id: row.id, hash: row.content_hash });
  }

  const written = [];
  const failed = [];
  const warnings = [];
  for (const raw of incoming) {
    const node = { ...raw };
    node.source = node.source || (opts.source === true ? undefined : opts.source) || 'manual';
    if (repo && !node.repos?.length && node.scope !== 'global') node.repos = [repo];
    // A commit sha only means something for a note about this repository.
    if (!node.captured_sha && sha && repo && (node.repos || []).includes(repo)) {
      node.captured_sha = sha;
    }

    const collision = titles.get(normalizeTitle(node.title));
    try {
      const res = writeNote(node, { selfEmail });
      if (collision && collision.id !== res.node.id) {
        warnings.push(
          `title collision: ${res.node.id} reads the same as existing ${collision.id}; ` +
            'set contradicts or merge them',
        );
      }
      written.push({
        id: res.node.id,
        type: res.node.type,
        created: res.created,
        redacted: res.findings,
      });
      if (res.findings.length) {
        warnings.push(
          `${res.node.id}: redacted ${res.findings.map((f) => `${f.count}x ${f.kind}`).join(', ')}`,
        );
      }
    } catch (err) {
      failed.push({ id: raw?.id ?? null, errors: err.errors ?? [err.message] });
    }
  }

  reindex(db);
  const after = nodeCount(db, { includeArchived: true });
  const compacted = maybeCompact(db, before, after, cfg);
  db.close();

  const text = [
    ...written.map((w) => `${w.created ? 'created' : 'updated'} ${w.id} [${w.type}]`),
    ...warnings.map((w) => `warning: ${w}`),
    ...failed.map((f) => `failed ${f.id ?? '<no id>'}: ${f.errors.join('; ')}`),
    written.length ? '' : 'No nodes written.',
    compacted ? `compacted: ${compacted.indexed} notes indexed` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { ok: failed.length === 0, written, failed, warnings, compacted: !!compacted, text };
}

function cmdCompact() {
  const r = compact();
  const text = [
    `${r.indexed} notes indexed.`,
    ...r.merged.map((m) => `merged ${m.id} into ${m.into}`),
    ...r.superseded.map((s) => `archived ${s.id}, superseded by ${s.by}`),
    ...r.decayed.map((d) => `archived ${d.id}, last seen ${d.lastSeen}`),
    ...r.malformed.map((m) => `warning: unparseable ${m.path}`),
    `digest ${r.digestChars} chars`,
    ...r.skills.map((s) => `updated description in ${s}`),
  ].join('\n');
  return { ok: true, ...r, text };
}

function cmdDoctor() {
  const cfg = loadConfig();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('node version', nodeVersionOk(), `${process.versions.node} (need >= ${MIN_NODE.join('.')})`);
  if (!nodeVersionOk()) {
    return {
      ok: false,
      checks,
      text:
        `FAIL node version: ${process.versions.node}, need >= ${MIN_NODE.join('.')}.\n` +
        'node:sqlite ships in Node core from 22.5 onward; there is no dependency to install.',
    };
  }

  ensureStore();
  add('store path', existsSync(paths.root), paths.root);

  const db = openDb();
  const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
  add('index integrity', integrity === 'ok', String(integrity));
  add('fts5', hasFts(), hasFts() ? 'available' : 'unavailable, search falls back to LIKE');

  const notes = listNotes();
  const malformed = notes.filter((n) => n.__error);
  add(
    'notes parse',
    malformed.length === 0,
    malformed.length ? malformed.map((m) => m.path).join(', ') : `${notes.length} notes`,
  );

  const active = nodeCount(db);
  const counts = NOTE_TYPES.map(
    (t) => `${t} ${db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE archived = 0 AND type = ?').get(t).c}`,
  ).join(', ');
  add('active notes', true, `${active} (${counts})`);

  const digest = buildDigest(db, { cfg });
  add('digest within cap', digest.length <= cfg.digestChars, `${digest.length}/${cfg.digestChars} chars`);

  const registered = cfg.skillPaths || [];
  const missing = registered.filter((p) => !existsSync(p));
  add(
    'skills linked',
    registered.length > 0 && missing.length === 0,
    // Name what is broken. Listing the paths that resolve while reporting a failure
    // sends the reader to look at the one file that is fine.
    registered.length === 0
      ? 'none registered; run `agent-memory setup`'
      : missing.length
        ? `${missing.join(', ')} no longer exists — run \`agent-memory setup\``
        : registered.join(', '),
  );

  // Which agents are actually on this machine, so a user who installed and saw
  // nothing can tell "we did not find your editor" from "your editor ignored us".
  const agents = detectTargets();
  add(
    'agents detected',
    agents.some((t) => t.kind !== 'unsupported'),
    agents.map((t) => `${t.label}${t.kind === 'unsupported' ? ' (skipped)' : ''}`).join('; '),
  );

  // Detection is not installation, and conflating them is how this tool reports
  // healthy while doing nothing. npm gates postinstall scripts behind allow-scripts,
  // and managed profiles set ignore-scripts=true; in both cases the CLI lands on PATH
  // and every agent directory stays empty, while every other check here still passes.
  // So verify the files, per agent, rather than trusting that setup ever ran.
  const gaps = [];
  for (const t of installableTargets()) {
    const absent = SKILLS.filter((name) =>
      t.kind === 'skill-dir'
        ? !existsSync(join(t.dir, name, 'SKILL.md'))
        : !existsSync(join(t.dir, `${name}.prompt.md`)),
    );
    if (absent.length) gaps.push(`${t.label}: ${absent.join(', ')}`);
  }
  add(
    'skills installed',
    gaps.length === 0,
    gaps.length
      ? `${gaps.join('; ')} — run \`agent-memory setup\``
      : `${SKILLS.length} in each of ${installableTargets().length} agents`,
  );

  const dangling = danglingSkillLinks();
  add(
    'no broken skill links',
    dangling.length === 0,
    dangling.length
      ? `${dangling.join(', ')} — leftovers from an uninstall; remove them or run \`agent-memory setup\``
      : 'none',
  );

  const stale = reviewCandidates(db, { cfg });
  add(
    'staleness',
    stale.length === 0,
    stale.length ? `${stale.length} notes worth reviewing` : 'nothing far behind HEAD',
  );
  db.close();

  const text = [
    ...checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`),
    ...stale.map(
      (s) => `     review ${s.id} — ${s.reason}${s.commits === null ? '' : ` (${s.commits} commits)`}`,
    ),
  ].join('\n');

  // Staleness is a report, not a failure. Being told about it is the whole feature.
  const advisory = new Set(['staleness', 'skills linked']);
  const fatal = checks.filter((c) => !c.ok && !advisory.has(c.name));
  return { ok: fatal.length === 0, checks, stale, digest, text };
}

// --- dispatch ---------------------------------------------------------------

const COMMANDS = {
  setup: cmdSetup,
  uninstall: cmdUninstall,
  init: cmdInit,
  index: cmdIndex,
  tree: cmdTree,
  get: cmdGet,
  search: cmdSearch,
  write: cmdWrite,
  compact: cmdCompact,
  doctor: cmdDoctor,
};

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    process.stderr.write(`Unknown command ${JSON.stringify(cmd)}.\n\n${USAGE}\n`);
    return 2;
  }
  // doctor is exempt: reporting the wrong Node version is precisely its job.
  if (cmd !== 'doctor' && !nodeVersionOk()) {
    process.stderr.write(
      `Node ${process.versions.node} is too old; agent-memory needs >= ${MIN_NODE.join('.')} for node:sqlite.\n`,
    );
    return 1;
  }

  const opts = parseArgs(rest);
  let result;
  try {
    result = fn(opts);
  } catch (err) {
    result = { ok: false, error: err.message, text: `Error: ${err.message}` };
  }

  if (opts.json) {
    const { text: _text, ...payload } = result;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const out = result.text ?? JSON.stringify(result, null, 2);
    (result.ok === false ? process.stderr : process.stdout).write(`${out}\n`);
  }
  return result.ok === false ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
