import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync,
  symlinkSync,
} from 'node:fs';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'agent-memory-int-'));
process.env.AGENT_MEMORY_HOME = ROOT;
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

const { writeNote, listNotes, notePath, readNote } = await import('../src/store.js');
const idx = await import('../src/index-db.js');
const { searchNodes } = idx;
const { neighborhood, applyBudget } = await import('../src/graph.js');
const { buildTree, buildDigest, renderTree } = await import('../src/digest.js');
const { compact, writeSkillDescription } = await import('../src/compact.js');
const stale = await import('../src/staleness.js');
const { setup, unlinkSkills, danglingSkillLinks, skillTargets, packagedSkillsDir, SKILLS } =
  await import('../src/setup.js');
const { vscodeUserDir, codexHome } = await import('../src/targets.js');
const { isGenerated } = await import('../src/promptfile.js');
const { atomicWrite, tempName } = await import('../src/atomic.js');
const { paths, DEFAULTS, loadConfig, saveConfig } = await import('../src/config.js');

/** The fixture graph, rebuilt from scratch by every test that needs a clean one. */
function seed() {
  rmSync(paths.notes, { recursive: true, force: true });
  for (const f of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`]) rmSync(f, { force: true });
  // Deregister every skill path. The setup tests legitimately register the packaged
  // SKILL.md, which in a checkout is the real repo file, and a later compact would
  // then rewrite it with fixture data. A suite that mutates its own repo is a bug.
  saveConfig({ skillPaths: [] });
  writeNote({
    id: 'auth-service', type: 'system', title: 'Auth uses server sessions',
    body: 'Opaque tokens, not JWT. See src/auth/session.js:42.',
    repos: ['repo-a'],
    edges: [{ rel: 'depends-on', dst: 'postgres-primary' }, { rel: 'contradicts', dst: 'use-jwt' }],
  });
  writeNote({
    id: 'use-jwt', type: 'decision', title: 'Rejected JWT for sessions',
    body: 'x'.repeat(4000), repos: ['repo-a'],
    edges: [{ rel: 'contradicts', dst: 'auth-service' }],
  });
  writeNote({
    id: 'postgres-primary', type: 'system', title: 'Primary Postgres',
    body: 'y'.repeat(4000), repos: ['repo-a'],
    edges: [{ rel: 'applies-to', dst: 'auth-service' }],
  });
  writeNote({
    id: 'no-external-db', type: 'constraint', title: 'No externally hosted databases',
    body: 'z'.repeat(4000), repos: [], scope: 'global',
    edges: [{ rel: 'applies-to', dst: 'postgres-primary' }],
  });
  return idx.openDb();
}

// --- index and traversal ------------------------------------------------------

test('reindex is idempotent and reports nothing malformed', () => {
  const db = seed();
  assert.equal(idx.reindex(db).indexed, 4);
  assert.equal(idx.reindex(db).indexed, 4);
  assert.deepEqual(idx.reindex(db).malformed, []);
  db.close();
});

test('a malformed note does not blind the rest of the index', () => {
  const db = seed();
  const broken = join(paths.typeDir('system'), 'broken.md');
  writeFileSync(broken, 'no frontmatter here', 'utf8');
  const r = idx.reindex(db);
  assert.equal(r.indexed, 4, 'the four good notes still index');
  assert.equal(r.malformed.length, 1);
  rmSync(broken, { force: true });
  db.close();
});

test('traversal reaches each depth and stops where told', () => {
  const db = seed();
  assert.deepEqual(
    neighborhood(db, 'auth-service', { depth: 1 }).map((n) => n.id).sort(),
    ['auth-service', 'postgres-primary', 'use-jwt'],
  );
  assert.ok(
    neighborhood(db, 'auth-service', { depth: 2 }).map((n) => n.id).includes('no-external-db'),
  );
  db.close();
});

test('a contradicts cycle terminates and never repeats a node', () => {
  const db = seed();
  const ids = neighborhood(db, 'auth-service', { depth: 3 }).map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'auth-service');
  db.close();
});

test('a node reachable at two depths is reported at the shorter one', () => {
  const db = seed();
  const hood = neighborhood(db, 'auth-service', { depth: 3 });
  assert.equal(hood.find((n) => n.id === 'postgres-primary').depth, 1);
  db.close();
});

test('an orphan node returns only itself', () => {
  const db = seed();
  writeNote({ id: 'orphan', type: 'convention', title: 'Lone note', body: 'No edges.', repos: ['repo-a'] });
  idx.reindex(db);
  assert.deepEqual(neighborhood(db, 'orphan', { depth: 3 }).map((n) => n.id), ['orphan']);
  db.close();
});

test('deleting the index and rebuilding reproduces identical output', () => {
  const db = seed();
  const snapshot = (d) =>
    JSON.stringify({
      hood: neighborhood(d, 'auth-service', { depth: 3 }),
      tree: buildTree(d, { all: true }),
      search: idx.searchNodes(d, 'sessions'),
    });
  const before = snapshot(db);
  db.close();
  for (const f of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`]) rmSync(f, { force: true });
  const db2 = idx.openDb();
  assert.equal(before, snapshot(db2));
  db2.close();
});

// --- search quality ------------------------------------------------------------

test('a natural-language question finds the note that answers it', () => {
  const db = seed();
  // FTS5 reads a space as AND, so requiring every word means a real question never
  // matches: this one shares three words with the note that answers it.
  const hits = searchNodes(db, 'why did we not use JWT for sessions?');
  assert.ok(hits.length, 'a question with stopwords still finds something');
  // Both JWT notes are legitimate answers, so pinning an exact winner would be
  // asserting a bm25 tie-break rather than anything about retrieval quality.
  assert.ok(
    ['auth-service', 'use-jwt'].includes(hits[0].id),
    `top hit was ${hits[0].id}, expected one of the two notes about JWT`,
  );
  db.close();
});

test('search stems, so plurals and verb forms match', () => {
  const db = seed();
  writeNote({
    id: 'token-rotation', type: 'convention', title: 'Rotating a signing token',
    body: 'The token is rotated quarterly by the platform team.', repos: ['repo-a'],
  });
  idx.reindex(db);
  for (const q of ['tokens', 'rotate', 'rotations']) {
    assert.ok(
      searchNodes(db, q).some((n) => n.id === 'token-rotation'),
      `${JSON.stringify(q)} should reach a note saying "token" and "rotated"`,
    );
  }
  db.close();
});

test('a genuine miss still reports a miss', () => {
  const db = seed();
  // The OR fallback must not turn every query into a match against everything.
  assert.deepEqual(searchNodes(db, 'kubernetes helm chart rollout'), []);
  db.close();
});

// --- retrieval budget ----------------------------------------------------------

test('budget prunes by depth then degree, keeps the root and every constraint', () => {
  const db = seed();
  const hood = neighborhood(db, 'auth-service', { depth: 3 });
  const { kept, omitted, overBudget } = applyBudget(hood, 2000);
  const ids = kept.map((n) => n.id);
  assert.ok(ids.includes('auth-service'), 'root is never dropped');
  assert.ok(ids.includes('no-external-db'), 'a constraint is never dropped');
  assert.ok(omitted.length > 0);
  assert.ok(omitted.every((o) => typeof o.id === 'string'), 'omitted ids are always named');
  assert.equal(overBudget, true, 'going over is reported rather than hidden');
  db.close();
});

test('budget is a no-op when everything fits', () => {
  const db = seed();
  const hood = neighborhood(db, 'auth-service', { depth: 1 });
  const r = applyBudget(hood, 1_000_000);
  assert.equal(r.omitted.length, 0);
  assert.equal(r.kept.length, hood.length);
  db.close();
});

// --- tree and digest -----------------------------------------------------------

test('repo scoping returns that repo plus global notes and nothing else', () => {
  const db = seed();
  writeNote({ id: 'other-repo-note', type: 'system', title: 'Elsewhere', body: 'b', repos: ['repo-b'] });
  idx.reindex(db);
  const ids = buildTree(db, { repo: 'repo-a', all: true }).lines.map((l) => l.id);
  assert.ok(ids.includes('auth-service'));
  assert.ok(ids.includes('no-external-db'), 'a global constraint applies here too');
  assert.ok(!ids.includes('other-repo-note'));
  db.close();
});

test('tree truncation keeps constraints, drops low-degree notes, and says how many', () => {
  const db = seed();
  for (let i = 0; i < 20; i++) {
    writeNote({ id: `filler-${i}`, type: 'system', title: `Filler ${i}`, body: 'b', repos: ['repo-a'] });
  }
  idx.reindex(db);
  const cfg = { ...DEFAULTS, treeLines: 8 };
  const r = buildTree(db, { repo: 'repo-a', cfg });
  assert.equal(r.truncated, true);
  assert.ok(r.lines.some((l) => l.type === 'constraint'), 'constraints survive any cap');
  assert.ok(r.omitted.length > 0);
  assert.match(renderTree(r), /nodes not shown, run agent-memory tree --all/);
  assert.equal(buildTree(db, { repo: 'repo-a', all: true, cfg }).omitted.length, 0);
  db.close();
});

test('digest stays within the cap and always keeps the routing clause', () => {
  const db = seed();
  const cfg = { ...DEFAULTS, digestChars: 200 };
  const d = buildDigest(db, { cfg });
  assert.ok(d.length <= 200, `digest was ${d.length} chars`);
  assert.match(d, /Use when you need to know/);
  assert.match(d, /1 constraint/, 'the constraint count is never dropped');
  db.close();
});

test('digest of an empty store says so instead of pretending', () => {
  rmSync(paths.notes, { recursive: true, force: true });
  for (const f of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`]) rmSync(f, { force: true });
  const db = idx.openDb();
  assert.match(buildDigest(db), /currently empty/);
  db.close();
});

// --- write path ----------------------------------------------------------------

test('writing an existing id updates in place rather than adding a note', () => {
  const db = seed();
  const first = writeNote({
    id: 'auth-service', type: 'system', title: 'Auth uses server sessions',
    body: 'Changed.', repos: ['repo-b'],
  });
  assert.equal(first.created, false, 'an existing id is an update, not a create');
  idx.reindex(db);
  assert.equal(idx.nodeCount(db, { includeArchived: true }), 4);
  assert.deepEqual(idx.getNodeRow(db, 'auth-service').repos, ['repo-b']);
  db.close();
});

test('a secret never reaches disk, not even once', () => {
  const db = seed();
  const res = writeNote({
    id: 'leaky', type: 'system', title: 'Connection details',
    body: 'postgres://admin:hunter2@db.example.com:5432/app', repos: ['repo-a'],
  });
  assert.ok(res.findings.some((f) => f.kind === 'connection-string'));
  const onDisk = readFileSync(notePath('system', 'leaky'), 'utf8');
  assert.ok(!onDisk.includes('hunter2'));
  assert.ok(onDisk.includes('<redacted:connection-string>'));
  assert.ok(!existsSync(`${notePath('system', 'leaky')}.tmp`), 'no temp file is left behind');
  db.close();
});

// --- compaction ----------------------------------------------------------------

test('identical content merges, unions repos, and repoints inbound edges', () => {
  seed().close();
  writeNote({
    id: 'auth-copy', type: 'system', title: 'Auth uses server sessions',
    body: 'Opaque tokens, not JWT. See src/auth/session.js:42.', repos: ['repo-b'],
  });
  writeNote({
    id: 'points-at-copy', type: 'convention', title: 'Points at the copy',
    body: 'b', repos: ['repo-a'], edges: [{ rel: 'depends-on', dst: 'auth-copy' }],
  });

  const r = compact();
  assert.equal(r.merged.length, 1);
  assert.equal(r.merged[0].into, 'auth-service');
  assert.ok(readNote('system', 'auth-copy', true), 'the duplicate is archived, never deleted');
  assert.deepEqual(readNote('system', 'auth-service').repos, ['repo-a', 'repo-b']);
  assert.deepEqual(
    readNote('convention', 'points-at-copy').edges,
    [{ rel: 'depends-on', dst: 'auth-service' }],
    'an inbound edge follows the merge instead of dangling',
  );
});

test('a superseded node is archived but stays reachable', () => {
  seed().close();
  writeNote({
    id: 'use-sessions', type: 'decision', title: 'Chose sessions',
    body: 'Why: immediate revocation. Rejected: JWT.', repos: ['repo-a'], supersedes: 'use-jwt',
  });

  const r = compact();
  assert.ok(r.superseded.some((s) => s.id === 'use-jwt' && s.by === 'use-sessions'));
  assert.equal(readNote('decision', 'use-jwt'), null, 'gone from active');
  const archived = readNote('decision', 'use-jwt', true);
  assert.ok(archived, 'still on disk');
  assert.equal(archived.edges.length, 1, 'it keeps its edges');

  const db = idx.openDb();
  assert.ok(
    neighborhood(db, 'auth-service', { depth: 1, includeArchived: true }).some((n) => n.id === 'use-jwt'),
  );
  assert.ok(!neighborhood(db, 'auth-service', { depth: 1 }).some((n) => n.id === 'use-jwt'));
  db.close();
});

test('decay archives the unread and unreferenced, and spares the referenced', () => {
  seed().close();
  writeNote({ id: 'forgotten', type: 'convention', title: 'Nobody reads this', body: 'b', repos: ['repo-a'] });

  // 100 days on, with decayDays at its default of 90.
  const r = compact({ now: Date.now() + 100 * 86400000 });
  assert.ok(r.decayed.some((d) => d.id === 'forgotten'));
  assert.ok(!r.decayed.some((d) => d.id === 'postgres-primary'), 'inbound edges exempt a node');
  assert.ok(readNote('convention', 'forgotten', true), 'archived, not deleted');
});

test('compact regenerates ROUTING.md and the registered skill description', () => {
  seed().close();
  const skill = join(ROOT, 'FAKE_SKILL.md');
  writeFileSync(skill, '---\nname: recall\ndescription: placeholder\n---\n\n# body\n', 'utf8');

  const r = compact({ cfg: { ...DEFAULTS, skillPaths: [skill] } });
  assert.deepEqual(r.skills, [skill]);
  const written = readFileSync(skill, 'utf8');
  assert.ok(written.includes(`description: ${JSON.stringify(r.digest)}`));
  assert.ok(written.includes('# body'), 'the body below the frontmatter is untouched');
  assert.ok(existsSync(paths.routing));
  assert.ok(readFileSync(paths.routing, 'utf8').includes('auth-service'));
});

test('writeSkillDescription refuses a file without frontmatter', () => {
  const plain = join(ROOT, 'PLAIN.md');
  writeFileSync(plain, '# no frontmatter\n', 'utf8');
  assert.equal(writeSkillDescription(plain, 'x'), false);
  assert.equal(writeSkillDescription(join(ROOT, 'missing.md'), 'x'), false);
});

// --- staleness -----------------------------------------------------------------

test('commit counts, thresholds, and a rewritten history', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-memory-repo-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'one', 'utf8');
  git('add', '.');
  git('commit', '-qm', 'first');
  const first = git('rev-parse', 'HEAD');

  for (let i = 0; i < 12; i++) {
    writeFileSync(join(repo, 'a.txt'), `v${i}`, 'utf8');
    git('add', '.');
    git('commit', '-qm', `c${i}`);
  }

  stale.resetCache();
  // basename, not split('/'): mkdtemp hands back backslash paths on Windows.
  const name = basename(repo);
  assert.equal(stale.currentRepo(repo), name);
  assert.deepEqual(stale.commitsSince(first, repo), { status: 'ok', count: 12 });
  assert.equal(stale.commitsSince('deadbeefdeadbeef', repo).status, 'unreachable');

  assert.match(stale.annotate({ captured_sha: first, repos: [name] }, { cwd: repo }), /captured 12 commits ago/);
  assert.equal(
    stale.annotate({ captured_sha: git('rev-parse', 'HEAD'), repos: [name] }, { cwd: repo }),
    null,
    'zero commits behind is silent',
  );
  assert.equal(
    stale.annotate({ captured_sha: 'deadbeefdeadbeef', repos: [name] }, { cwd: repo }),
    'history rewritten, verify',
  );
  assert.equal(
    stale.annotate({ captured_sha: 'deadbeefdeadbeef', repos: ['some-other-repo'] }, { cwd: repo }),
    null,
    "another project's history is not ours to judge",
  );
  rmSync(repo, { recursive: true, force: true });
  stale.resetCache();
});

// --- concurrency ---------------------------------------------------------------

test('two concurrent writes both land, with no partial note left behind', async () => {
  seed().close();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (id) =>
    new Promise((resolve, reject) => {
      const file = join(ROOT, `${id}.json`);
      writeFileSync(
        file,
        JSON.stringify({ id, type: 'system', title: `Concurrent ${id}`, body: 'b', repos: ['repo-a'] }),
        'utf8',
      );
      execFile(
        process.execPath,
        [cli, 'write', '--from-json', file, '--json'],
        { env: { ...process.env, AGENT_MEMORY_HOME: ROOT } },
        // Surface stdout and stderr on failure. A bare exec error says only that the
        // process died, which is the least useful thing to learn about a race.
        (err, stdout, stderr) =>
          err ? reject(new Error(`${id} exited ${err.code}: ${stderr || stdout}`)) : resolve(stdout),
      );
    });

  await Promise.all([run('concurrent-a'), run('concurrent-b')]);
  const notes = listNotes();
  const ids = notes.filter((n) => !n.__error).map((n) => n.id);
  assert.ok(ids.includes('concurrent-a'));
  assert.ok(ids.includes('concurrent-b'));
  assert.equal(notes.filter((n) => n.__error).length, 0, 'no half-written note');
});

test('two ids describing the same thing warn, and the write still lands', async () => {
  seed().close();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const write = (node) =>
    new Promise((resolve, reject) => {
      const file = join(ROOT, `${node.id}.json`);
      writeFileSync(file, JSON.stringify(node), 'utf8');
      execFile(
        process.execPath,
        [cli, 'write', '--from-json', file, '--json'],
        { env: { ...process.env, AGENT_MEMORY_HOME: ROOT } },
        (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))),
      );
    });

  await write({ id: 'collide-a', type: 'system', title: 'Auth uses server sessions', body: 'first', repos: ['repo-a'] });
  // Content-hash dedup cannot catch two agents describing one thing in different
  // words. Normalized-title equality is what surfaces it.
  const second = await write({
    id: 'collide-b', type: 'system', title: 'auth uses server sessions!', body: 'second', repos: ['repo-a'],
  });

  assert.ok(second.warnings.some((w) => /title collision/.test(w) && /collide-a/.test(w)), JSON.stringify(second.warnings));
  assert.ok(readNote('system', 'collide-b'), 'the warning does not block the write');
});

// --- skill installation ---------------------------------------------------------

/** A home with the given agents "installed", so detection has something to find. */
function fakeHome({ claude = false, codex = false, vscode = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-memory-home-'));
  if (claude) mkdirSync(join(home, '.claude'), { recursive: true });
  if (codex) mkdirSync(join(home, '.codex'), { recursive: true });
  // Set the override before deriving the path: on Windows that is what stops the
  // VS Code location resolving to the real %APPDATA%.
  if (vscode) {
    process.env.AGENT_MEMORY_SKILLS_HOME = home;
    mkdirSync(vscodeUserDir('Code', home), { recursive: true });
  }
  process.env.AGENT_MEMORY_SKILLS_HOME = home;
  return home;
}

test('setup installs only where a tool is actually present', () => {
  seed().close();
  // A bare home has no agents but ours. Writing into ~/.claude here would be
  // inventing an install for a tool that is not on the machine.
  const bare = fakeHome();
  try {
    const r = setup({});
    assert.deepEqual(r.targets.map((t) => t.id), ['agents']);
    assert.equal(r.installed.length, SKILLS.length);
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    rmSync(bare, { recursive: true, force: true });
  }

  const both = fakeHome({ claude: true, codex: true });
  try {
    const r = setup({});
    assert.deepEqual(r.targets.map((t) => t.id).sort(), ['agents', 'claude-code', 'codex']);
    for (const dir of skillTargets()) {
      for (const name of SKILLS) {
        assert.ok(existsSync(join(dir, name, 'SKILL.md')), `${name} missing from ${dir}`);
      }
    }
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    rmSync(both, { recursive: true, force: true });
  }
});

test('CODEX_HOME is honoured, but never over an overridden home', () => {
  const home = '/nowhere/home';
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/custom/codex';
  try {
    // A real run follows CODEX_HOME, because that is where Codex actually keeps skills.
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    assert.equal(codexHome(home), '/custom/codex');

    // A test run must not: honouring it here would write into the real installation.
    process.env.AGENT_MEMORY_SKILLS_HOME = home;
    assert.equal(codexHome(home), join(home, '.codex'));
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test('a VS Code install gets prompt files, generated from the skills', () => {
  seed().close();
  const home = fakeHome({ vscode: true });
  try {
    const r = setup({});
    assert.ok(r.targets.some((t) => t.kind === 'prompt-dir'), 'VS Code was detected');

    const dir = r.targets.find((t) => t.kind === 'prompt-dir').dir;
    for (const name of SKILLS) {
      const file = join(dir, `${name}.prompt.md`);
      assert.ok(existsSync(file), `${name}.prompt.md missing`);
      const text = readFileSync(file, 'utf8');
      assert.match(text, /^---\nmode: agent\ndescription: "/, 'needs prompt-file frontmatter');
      assert.ok(isGenerated(text), 'must carry the marker uninstall looks for');
    }

    // The body is derived from SKILL.md rather than written twice.
    const recall = readFileSync(join(dir, 'recall.prompt.md'), 'utf8');
    assert.match(recall, /agent-memory tree/, 'the skill body came across');

    // compact must regenerate the prompt file description too, or Copilot keeps
    // routing on a placeholder while Claude Code sees the real digest.
    assert.ok(r.skillPaths.includes(join(dir, 'recall.prompt.md')));
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('setup registers recall and nothing else', () => {
  seed().close();
  const home = mkdtempSync(join(tmpdir(), 'agent-memory-home-'));
  process.env.AGENT_MEMORY_SKILLS_HOME = home;
  try {
    saveConfig({ skillPaths: [] });
    const r = setup({});
    // compact overwrites the description of every registered path. handoff and
    // remember describe themselves, so registering them would destroy both.
    assert.deepEqual(r.skillPaths, [join(packagedSkillsDir(), 'recall', 'SKILL.md')]);
    assert.ok(!JSON.stringify(loadConfig().skillPaths).includes('handoff'));
    assert.ok(!JSON.stringify(loadConfig().skillPaths).includes('remember'));
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('setup forgets a registered skill whose file is gone', () => {
  seed().close();
  const home = mkdtempSync(join(tmpdir(), 'agent-memory-home-'));
  process.env.AGENT_MEMORY_SKILLS_HOME = home;
  try {
    // Exactly what renaming or moving the checkout leaves behind. A union that never
    // prunes keeps it forever, and compact then writes to a path that is not there
    // while doctor reports a failure naming the path that is fine.
    const dead = join(home, 'moved-away', 'skills', 'recall', 'SKILL.md');
    saveConfig({ skillPaths: [dead] });

    setup({});
    const after = loadConfig().skillPaths;
    assert.ok(!after.includes(dead), `stale path survived: ${JSON.stringify(after)}`);
    assert.deepEqual(after, [join(packagedSkillsDir(), 'recall', 'SKILL.md')]);
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('setup is idempotent, and replacing a link never deletes the source', () => {
  seed().close();
  const home = mkdtempSync(join(tmpdir(), 'agent-memory-home-'));
  process.env.AGENT_MEMORY_SKILLS_HOME = home;
  try {
    setup({});
    setup({});
    setup({});
    for (const dir of skillTargets()) {
      for (const name of SKILLS) assert.ok(existsSync(join(dir, name, 'SKILL.md')));
    }
    // The real hazard: clearing a stale link must remove the link, not follow it and
    // empty the packaged skills on the other end.
    for (const name of SKILLS) {
      assert.ok(
        existsSync(join(packagedSkillsDir(), name, 'SKILL.md')),
        `packaged ${name} was destroyed by re-linking`,
      );
    }
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('setup replaces a plain directory left by an earlier copy install', () => {
  seed().close();
  const home = mkdtempSync(join(tmpdir(), 'agent-memory-home-'));
  process.env.AGENT_MEMORY_SKILLS_HOME = home;
  try {
    const dir = skillTargets()[0];
    mkdirSync(join(dir, 'recall'), { recursive: true });
    writeFileSync(join(dir, 'recall', 'SKILL.md'), 'stale copy', 'utf8');
    setup({});
    assert.notEqual(readFileSync(join(dir, 'recall', 'SKILL.md'), 'utf8'), 'stale copy');
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

// --- atomic writes ---------------------------------------------------------------

test('temp names are unique per call, so two writers cannot collide', () => {
  const a = tempName('/x/note.md');
  const b = tempName('/x/note.md');
  assert.notEqual(a, b);
  assert.ok(a.includes(String(process.pid)), 'the pid distinguishes processes');
  assert.ok(a.endsWith('.tmp'), 'still matches the *.tmp ignore rule');
});

test('atomicWrite replaces an existing file and leaves no residue', () => {
  const target = join(ROOT, 'atomic-target.txt');
  atomicWrite(target, 'first');
  atomicWrite(target, 'second');
  assert.equal(readFileSync(target, 'utf8'), 'second');
  assert.equal(
    readdirSync(ROOT).filter((f) => f.startsWith('atomic-target') && f.endsWith('.tmp')).length,
    0,
  );
});

test('concurrent writes to the SAME note leave it parseable, with no temp residue', async () => {
  seed().close();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  // The earlier concurrency test used different ids, which is why a shared
  // <target>.tmp survived it. Contending on one target is the case that matters.
  const run = (body) =>
    new Promise((resolve, reject) => {
      const file = join(ROOT, `same-${body}.json`);
      writeFileSync(
        file,
        JSON.stringify({ id: 'same-target', type: 'system', title: 'Contended note', body, repos: ['repo-a'] }),
        'utf8',
      );
      execFile(
        process.execPath,
        [cli, 'write', '--from-json', file, '--json'],
        { env: { ...process.env, AGENT_MEMORY_HOME: ROOT } },
        (err, stdout, stderr) =>
          err ? reject(new Error(`${body} exited ${err.code}: ${stderr || stdout}`)) : resolve(stdout),
      );
    });

  await Promise.all(['alpha', 'beta', 'gamma', 'delta'].map(run));

  const note = readNote('system', 'same-target');
  assert.ok(note, 'the note survived four simultaneous writers');
  assert.ok(['alpha', 'beta', 'gamma', 'delta'].includes(note.body), `body was ${JSON.stringify(note.body)}`);
  assert.equal(listNotes().filter((n) => n.__error).length, 0, 'nothing was left half-written');
  assert.equal(
    readdirSync(paths.typeDir('system')).filter((f) => f.endsWith('.tmp')).length,
    0,
    'no orphaned temp file',
  );
});

// --- archived retrieval ------------------------------------------------------------

test('get on an archived node says so rather than returning nothing', () => {
  seed().close();
  writeNote({
    id: 'replacement', type: 'decision', title: 'Replaces the old one',
    body: 'Why: better. Rejected: the old way.', repos: ['repo-a'], supersedes: 'use-jwt',
  });
  compact();

  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (args) => {
    const res = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, AGENT_MEMORY_HOME: ROOT },
      encoding: 'utf8',
    });
    return { status: res.status, out: res.stdout + res.stderr };
  };

  const plain = run(['get', 'use-jwt']);
  assert.notEqual(plain.status, 0, 'an archived node is not a silent empty success');
  assert.match(plain.out, /archived/);
  assert.match(plain.out, /--include-archived/, 'it names the flag that would work');

  const withFlag = run(['get', 'use-jwt', '--include-archived']);
  assert.equal(withFlag.status, 0);
  assert.match(withFlag.out, /Rejected JWT for sessions/, 'the body actually comes back');
});

// --- uninstall ---------------------------------------------------------------------

test('uninstall removes our links and prompt files, spares foreign ones, keeps notes', () => {
  seed().close();
  const home = fakeHome({ claude: true, vscode: true });
  try {
    const installed = setup({});
    const promptDir = installed.targets.find((t) => t.kind === 'prompt-dir').dir;

    // Someone else's skill directory that happens to share a name must survive.
    const foreign = join(skillTargets()[1], 'handoff');
    rmSync(foreign, { recursive: true, force: true });
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'NOTES.txt'), 'hand-rolled, not ours', 'utf8');
    // And so must a hand-written prompt file, which is why ownership is decided by
    // the generated marker rather than by the filename.
    const foreignPrompt = join(promptDir, 'remember.prompt.md');
    writeFileSync(foreignPrompt, '---\nmode: agent\n---\nmine, not yours\n', 'utf8');

    const r = unlinkSkills();
    assert.deepEqual(r.kept.sort(), [foreign, foreignPrompt].sort(), 'foreign files left alone');
    assert.ok(existsSync(join(foreign, 'NOTES.txt')));
    assert.equal(readFileSync(foreignPrompt, 'utf8').trim().endsWith('mine, not yours'), true);
    assert.ok(
      r.removed.some((p) => p.endsWith('recall.prompt.md')),
      'generated prompt files are removed',
    );
    assert.ok(r.removed.some((p) => p.endsWith(join('skills', 'recall'))), 'skill links removed');

    for (const name of SKILLS) {
      assert.ok(existsSync(join(packagedSkillsDir(), name, 'SKILL.md')), `packaged ${name} destroyed`);
    }
    assert.ok(readNote('system', 'auth-service'), 'notes are never touched by uninstall');
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a link left pointing at a removed package is detected', () => {
  seed().close();
  const home = mkdtempSync(join(tmpdir(), 'agent-memory-home-'));
  process.env.AGENT_MEMORY_SKILLS_HOME = home;
  try {
    setup({});
    assert.deepEqual(danglingSkillLinks(), [], 'a healthy install has none');

    // Exactly what `npm uninstall -g` leaves behind: npm 7 dropped uninstall hooks,
    // so the package vanishes and the links survive, pointing at nothing.
    const gone = join(home, 'removed-package', 'skills', 'recall');
    mkdirSync(gone, { recursive: true });
    const link = join(skillTargets()[0], 'recall');
    rmSync(link, { force: true });
    symlinkSync(gone, link, 'junction');
    rmSync(join(home, 'removed-package'), { recursive: true, force: true });

    assert.deepEqual(danglingSkillLinks(), [link]);
  } finally {
    delete process.env.AGENT_MEMORY_SKILLS_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

// --- documentation consistency --------------------------------------------------

test('the extraction rules are identical in both skills', () => {
  // They are duplicated on purpose: a skill has to be self-contained in one turn.
  // This test is what stops the two copies drifting apart unnoticed.
  const block = (file) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const m = src.match(/<!-- extraction-rules:start -->([\s\S]*?)<!-- extraction-rules:end -->/);
    assert.ok(m, `no extraction-rules block in ${file}`);
    return m[1];
  };
  assert.equal(block('../skills/remember/SKILL.md'), block('../skills/handoff/SKILL.md'));
});
