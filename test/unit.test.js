import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The store path is resolved when config.js is first imported, so it has to be set
// before any dynamic import below. Every test file gets its own throwaway store.
const ROOT = mkdtempSync(join(tmpdir(), 'agent-memory-unit-'));
process.env.AGENT_MEMORY_HOME = ROOT;
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

const { validateNode, ValidationError } = await import('../src/schema.js');
const { redact, redactNode } = await import('../src/redact.js');
const store = await import('../src/store.js');
const { loadConfig, saveConfig, DEFAULTS } = await import('../src/config.js');

/**
 * assert.throws returns undefined, so it cannot be used to inspect the error. These
 * tests care about the full error list, not just that something was thrown.
 */
function caught(fn, type) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof type, `expected ${type.name}, got ${err?.name}`);
    return err;
  }
  assert.fail(`expected ${type.name} to be thrown`);
}

const base = {
  id: 'auth-service',
  type: 'system',
  title: 'Auth uses sessions',
  body: 'Sessions live in Postgres.',
  repos: ['repo-a'],
};

// --- schema -----------------------------------------------------------------

test('validateNode accepts a well-formed node and fills defaults', () => {
  const n = validateNode({ ...base });
  assert.equal(n.scope, 'repo');
  assert.equal(n.confidence, 'observed');
  assert.equal(n.source, 'manual');
  assert.equal(n.supersedes, null);
  assert.deepEqual(n.edges, []);
});

test('validateNode reports every error at once, not just the first', () => {
  // Each retry costs the user a premium request, so one round trip has to be enough
  // to fix everything that is wrong.
  const err = caught(() => validateNode({ id: 'Bad ID', type: 'nope', title: '', body: '' }), ValidationError);
  assert.equal(err.errors.length, 4);
  assert.match(err.errors.join(' '), /kebab-case/);
  assert.match(err.errors.join(' '), /type must be one of/);
});

test('validateNode rejects a bad edge relation and a bad dst', () => {
  const err = caught(
    () =>
      validateNode({
        ...base,
        edges: [
          { rel: 'causes', dst: 'x' },
          { rel: 'depends-on', dst: 'Bad Id' },
        ],
      }),
    ValidationError,
  );
  assert.equal(err.errors.length, 2);
});

test('validateNode rejects self-reference in both supersedes and edges', () => {
  const a = caught(() => validateNode({ ...base, supersedes: 'auth-service' }), ValidationError);
  assert.match(a.errors.join(' '), /cannot supersede itself/);
  const b = caught(
    () => validateNode({ ...base, edges: [{ rel: 'contradicts', dst: 'auth-service' }] }),
    ValidationError,
  );
  assert.match(b.errors.join(' '), /own node/);
});

test('scope repo with no repos is rejected; empty repos defaults to global', () => {
  assert.throws(() => validateNode({ ...base, repos: [], scope: 'repo' }), ValidationError);
  assert.equal(validateNode({ ...base, repos: [] }).scope, 'global');
});

test('duplicate edges collapse to one', () => {
  const n = validateNode({
    ...base,
    edges: [
      { rel: 'depends-on', dst: 'db' },
      { rel: 'depends-on', dst: 'db' },
    ],
  });
  assert.equal(n.edges.length, 1);
});

// --- redaction ---------------------------------------------------------------

const SECRETS = [
  ['aws-access-key', 'key AKIAIOSFODNN7EXAMPLE here'],
  ['github-token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['slack-token', 'xoxb-1234567890-abcdefghij'],
  ['google-api-key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
  ['anthropic-key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
  ['bearer-token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'],
  ['connection-string', 'postgres://admin:hunter2@db.example.com:5432/app'],
  ['assigned-secret', 'password = "correcthorsebattery"'],
  ['session-cookie', 'JSESSIONID=A1B2C3D4E5F6G7H8I9J0'],
  ['private-ip', 'host 10.20.30.40 responds'],
  ['internal-host', 'reachable at billing.internal only'],
];

for (const [kind, text] of SECRETS) {
  test(`redact catches ${kind}`, () => {
    const r = redact(text);
    assert.ok(
      r.findings.some((f) => f.kind === kind),
      `expected ${kind} in ${JSON.stringify(r.findings)}`,
    );
    assert.ok(r.text.includes(`<redacted:${kind}>`));
  });
}

test('redact catches a private key block', () => {
  const r = redact('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----');
  assert.ok(r.findings.some((f) => f.kind === 'private-key'));
  assert.equal(r.text.trim(), '<redacted:private-key>');
});

test('redact leaves ordinary prose about secrets alone', () => {
  // "the password rotation policy" must survive, or the store cannot hold notes
  // about security conventions, which are exactly the notes worth keeping.
  const r = redact('Follow the password rotation policy and the token refresh design.');
  assert.equal(r.findings.length, 0);
});

test('redact keeps the local git identity and removes other addresses', () => {
  const r = redact('me@example.com and them@other.com', { selfEmail: 'me@example.com' });
  assert.ok(r.text.includes('me@example.com'));
  assert.ok(r.text.includes('<redacted:email>'));
  assert.equal(r.findings.find((f) => f.kind === 'email').count, 1);
});

test('redact fails closed on a non-string rather than passing it through', () => {
  assert.throws(() => redact(null), TypeError);
  assert.throws(() => redact({ body: 'x' }), TypeError);
});

test('redactNode scans both title and body', () => {
  const { node, findings } = redactNode({
    ...base,
    title: 'key AKIAIOSFODNN7EXAMPLE',
    body: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  });
  assert.ok(node.title.includes('<redacted:aws-access-key>'));
  assert.ok(node.body.includes('<redacted:github-token>'));
  assert.equal(findings.length, 2);
});

// --- frontmatter and hashing --------------------------------------------------

test('serialize then parse round-trips a title containing a colon', () => {
  const node = validateNode({ ...base, title: 'Auth: sessions, not JWT' });
  const back = store.parseNote(store.serializeNote(node));
  assert.equal(back.title, 'Auth: sessions, not JWT');
});

test('edges round-trip, including the empty case', () => {
  const withEdges = validateNode({ ...base, edges: [{ rel: 'depends-on', dst: 'db' }] });
  assert.deepEqual(store.parseNote(store.serializeNote(withEdges)).edges, [
    { rel: 'depends-on', dst: 'db' },
  ]);
  const without = validateNode({ ...base });
  assert.deepEqual(store.parseNote(store.serializeNote(without)).edges, []);
});

test('parseNote rejects a file with no frontmatter', () => {
  assert.throws(() => store.parseNote('just a body'), /missing frontmatter/);
  assert.throws(() => store.parseNote('---\nid: x\nno terminator'), /unterminated frontmatter/);
});

test('contentHash ignores whitespace, trailing spaces and line endings', () => {
  const a = store.contentHash({ type: 'system', title: 'T', body: 'one\ntwo' });
  const b = store.contentHash({ type: 'system', title: ' T ', body: 'one  \r\ntwo\n\n' });
  assert.equal(a, b);
});

test('contentHash separates notes that share a body but not a title', () => {
  // Hashing the body alone would silently merge two genuinely different notes.
  const a = store.contentHash({ type: 'system', title: 'Auth', body: 'same' });
  const b = store.contentHash({ type: 'system', title: 'Billing', body: 'same' });
  assert.notEqual(a, b);
});

test('normalizeTitle collapses punctuation and case', () => {
  assert.equal(store.normalizeTitle('Auth: sessions, not JWT!'), 'auth sessions not jwt');
  assert.equal(store.normalizeTitle('auth   sessions not jwt'), 'auth sessions not jwt');
});

// --- config -------------------------------------------------------------------

test('config falls back to defaults and rejects nonsense values', () => {
  saveConfig({ treeLines: 40 });
  assert.equal(loadConfig().treeLines, 40);
  saveConfig({ treeLines: -1, digestChars: 'lots' });
  assert.equal(loadConfig().treeLines, 40, 'a bad value must not overwrite a good one');
  assert.equal(loadConfig().digestChars, DEFAULTS.digestChars);
});

test('saveConfig deduplicates and sorts skill paths', () => {
  saveConfig({ skillPaths: ['/b/SKILL.md', '/a/SKILL.md', '/b/SKILL.md'] });
  assert.deepEqual(loadConfig().skillPaths, ['/a/SKILL.md', '/b/SKILL.md']);
});
