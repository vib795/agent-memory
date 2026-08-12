/**
 * The eval for export disclosure control.
 *
 * A unit test asks whether the code does what it was written to do. An eval asks
 * whether it does the job, against cases nobody wrote the code while looking at, and
 * reports a number rather than a colour. Both errors here have a cost and they are
 * not the same cost, so both get measured:
 *
 *   recall     a missed identifier is disclosed to whoever receives the file.
 *   precision  a false hit shreds a sentence, and a tool that mangles prose gets
 *              switched off, which discloses everything.
 *
 * Recall is held at 1.0 because there is no acceptable number of leaked identifiers.
 * Precision is held at 1.0 against a corpus built specifically to tempt each detector
 * with the thing it most resembles: a git SHA for a card, a version string for an
 * address, a date for a phone number. Both corpora are synthetic and use reserved
 * ranges (RFC 5737 for addresses, the card networks' published test numbers), so this
 * file never becomes the leak it exists to prevent.
 *
 * Known gaps are listed at the bottom and asserted to be gaps. A limitation that is
 * written down and tested is a boundary; the same limitation undocumented is a bug
 * waiting to be found by whoever receives an export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, redactNodeForExport, buildReceipt, RULE_SET } from '../src/pii.js';

/** Each must be detected, as the labelled kind, in ordinary surrounding prose. */
const POSITIVES = [
  { kind: 'email', text: 'ping alex.morgan@acme-partners.example before the cutover' },
  { kind: 'email', text: 'the alias u.singh+notes@example.co.uk forwards to the team' },
  { kind: 'ssn', text: 'the intake form had 123-45-6789 typed into the wrong box' },
  { kind: 'ssn', text: 'legacy record 078-05-1120 is still in the fixture data' },
  { kind: 'payment-card', text: 'test card 4111 1111 1111 1111 clears in the sandbox' },
  { kind: 'payment-card', text: 'use 5555-5555-5555-4444 for the declined path' },
  { kind: 'payment-card', text: 'amex 378282246310005 exercises the 15-digit branch' },
  { kind: 'phone', text: 'call 415-555-0142 if the pipeline is still red' },
  { kind: 'phone', text: 'the desk line is (415) 555-0142 during the migration window' },
  { kind: 'phone', text: 'the London number is +44 20 7946 0958' },
  { kind: 'phone', text: 'reachable on 415.555.0142 after hours' },
  { kind: 'ip-address', text: 'the gateway answered from 203.0.113.42 that morning' },
  { kind: 'ip-address', text: 'allowlist 198.51.100.7 or the health check fails' },
];

/** None may be touched. Each is the thing a detector is most likely to confuse. */
const NEGATIVES = [
  { text: 'pinned at commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', why: 'git sha' },
  { text: 'upgrade to v1.2.3 before Friday', why: 'semver' },
  { text: 'the runtime reports 6.0.1.2 on that host', why: 'four-part version' },
  { text: 'dev server runs on localhost:8080', why: 'host and port' },
  { text: 'the job started 2026-08-12T17:34:48Z and timed out', why: 'iso timestamp' },
  { text: 'shipped 2026-08-12 after the freeze lifted', why: 'plain date' },
  { text: 'trace 3f2504e0-4f89-11d3-9a0c-0305e82c3301 has the stack', why: 'uuid' },
  { text: 'order 4111111111111112 failed validation', why: '16 digits, fails Luhn' },
  { text: 'the fixture uses 123456789 as a placeholder', why: 'bare nine digits' },
  { text: 'masked to 000-00-0000 in the export', why: 'structurally invalid ssn' },
  { text: 'the range 2020-2024 covers every incident', why: 'year span' },
  { text: 'ports 8080-8090 are reserved for the pool', why: 'port range' },
  { text: 'retry after 30 seconds, up to 5 times', why: 'ordinary numbers' },
  { text: 'the pod cidr is 10.244.0.0 in that cluster', why: 'private range, infrastructure' },
  { text: 'the health check hits 127.0.0.1 first', why: 'loopback' },
];

test('eval: recall is 1.0 — every labelled identifier is detected', () => {
  const misses = [];
  const byKind = new Map();

  for (const c of POSITIVES) {
    const r = scanText(c.text);
    const hit = r.findings.some((f) => f.kind === c.kind);
    const stat = byKind.get(c.kind) || { hit: 0, total: 0 };
    stat.total += 1;
    if (hit) stat.hit += 1;
    else misses.push(`${c.kind}: ${c.text}`);
    byKind.set(c.kind, stat);
  }

  const lines = [...byKind.entries()]
    .sort()
    .map(([kind, s]) => `  ${kind.padEnd(14)} ${s.hit}/${s.total}`);
  console.log(`\n[${RULE_SET}] recall by kind\n${lines.join('\n')}`);

  assert.deepEqual(misses, [], 'every labelled identifier must be detected');
});

test('eval: precision is 1.0 — nothing in the tempting corpus is touched', () => {
  const falsePositives = [];
  for (const c of NEGATIVES) {
    const r = scanText(c.text);
    if (r.text !== c.text) falsePositives.push(`${c.why}: ${r.text}`);
  }
  console.log(
    `[${RULE_SET}] precision ${NEGATIVES.length - falsePositives.length}/${NEGATIVES.length} on the negative corpus`,
  );
  assert.deepEqual(falsePositives, [], 'ordinary technical writing must survive intact');
});

test('the redacted form says what was removed, not just that something was', () => {
  const r = scanText('mail alex@example.com or call 415-555-0142');
  assert.equal(r.text, 'mail [redacted:email] or call [redacted:phone]');
});

test('a note that is mostly identifiers is withheld rather than redacted', () => {
  const contactSheet = [
    'a@example.com',
    'b@example.com',
    'c@example.com',
    'd@example.com',
    'e@example.com',
    'f@example.com',
    'g@example.com',
    'h@example.com',
  ].join(', ');

  const r = redactNodeForExport({ id: 'contact-sheet', title: 'Contacts', body: contactSheet });
  assert.equal(r.withheld, true, 'a contact list is not knowledge and must not ship redacted');
  assert.equal(r.node, null);
  assert.match(r.reason, /identifiers/);
});

test('an ordinary note survives with its meaning intact', () => {
  const body = 'Deploys need the release lead to approve. Escalate to ops@example.com first.';
  const r = redactNodeForExport({ id: 'deploy-policy', title: 'Deploy policy', body });
  assert.equal(r.withheld, false);
  assert.match(r.node.body, /release lead to approve/, 'the knowledge has to survive');
  assert.match(r.node.body, /\[redacted:email\]/);
});

test('the receipt names the rule set, the counts, and its own limits', () => {
  const results = [
    { id: 'a', findings: [{ kind: 'email', count: 2 }], withheld: false, reason: null },
    { id: 'b', findings: [{ kind: 'phone', count: 9 }], withheld: true, reason: '9 identifiers' },
  ];
  const receipt = buildReceipt(results, { scanned: 2 });

  assert.equal(receipt.ruleSet, RULE_SET);
  assert.equal(receipt.exported, 1);
  assert.deepEqual(receipt.withheld, [{ id: 'b', reason: '9 identifiers', kinds: ['phone'] }]);
  // `redacted` describes the file the reader is holding. The withheld note's nine
  // phone numbers are reported under `withheld`, never folded into this total, or
  // the receipt would claim work it did not do on content it did not ship.
  assert.deepEqual(receipt.redactions, [{ kind: 'email', count: 2 }]);
  // The claim a receipt must never make is completeness.
  assert.match(receipt.semanticReviewRequired, /Names/);
});

test('scanning refuses rather than passing unscanned content through', () => {
  assert.throws(() => scanText(undefined), /refusing to export unscanned/);
});

/**
 * The gaps, asserted so that closing one has to be a deliberate act with a rule-set
 * bump rather than a silent change in what an old receipt meant.
 */
test('known gaps: what the deterministic layer does not catch', () => {
  const gaps = [
    { text: 'escalate to Priya Raghunathan in risk', why: 'person name' },
    { text: 'the office is at 40 Bank Street, Canary Wharf', why: 'postal address' },
    { text: 'the employee number is 4471822', why: 'bare internal identifier' },
  ];
  for (const g of gaps) {
    assert.equal(scanText(g.text).text, g.text, `${g.why} is expected to pass through`);
  }
  console.log(
    `[${RULE_SET}] ${gaps.length} known gaps pass through by design: ${gaps.map((g) => g.why).join(', ')}`,
  );
});
