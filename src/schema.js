import { NOTE_TYPES } from './config.js';

export const EDGE_RELS = ['depends-on', 'applies-to', 'supersedes', 'contradicts', 'evidence-for'];
export const SCOPES = ['repo', 'global'];
export const CONFIDENCE = ['observed', 'inferred'];

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export class ValidationError extends Error {
  constructor(errors) {
    super(`invalid node: ${errors.join('; ')}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Validate and normalize a node.
 *
 * Reports every problem rather than the first, so a model correcting its own
 * output fixes everything in one round trip instead of discovering faults one at
 * a time. That matters here: each retry costs a premium request.
 */
export function validateNode(input) {
  const e = [];
  const n = { ...input };

  if (typeof n.id !== 'string' || !ID_RE.test(n.id)) {
    e.push(`id must be kebab-case (got ${JSON.stringify(n.id)})`);
  }
  if (!NOTE_TYPES.includes(n.type)) {
    e.push(`type must be one of ${NOTE_TYPES.join('|')} (got ${JSON.stringify(n.type)})`);
  }
  if (typeof n.title !== 'string' || !n.title.trim()) e.push('title is required');
  if (typeof n.body !== 'string' || !n.body.trim()) e.push('body is required');

  n.repos = Array.isArray(n.repos) ? n.repos.filter((r) => typeof r === 'string' && r.trim()) : [];
  // An empty repo list means the note is not tied to any one project.
  n.scope = n.scope || (n.repos.length ? 'repo' : 'global');
  if (!SCOPES.includes(n.scope)) e.push(`scope must be one of ${SCOPES.join('|')}`);
  if (n.scope === 'repo' && n.repos.length === 0) {
    e.push('scope "repo" requires at least one entry in repos');
  }

  n.confidence = n.confidence || 'observed';
  if (!CONFIDENCE.includes(n.confidence)) {
    e.push(`confidence must be one of ${CONFIDENCE.join('|')}`);
  }

  n.source = typeof n.source === 'string' && n.source.trim() ? n.source.trim() : 'manual';

  n.supersedes =
    typeof n.supersedes === 'string' && n.supersedes.trim() ? n.supersedes.trim() : null;
  if (n.supersedes && !ID_RE.test(n.supersedes)) e.push('supersedes must be a kebab-case id');
  if (n.supersedes && n.supersedes === n.id) e.push('a node cannot supersede itself');

  n.captured_sha =
    typeof n.captured_sha === 'string' && SHA_RE.test(n.captured_sha)
      ? n.captured_sha.toLowerCase()
      : null;

  const edges = [];
  const seen = new Set();
  for (const raw of Array.isArray(n.edges) ? n.edges : []) {
    if (!raw || typeof raw !== 'object') {
      e.push('each edge must be an object with rel and dst');
      continue;
    }
    const { rel, dst } = raw;
    if (!EDGE_RELS.includes(rel)) {
      e.push(`edge rel must be one of ${EDGE_RELS.join('|')} (got ${JSON.stringify(rel)})`);
      continue;
    }
    if (typeof dst !== 'string' || !ID_RE.test(dst)) {
      e.push(`edge dst must be a kebab-case id (got ${JSON.stringify(dst)})`);
      continue;
    }
    // A self-loop is meaningless for every relation, contradicts included.
    if (dst === n.id) {
      e.push(`edge ${rel} points at its own node`);
      continue;
    }
    const key = `${rel} ${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ rel, dst });
  }
  n.edges = edges;

  for (const f of ['created', 'updated', 'accessed']) {
    if (n[f] != null && !ISO_RE.test(n[f])) e.push(`${f} must be ISO 8601 UTC`);
  }

  if (e.length) throw new ValidationError(e);
  return n;
}
