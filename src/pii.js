/**
 * Disclosure control for export.
 *
 * This is not the same job as src/redact.js and must not be folded into it. That one
 * runs at capture and asks "could this authenticate as someone?" — its threat is a
 * credential reaching disk, and it deliberately preserves the operator's own email
 * because that address is already public in every commit they have ever pushed.
 *
 * This one runs at export and asks "could this identify a person?" — its threat is a
 * human reading the file. The operator's own email is the clearest case of the
 * difference: safe to store, not yours to hand to someone else along with a hundred
 * notes about how their client works.
 *
 * Two layers, and only one of them lives here. Structured identifiers have shape, so
 * they are matched and validated deterministically, which makes them testable and the
 * result reproducible from a named rule set. Names, addresses and identifying prose
 * have no shape; they are language, and the honest place to judge them is the model
 * already sitting in the conversation. The receipt says so out loud rather than
 * letting a regex imply a completeness it does not have.
 */

/** Bump when a detector changes. A receipt is only reproducible against its rule set. */
export const RULE_SET = 'pii/v1';

/** Detections in one note before the note is withheld whole rather than redacted. */
export const DEFAULT_WITHHOLD_COUNT = 8;

/** Share of the text that may be replaced before redaction stops being meaningful. */
export const DEFAULT_WITHHOLD_RATIO = 0.3;

/** Luhn, the checksum every payment card carries. Turns a digit run into a card. */
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * A US SSN has structure the Social Security Administration never issues.
 * Checking it is what separates an SSN from any other nine digits with dashes.
 */
function ssnValid(area, group, serial) {
  if (area === '000' || area === '666' || area[0] === '9') return false;
  if (group === '00' || serial === '0000') return false;
  return true;
}

function octetsValid(ip) {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p) => p.length <= 3 && Number(p) <= 255);
}

/**
 * Addresses that describe infrastructure rather than a person.
 *
 * The privacy interest in an IP is that a routable one, with a timestamp, can be put
 * to a subscriber by whoever holds the logs. A pod CIDR cannot. Capture-time
 * redaction already removes these ranges as infrastructure, so scrubbing them again
 * here would only cost meaning in ordinary engineering notes.
 */
function reservedV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Every detector is precision-first.
 *
 * A false negative leaks one identifier. A false positive shreds a sentence, and a
 * tool that mangles ordinary prose gets switched off, which leaks everything. So each
 * pattern here carries a checksum, a structural rule, or a separator requirement that
 * ordinary technical writing does not satisfy. Bare digit runs are left to the
 * semantic pass rather than guessed at, because a git SHA, an order number and a
 * national ID are the same characters.
 *
 * Order is load-bearing. A grouped card number is also a valid phone shape, so cards
 * are consumed before phones get a chance; reordering this array silently changes
 * what the labels say happened.
 */
const DETECTORS = [
  {
    kind: 'email',
    // No self-address exemption. That exemption is correct at capture and wrong here.
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: 'ssn',
    // Only the delimited form. Nine adjacent digits are too many other things.
    re: /(?<![\w-])(\d{3})-(\d{2})-(\d{4})(?![\w-])/g,
    validate: (m) => ssnValid(m[1], m[2], m[3]),
  },
  {
    kind: 'payment-card',
    re: /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g,
    validate: (m) => {
      const digits = m[0].replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  {
    kind: 'phone',
    // Requires separators or a country code, so `10.2.4` and `v1.2.3` cannot match,
    // and a bare run of ten digits is left alone on purpose.
    re: /(?<![\w-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{2,4}[\s.-]\d{2,5}(?:[\s.-]\d{1,5})?(?![\w-])/g,
    validate: (m) => {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return false;
      // One repeated digit is a placeholder or a masked field, never a number.
      if (/^(\d)\1+$/.test(digits)) return false;
      // A date reads as three separated numbers too. Reject anything shaped like one
      // rather than deciding by punctuation, which varies by locale.
      return !/^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}$/.test(m[0].trim());
    },
  },
  {
    kind: 'ip-address',
    // Capture-time redaction removes RFC1918 ranges as infrastructure. A routable
    // address is the one that can identify a subscriber, and it survives to here.
    re: /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g,
    validate: (m) => {
      if (!octetsValid(m[0])) return false;
      // Four single-digit groups is a four-part version string (6.0.1.2) far more
      // often than an address. A deliberate recall gap, measured in the eval and
      // covered by the semantic pass rather than paid for in shredded prose.
      if (/^\d(\.\d){3}$/.test(m[0])) return false;
      return !reservedV4(m[0]);
    },
  },
];

/**
 * Scan text, returning the redacted form and what fired.
 *
 * Fail-closed in the same sense as capture: a non-string is a programming error, and
 * returning it unscanned would be the one outcome worse than throwing.
 */
export function scanText(text) {
  if (typeof text !== 'string') {
    throw new TypeError('scanText() requires a string; refusing to export unscanned content');
  }
  const counts = new Map();
  let redactedChars = 0;
  let out = text;

  for (const { kind, re, validate } of DETECTORS) {
    out = out.replace(re, (...args) => {
      const match = args.slice(0, -2);
      const whole = match[0];
      if (validate && !validate(match)) return whole;
      counts.set(kind, (counts.get(kind) || 0) + 1);
      redactedChars += whole.length;
      return `[redacted:${kind}]`;
    });
  }

  return {
    text: out,
    findings: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
    redactedChars,
  };
}

/**
 * Clean one node for export, or decide it cannot be cleaned.
 *
 * Withholding is not a fallback for a broken redactor; it answers a different
 * question. A note that is mostly identifiers is a contact record rather than
 * knowledge, and its redacted skeleton is both useless to the reader and still
 * re-identifiable from the structure that remains. Better to name it in the receipt
 * and leave it behind.
 */
export function redactNodeForExport(node, opts = {}) {
  const withholdCount = opts.withholdCount ?? DEFAULT_WITHHOLD_COUNT;
  const withholdRatio = opts.withholdRatio ?? DEFAULT_WITHHOLD_RATIO;

  const clean = { ...node };
  const counts = new Map();
  let redactedChars = 0;
  let textChars = 0;

  for (const field of ['title', 'body']) {
    if (typeof clean[field] !== 'string') continue;
    textChars += clean[field].length;
    const r = scanText(clean[field]);
    clean[field] = r.text;
    redactedChars += r.redactedChars;
    for (const f of r.findings) counts.set(f.kind, (counts.get(f.kind) || 0) + f.count);
  }

  const findings = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  const total = findings.reduce((n, f) => n + f.count, 0);
  const ratio = textChars ? redactedChars / textChars : 0;

  if (total >= withholdCount || ratio > withholdRatio) {
    return {
      node: null,
      findings,
      withheld: true,
      reason:
        total >= withholdCount ? `${total} identifiers` : `${Math.round(ratio * 100)}% of the text`,
    };
  }
  return { node: clean, findings, withheld: false, reason: null };
}

/**
 * Fold per-note results into the receipt that ships with the export.
 *
 * The receipt is the governance artifact. An export without one is a file of unknown
 * provenance, and the reason to write it down is that "we redact PII" is a claim
 * while "pii/v1 removed four emails and withheld two notes" is evidence.
 */
export function buildReceipt(results, { scanned }) {
  const counts = new Map();
  const withheld = [];
  for (const r of results) {
    for (const f of r.findings) counts.set(f.kind, (counts.get(f.kind) || 0) + f.count);
    if (r.withheld) {
      withheld.push({ id: r.id, reason: r.reason, kinds: r.findings.map((f) => f.kind) });
    }
  }
  const redactions = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  return {
    ruleSet: RULE_SET,
    scanned,
    exported: scanned - withheld.length,
    redactions,
    withheld,
    // Stated in the artifact rather than only in the docs, because the person who
    // reads the receipt is the person deciding whether to send the file.
    semanticReviewRequired:
      'Structured identifiers only. Names, job titles, addresses and identifying prose are not detected here; have an agent review the export before sharing it outside your team.',
  };
}

/** The receipt as lines, for the humans who will read it in a terminal. */
export function renderReceipt(receipt) {
  const out = [`rule set: ${receipt.ruleSet}`];
  if (receipt.redactions.length) {
    out.push(`redacted: ${receipt.redactions.map((r) => `${r.count} ${r.kind}`).join(', ')}`);
  } else {
    out.push('redacted: nothing matched');
  }
  if (receipt.withheld.length) {
    out.push(`withheld: ${receipt.withheld.length} note${receipt.withheld.length === 1 ? '' : 's'}`);
    for (const w of receipt.withheld) out.push(`  ${w.id} — ${w.reason} (${w.kinds.join(', ')})`);
  }
  out.push('');
  out.push('Structured identifiers only. Have an agent review this file for names and');
  out.push('identifying prose before sharing it outside your team.');
  return out;
}
