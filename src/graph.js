import { hydrate } from './index-db.js';

/**
 * SQLite's recursive CTE is the graph engine.
 *
 * Nothing is superimposed on top of it: no adjacency cache, no in-memory graph, no
 * second traversal in JavaScript. One prepared statement returns the neighborhood.
 */

/**
 * Every node within `depth` edges of the root, in one query.
 *
 * `UNION` rather than `UNION ALL` collapses repeated visits, and the depth bound
 * terminates the recursion. Both matter: `contradicts` edges make cycles inevitable
 * and a cycle without either guard would recurse until SQLite gave up.
 *
 * Edges are followed in both directions. A note that depends on the auth service is
 * part of the auth service's neighborhood, and an operator asking about auth wants
 * to hear about it.
 */
export function neighborhood(db, rootId, { depth = 1, includeArchived = false } = {}) {
  const rows = db
    .prepare(`
      WITH RECURSIVE hood(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT CASE WHEN e.src = h.id THEN e.dst ELSE e.src END, h.depth + 1
          FROM edges e
          JOIN hood h ON e.src = h.id OR e.dst = h.id
         WHERE h.depth < ?
      )
      SELECT n.*,
             MIN(hood.depth) AS depth,
             (SELECT COUNT(*) FROM edges e2 WHERE e2.src = n.id OR e2.dst = n.id) AS degree
        FROM nodes n
        JOIN hood ON n.id = hood.id
       WHERE (? = 1 OR n.archived = 0)
       GROUP BY n.id
       ORDER BY depth, n.type, n.id
    `)
    .all(rootId, depth, includeArchived ? 1 : 0);

  // A node reachable at two depths appears once, at the shorter one, because MIN
  // plus GROUP BY collapses it. Ordering by id last keeps output byte-stable across
  // rebuilds, which is what makes the reindex-determinism check meaningful.
  return rows.map((r) => hydrate(db, r));
}

/** Bytes of body text, which is what actually lands in the model's context. */
function bodyBytes(node) {
  return Buffer.byteLength(String(node.body ?? ''), 'utf8');
}

/**
 * Enforce the retrieval budget.
 *
 * `get --depth 2` on a well-connected node can return fifty notes and blow the
 * context this whole design exists to protect. Prune order: deepest first, then
 * least connected, because depth is distance from what was asked about and low
 * degree means the node is unlikely to be the hub anyone needed.
 *
 * Two things are never dropped: the root, and any `constraint`. A constraint is what
 * stops an agent from spending a dozen requests on an approach the org forbids, so
 * dropping one to save bytes trades the cheap thing away for the expensive one.
 *
 * Omitted ids are always returned. Silent truncation that reads as full coverage is
 * the failure this budget is most likely to cause and the one worth guarding.
 */
export function applyBudget(nodes, budgetBytes) {
  let total = nodes.reduce((sum, n) => sum + bodyBytes(n), 0);
  if (total <= budgetBytes) {
    return { kept: nodes, omitted: [], overBudget: false, bytes: total };
  }

  const removable = nodes
    .filter((n) => n.depth > 0 && n.type !== 'constraint')
    .sort(
      (a, b) =>
        b.depth - a.depth || a.degree - b.degree || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );

  const dropped = new Set();
  for (const n of removable) {
    if (total <= budgetBytes) break;
    dropped.add(n.id);
    total -= bodyBytes(n);
  }

  return {
    kept: nodes.filter((n) => !dropped.has(n.id)),
    omitted: nodes
      .filter((n) => dropped.has(n.id))
      .map((n) => ({ id: n.id, type: n.type, title: n.title, depth: n.depth })),
    // True when the root and the constraints alone exceed the budget. Reported
    // rather than fixed, because the fix would be dropping what is worth keeping.
    overBudget: total > budgetBytes,
    bytes: total,
  };
}
