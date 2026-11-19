import { NOTE_TYPES } from './config.js';
import { staleness, currentRepo } from './staleness.js';

/**
 * `agent-memory view`: one self-contained HTML file showing the store as a graph,
 * with the audits nothing else surfaces (orphans, dangling edges, contradictions,
 * staleness, unparseable notes).
 *
 * Everything here except `makeStaleFn` is pure: no clock, no randomness, no disk.
 * The same notes and the same `generated` stamp give the same bytes, so a diff of two
 * snapshots shows what changed in the store and nothing else.
 *
 * The page loads nothing from anywhere. The graph is drawn in Node as static SVG, so
 * it renders with JavaScript off; the inline script only adds filtering and a detail
 * pane, and it writes note text with `textContent`, never as markup.
 */

const AUDIT_ORDER = ['orphans', 'dangling', 'contradictions', 'stale', 'broken', 'unchecked'];
const NON_FRONTMATTER = new Set(['body', 'archived', 'path', '__error']);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const typeRank = (t) => {
  const i = NOTE_TYPES.indexOf(t);
  return i === -1 ? NOTE_TYPES.length : i;
};

/**
 * The staleness signal for one note, with "could not check" kept distinct from "fine".
 *
 * A note records a repository name, not a path, so its commit distance can only be
 * measured from inside that repository. Reporting such a note as fresh would be a
 * false all-clear, so it is reported as `'unchecked'` instead.
 */
export function makeStaleFn({ cwd = process.cwd(), cfg } = {}) {
  const here = currentRepo(cwd);
  return (node) => {
    if (!node?.captured_sha) return null;
    if (!here) return 'unchecked';
    // A SHA with no repository has no provenance: measuring it against whatever checkout
    // is open would report unrelated history as "rewritten".
    if (!Array.isArray(node.repos) || node.repos.length === 0) return 'unchecked';
    if (!node.repos.includes(here)) return 'unchecked';
    const s = staleness(node, { cwd, cfg, repo: here });
    return s ? { status: s.status, commits: s.commits } : null;
  };
}

/** Graph plus audits, from the array `listNotes()` returns. Pure. */
export function buildViewModel(notes, { staleFn = () => null, engagement = '', generated = '' } = {}) {
  const broken = [];
  const byId = new Map();
  for (const n of notes) {
    if (n.__error) {
      broken.push({ path: n.path, error: n.__error });
      continue;
    }
    // Parsed frontmatter with no usable id: two such files would share one map key and
    // one would vanish, so each is reported by path instead.
    if (typeof n.id !== 'string' || n.id === '') {
      broken.push({ path: n.path, error: 'no id in frontmatter' });
      continue;
    }
    // An id in both active and archive should not happen (a write removes the
    // archived copy), but if it does, the active one is the one agents read.
    const prev = byId.get(n.id);
    if (!prev || (prev.archived && !n.archived)) byId.set(n.id, n);
  }

  const edges = [];
  for (const n of byId.values()) {
    for (const e of n.edges || []) {
      edges.push({ src: n.id, rel: e.rel, dst: e.dst, dangling: !byId.has(e.dst) });
    }
  }
  edges.sort((a, b) => cmp(a.src, b.src) || cmp(a.rel, b.rel) || cmp(a.dst, b.dst));

  const degree = new Map([...byId.keys()].map((id) => [id, 0]));
  for (const e of edges) {
    if (e.dangling) continue;
    degree.set(e.src, degree.get(e.src) + 1);
    degree.set(e.dst, degree.get(e.dst) + 1);
  }

  const nodes = [...byId.values()]
    .sort((a, b) => typeRank(a.type) - typeRank(b.type) || cmp(a.id, b.id))
    .map((n) => {
      const frontmatter = {};
      for (const k of Object.keys(n).sort()) if (!NON_FRONTMATTER.has(k)) frontmatter[k] = n[k];
      return {
        id: n.id,
        type: n.type,
        title: n.title ?? '',
        repos: n.repos || [],
        archived: n.archived ? 1 : 0,
        body: n.body ?? '',
        frontmatter,
        degree: degree.get(n.id),
        // Archived notes are out of circulation; measuring them would only add noise.
        stale: n.archived ? null : (staleFn(n) ?? null),
      };
    });

  const active = nodes.filter((n) => !n.archived);
  const isStale = (s) => s && typeof s === 'object' && (s.status === 'stale' || s.status === 'rewritten');

  return {
    engagement,
    generated,
    nodes,
    edges,
    audits: {
      orphans: active.filter((n) => n.degree === 0).map((n) => n.id),
      dangling: edges.filter((e) => e.dangling).map(({ src, rel, dst }) => ({ src, rel, dst })),
      contradictions: edges.filter((e) => e.rel === 'contradicts').map((e) => ({ a: e.src, b: e.dst })),
      stale: active.filter((n) => isStale(n.stale)).map((n) => n.id),
      unchecked: active.filter((n) => n.stale === 'unchecked').length,
      broken: broken.sort((a, b) => cmp(a.path, b.path)),
    },
  };
}

function auditCount(audits, key) {
  const v = audits[key];
  return typeof v === 'number' ? v : v.length;
}

/** The one stdout line, in the same fixed order as the page. */
export function renderSummary(model) {
  return AUDIT_ORDER.map((k) => `${k} ${auditCount(model.audits, k)}`).join(' · ');
}


// --- layout -------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (v) => Math.round(v * 10) / 10;
const MARGIN = 40;
/** Room under a graph node for its label: gap, then one line of 12.5px text. */
const LABEL_DROP = 22;
const BOX_GAP = 8;

/**
 * Estimated rendered width of a label at 12.5px in a system UI font. An estimate,
 * not a measurement: the layout runs in Node, where there are no fonts. It is
 * deliberately generous, so a label drawn narrower than estimated never collides.
 */
export const labelWidth = (s) => Math.round(String(s).length * 7.2 + 10);

/** Better-connected notes draw a little larger, so hubs read as hubs. */
export const nodeRadius = (degree) => 6 + Math.min(degree || 0, 6);

/**
 * Where the unlinked notes go: a shelf under the graph, in a grid, rather than
 * scattered through the graph where they read as noise around the real structure.
 * Active notes first, archived after, so hiding archives leaves no holes mid-shelf.
 * `width` is the shelf's own width.
 */
export function shelfGeometry(model, width = SHELF_MIN_W) {
  const free = model.nodes.filter((n) => !n.degree);
  const items = [...free.filter((n) => !n.archived), ...free.filter((n) => n.archived)];
  if (!items.length) return null;
  const pad = 20;
  const colW = Math.min(280, Math.max(180, Math.max(...items.map((n) => labelWidth(n.id))) + 34));
  const cols = Math.max(1, Math.floor((width - 2 * pad) / colW));
  const rows = Math.ceil(items.length / cols);
  const head = 46;
  const rowH = 34;
  return { items, pad, colW, cols, rows, head, rowH, height: head + rows * rowH + 6 };
}

const SHELF_MIN_W = 760;
const VIEW_MIN_W = 760;
const VIEW_MIN_H = 460;

/** The box the linked notes occupy: each circle, plus the label centred beneath it. */
function linkedBounds(model, positions) {
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
  for (const n of model.nodes) {
    const p = positions[n.id];
    if (!n.degree || !p) continue;
    const rad = nodeRadius(n.degree);
    const w = Math.max(labelWidth(n.id), 2 * rad);
    l = Math.min(l, p.x - w / 2); r = Math.max(r, p.x + w / 2);
    t = Math.min(t, p.y - rad - 6); b = Math.max(b, p.y + rad + LABEL_DROP);
  }
  return l === Infinity ? null : { l, r, t, b };
}

/** The shelf sits under the linked notes, as wide as they are (or a readable minimum). */
function shelfFrame(model, positions) {
  const lb = linkedBounds(model, positions);
  const w = Math.round(Math.max(SHELF_MIN_W, lb ? lb.r - lb.l : 0));
  const g = shelfGeometry(model, w);
  if (!g) return null;
  const cx = lb ? (lb.l + lb.r) / 2 : w / 2;
  return { ...g, x: round1(cx - w / 2), y: lb ? round1(lb.b + 28) : 0, w };
}

/**
 * The camera's home: everything drawn plus a margin, and never smaller than a readable
 * minimum, so the graph fills its panel instead of floating small in a fixed canvas.
 */
export function sceneBox(model, positions) {
  const lb = linkedBounds(model, positions);
  const sf = shelfFrame(model, positions);
  const boxes = [lb, sf && { l: sf.x, r: sf.x + sf.w, t: sf.y, b: sf.y + sf.height }].filter(Boolean);
  if (!boxes.length) return { x: 0, y: 0, w: 1200, h: 400 };
  const pad = 28;
  let l = Math.min(...boxes.map((x) => x.l)) - pad;
  let r = Math.max(...boxes.map((x) => x.r)) + pad;
  let t = Math.min(...boxes.map((x) => x.t)) - pad;
  let b = Math.max(...boxes.map((x) => x.b)) + pad;
  if (r - l < VIEW_MIN_W) { const g = (VIEW_MIN_W - (r - l)) / 2; l -= g; r += g; }
  if (b - t < VIEW_MIN_H) { const g = (VIEW_MIN_H - (b - t)) / 2; t -= g; b += g; }
  return { x: round1(l), y: round1(t), w: round1(r - l), h: round1(b - t) };
}

/**
 * Force-directed placement of the linked notes, computed once in Node so the page
 * needs no script to draw. Seeded and iteration-bounded, so the picture is the same
 * on every run. Then two passes the forces alone cannot do: fit the shape to the
 * canvas, and push apart any two notes whose labels would overprint.
 */
function placeLinked(nodes, edges, width, height, out) {
  const n = nodes.length;
  if (n === 0) return;
  const ids = nodes.map((x) => x.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const cx = width / 2;
  const cy = height / 2;
  const rand = mulberry32(1);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const r0 = Math.min(width, height) / 2 - MARGIN;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    // A little seeded jitter breaks the perfect symmetry a circle starts with.
    xs[i] = cx + r0 * Math.cos(a) + (rand() - 0.5) * 2;
    ys[i] = cy + r0 * Math.sin(a) + (rand() - 0.5) * 2;
  }

  const links = [];
  for (const e of edges) {
    if (e.dangling || !index.has(e.src) || !index.has(e.dst)) continue;
    links.push([index.get(e.src), index.get(e.dst)]);
  }

  const k = Math.sqrt(((width - 2 * MARGIN) * (height - 2 * MARGIN)) / n);
  const k2 = k * k;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const ITER = 300;
  let temp = width / 10;
  const cool = temp / ITER;
  for (let it = 0; it < ITER; it++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = xs[i] - xs[j];
        let ddy = ys[i] - ys[j];
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 < 0.01) { ddx = 0.1; ddy = 0.1; d2 = 0.02; }
        const f = k2 / d2;
        dx[i] += ddx * f; dy[i] += ddy * f;
        dx[j] -= ddx * f; dy[j] -= ddy * f;
      }
    }
    for (const [a, b] of links) {
      const ddx = xs[a] - xs[b];
      const ddy = ys[a] - ys[b];
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      const f = d / k;
      dx[a] -= ddx * f; dy[a] -= ddy * f;
      dx[b] += ddx * f; dy[b] += ddy * f;
    }
    for (let i = 0; i < n; i++) {
      // A pull to the centre keeps separate clusters near each other.
      dx[i] += (cx - xs[i]) * 0.8;
      dy[i] += (cy - ys[i]) * 0.8;
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (len > 0) {
        const step = Math.min(len, temp);
        xs[i] += (dx[i] / len) * step;
        ys[i] += (dy[i] / len) * step;
      }
    }
    temp = Math.max(temp - cool, 0.5);
  }

  // Fit: one uniform scale keeps the shape the forces found. Labels sit centred under
  // their notes, so the widest label sets how close to the sides a centre may go.
  // Edges are also capped at a readable length, so three notes do not get flung to
  // the corners of an otherwise empty canvas.
  const radius = nodes.map((x) => nodeRadius(x.degree));
  const boxW = nodes.map((x, i) => Math.max(labelWidth(x.id), 2 * radius[i]));
  const maxW = Math.max(...boxW);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]);
    minY = Math.min(minY, ys[i]); maxY = Math.max(maxY, ys[i]);
  }
  const availW = Math.max(60, width - 2 * MARGIN - maxW);
  const availH = Math.max(60, height - 2 * MARGIN - LABEL_DROP - 12);
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  let scale = Math.min(availW / bw, availH / bh);
  if (links.length) {
    let sum = 0;
    for (const [a, b] of links) sum += Math.hypot(xs[a] - xs[b], ys[a] - ys[b]);
    const mean = sum / links.length || 1;
    scale = Math.min(scale, 200 / mean);
  }
  const offX = MARGIN + maxW / 2 + (availW - bw * scale) / 2;
  const offY = MARGIN + 12 + (availH - bh * scale) / 2;
  for (let i = 0; i < n; i++) {
    xs[i] = offX + (xs[i] - minX) * scale;
    ys[i] = offY + (ys[i] - minY) * scale;
  }

  // Declutter: each note owns a box (its circle, plus its label below). Any two boxes
  // that overlap are pushed apart along the axis that needs the smaller move.
  const loX = (i) => MARGIN + boxW[i] / 2;
  const hiX = (i) => width - MARGIN - boxW[i] / 2;
  const loY = (i) => MARGIN + radius[i];
  const hiY = (i) => height - MARGIN - radius[i] - LABEL_DROP;
  for (let it = 0; it < 400; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ox = (boxW[i] + boxW[j]) / 2 + BOX_GAP - Math.abs(xs[i] - xs[j]);
        if (ox <= 0) continue;
        const ti = ys[i] - radius[i];
        const bi = ys[i] + radius[i] + LABEL_DROP;
        const tj = ys[j] - radius[j];
        const bj = ys[j] + radius[j] + LABEL_DROP;
        const oy = Math.min(bi, bj) - Math.max(ti, tj) + BOX_GAP;
        if (oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const s = xs[i] <= xs[j] ? -1 : 1;
          xs[i] += (s * ox) / 2; xs[j] -= (s * ox) / 2;
        } else {
          const s = ys[i] <= ys[j] ? -1 : 1;
          ys[i] += (s * oy) / 2; ys[j] -= (s * oy) / 2;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      xs[i] = Math.min(Math.max(xs[i], loX(i)), hiX(i));
      ys[i] = Math.min(Math.max(ys[i], loY(i)), hiY(i));
    }
    if (!moved) break;
  }

  // Pack: separate clusters repel each other to opposite corners, which leaves a hole
  // in the middle and shrinks everything when the view fits the whole. Set them side
  // by side instead, largest first, wrapping to a new row when one would get too wide.
  const parent = ids.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b] of links) parent[find(a)] = find(b);
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(i);
  }
  if (byRoot.size > 1) {
    const comps = [...byRoot.values()].map((idx) => ({
      idx,
      l: Math.min(...idx.map((i) => xs[i] - boxW[i] / 2)),
      r: Math.max(...idx.map((i) => xs[i] + boxW[i] / 2)),
      t: Math.min(...idx.map((i) => ys[i] - radius[i])),
      b: Math.max(...idx.map((i) => ys[i] + radius[i] + LABEL_DROP)),
    })).sort((a, b) => b.idx.length - a.idx.length || a.idx[0] - b.idx[0]);
    const GAP = 64;
    const rows = [];
    let row = null;
    for (const c of comps) {
      const w = c.r - c.l;
      if (!row || (row.w > 0 && row.w + GAP + w > width - 2 * MARGIN)) {
        row = { comps: [], w: 0, h: 0 };
        rows.push(row);
      }
      c.x = row.w ? row.w + GAP : 0;
      row.w = c.x + w;
      row.h = Math.max(row.h, c.b - c.t);
      row.comps.push(c);
    }
    let y = 0;
    const totalW = Math.max(...rows.map((r) => r.w));
    for (const r of rows) {
      const indent = (totalW - r.w) / 2;
      for (const c of r.comps) {
        const sx = indent + c.x - c.l;
        const sy = y + (r.h - (c.b - c.t)) / 2 - c.t;
        for (const i of c.idx) { xs[i] += sx; ys[i] += sy; }
      }
      y += r.h + GAP;
    }
    // Centre the packed whole on the canvas.
    const totalH = y - GAP;
    for (let i = 0; i < n; i++) { xs[i] += (width - totalW) / 2; ys[i] += (height - totalH) / 2; }
  }
  for (let i = 0; i < n; i++) out[ids[i]] = { x: round1(xs[i]), y: round1(ys[i]) };
}

/**
 * Positions for every note: linked notes in the graph area, unlinked ones on the
 * shelf below them (see `shelfFrame`). Pure and deterministic.
 */
export function layout(model, { width = 1200, height = 800 } = {}) {
  const out = {};
  const linked = model.nodes.filter((n) => n.degree > 0);
  placeLinked(linked, model.edges, width, height, out);
  const sf = shelfFrame(model, out);
  if (sf) {
    sf.items.forEach((n, i) => {
      const c = i % sf.cols;
      const r = Math.floor(i / sf.cols);
      out[n.id] = {
        x: round1(sf.x + sf.pad + 14 + c * sf.colW),
        y: round1(sf.y + sf.head + r * sf.rowH + 4),
      };
    });
  }
  return out;
}

// --- html ---------------------------------------------------------------------

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Built from code points so no literal line separator ever sits in this source file.
const UNSAFE_IN_SCRIPT = new RegExp(
  `[<>&${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g',
);

/** JSON safe to sit inside a script element: no markup characters, no line separators. */
function embedJson(value) {
  return JSON.stringify(value).replace(UNSAFE_IN_SCRIPT, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";


// One palette, defined once as tokens; dark mode redefines the tokens, never the rules.
const DARK_TOKENS = `color-scheme:dark;
--bg:#0d0f14;--surface:#151820;--surface-2:#1b1f29;--glass:rgba(21,24,32,.86);--border:#262b36;--border-strong:#363d4a;
--text:#e8ebf1;--text-2:#a7afbd;--text-3:#737c8c;--accent:#8399ff;--accent-soft:rgba(131,153,255,.18);
--edge:#3a414e;--edge-hot:#8399ff;--grid:rgba(232,235,241,.045);
--warn:#ecab4d;--warn-soft:rgba(236,171,77,.16);--danger:#f27474;--danger-soft:rgba(242,116,116,.15);
--info:#8399ff;--info-soft:rgba(131,153,255,.13);--ok:#4cc08d;
--system:#719ef3;--decision:#f3a664;--convention:#57c697;--constraint:#b991f3;--other:#8a93a3;
--shadow:0 1px 2px rgba(0,0,0,.35);--shadow-lg:0 12px 32px rgba(0,0,0,.45)`;

const STYLE = `
:root{color-scheme:light;
--bg:#f4f5f7;--surface:#fff;--surface-2:#f2f4f7;--glass:rgba(255,255,255,.88);--border:#e3e6eb;--border-strong:#cfd4dc;
--text:#1a2130;--text-2:#566072;--text-3:#8a93a3;--accent:#4f6bed;--accent-soft:rgba(79,107,237,.13);
--edge:#cdd3dc;--edge-hot:#4f6bed;--grid:rgba(26,33,48,.06);
--warn:#b86e00;--warn-soft:rgba(232,153,30,.15);--danger:#cf3f3f;--danger-soft:rgba(207,63,63,.11);
--info:#4f6bed;--info-soft:rgba(79,107,237,.1);--ok:#2b9467;
--system:#4f7fd6;--decision:#e2873a;--convention:#35a174;--constraint:#9a68d6;--other:#8a93a3;
--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 4px rgba(16,24,40,.05);--shadow-lg:0 12px 32px rgba(16,24,40,.14);--radius:14px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK_TOKENS}}}
:root[data-theme="dark"]{${DARK_TOKENS}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
[hidden]{display:none!important}
.app{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr) auto;gap:12px;height:100vh;height:100dvh;padding:14px 18px 10px}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 0;margin-right:auto}
.brand>div{min-width:0}
.sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mark{width:32px;height:32px;border-radius:9px;background:var(--accent-soft);display:grid;place-items:center;flex:none}
.mark svg{width:19px;height:19px}.mark circle{fill:var(--accent)}.mark line{stroke:var(--accent);stroke-width:1.6}
h1{margin:0;font-size:16px;font-weight:650;letter-spacing:-.01em;line-height:1.2}
.sub{color:var(--text-3);font-size:12px}
.search{position:relative;flex:0 1 400px;min-width:200px}
.search input{width:100%;height:36px;padding:0 84px 0 34px;border-radius:10px;border:1px solid var(--border);background:var(--surface);box-shadow:var(--shadow);outline:none}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.search input::placeholder{color:var(--text-3)}
.search input::-webkit-search-cancel-button{display:none}
.search svg{position:absolute;left:11px;top:50%;width:15px;height:15px;transform:translateY(-50%);stroke:var(--text-3);fill:none;stroke-width:2}
.search .meta{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:11.5px;color:var(--text-3);pointer-events:none}
kbd{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--border-strong);border-bottom-width:2px;border-radius:5px;padding:0 5px;color:var(--text-3);background:var(--surface)}
.btn{height:36px;display:inline-flex;align-items:center;gap:7px;padding:0 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface);box-shadow:var(--shadow);color:var(--text-2);font-size:13px;white-space:nowrap}
.btn:hover{color:var(--text);border-color:var(--border-strong)}
.btn[aria-pressed="true"]{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.btn svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2}
.icon{width:36px;padding:0;justify-content:center;font-size:15px}
.audits{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.achip{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px 0 10px;border-radius:999px;border:1px solid var(--border);background:var(--surface);box-shadow:var(--shadow);font-size:13px;color:var(--text-2);transition:border-color .15s,background .15s}
.achip:hover:not(:disabled){border-color:var(--border-strong);color:var(--text)}
.achip .n{font-weight:650;font-variant-numeric:tabular-nums}
.achip .sig{width:8px;height:8px;border-radius:50%;background:var(--text-3)}
.achip.warn .sig{background:var(--warn)}.achip.warn .n{color:var(--warn)}
.achip.danger .sig{background:var(--danger)}.achip.danger .n{color:var(--danger)}
.achip.info .sig{background:var(--info)}.achip.info .n{color:var(--info)}
.achip.zero{box-shadow:none;background:transparent;color:var(--text-3);cursor:default;border-style:dashed}
.achip.zero .sig{background:var(--ok);opacity:.7}
.achip[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--text)}
.stage{position:relative;min-height:0;min-width:0;display:flex}
#graph{position:relative;flex:1;min-width:0;overflow:hidden;border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow);background-color:var(--surface);background-image:radial-gradient(var(--grid) 1px,transparent 1.3px);background-size:24px 24px}
#graph>svg{display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none}
.js #graph>svg{cursor:grab}
.js #graph>svg.panning{cursor:grabbing}
.edge{stroke:var(--edge);stroke-width:1.3;fill:none;transition:opacity .2s}
.edge.contradicts{stroke:var(--danger);stroke-dasharray:6 4}
.edge.hot{stroke:var(--edge-hot);stroke-width:2.2}
.arrowhead{fill:var(--edge)}.arrowhead-x{fill:var(--danger)}.arrowhead-hot{fill:var(--edge-hot)}
g.node{transition:opacity .2s}
.js g.node{cursor:pointer;outline:none}
g.node .halo{fill:transparent;transition:fill .15s}
g.node .nd{stroke:var(--surface);stroke-width:2.5;fill:var(--other)}
g.node .nd.t-system{fill:var(--system)}g.node .nd.t-decision{fill:var(--decision)}g.node .nd.t-convention{fill:var(--convention)}g.node .nd.t-constraint{fill:var(--constraint)}
g.node text{font-size:var(--fs,12.5px);fill:var(--text-2);paint-order:stroke;stroke:var(--surface);stroke-width:.32em;stroke-linejoin:round;pointer-events:none;transition:opacity .18s}
.js g.node:not(.lbl) text{opacity:0}
g.node.hot text,g.node.sel text{fill:var(--text);font-weight:650}
g.node.hot .halo,g.node:focus-visible .halo{fill:var(--accent-soft)}
g.node.sel .halo{fill:var(--accent-soft);stroke:var(--accent);stroke-width:2}
g.node.hl .halo{fill:var(--warn-soft);stroke:var(--warn);stroke-width:1.5}
g.node.match .halo{stroke:var(--accent);stroke-width:1.5;stroke-dasharray:3 2}
.flag{fill:var(--warn);stroke:var(--surface);stroke-width:1.5}
.fade{opacity:.13}
.elabel{font-size:var(--fe,11px);fill:var(--accent);paint-order:stroke;stroke:var(--surface);stroke-width:.32em;stroke-linejoin:round;pointer-events:none}
.far .elabel{display:none}
.shelf{fill:var(--surface-2);stroke:var(--border)}
.shelf-title{font-size:10.5px;font-weight:650;letter-spacing:.08em;fill:var(--text-3)}
.js:not(.show-free) #shelf{display:none}
body:not(.show-archived) .archived{display:none}
.hud{position:absolute;display:flex;gap:6px;align-items:flex-end;z-index:2}
.hud-bl{left:12px;bottom:12px;flex-wrap:wrap;max-width:calc(100% - 70px)}
.hud-br{right:12px;bottom:12px}
.hud-tl{left:12px;top:12px;right:12px;pointer-events:none}
.glass{background:var(--glass);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow)}
.legend{padding:3px;display:flex;gap:2px;flex-wrap:wrap}
.tchip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:0;border-radius:7px;background:none;font-size:12px;color:var(--text-2);text-transform:capitalize;transition:opacity .15s,background .15s}
.tchip:hover{background:var(--surface-2);color:var(--text)}
.tchip[aria-pressed="false"]{opacity:.45}
.tchip[aria-pressed="false"] .dot{background:transparent!important;box-shadow:inset 0 0 0 1.5px var(--text-3)}
.tchip .count{color:var(--text-3);font-variant-numeric:tabular-nums}
.seg{display:flex;padding:3px;gap:2px}
.seg button{height:26px;padding:0 10px;border:0;border-radius:7px;background:none;font-size:12px;color:var(--text-2);white-space:nowrap}
.seg button:hover:not(:disabled){color:var(--text);background:var(--surface-2)}
.seg button[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:var(--shadow);font-weight:600}
.seg button:disabled{opacity:.4;cursor:not-allowed}
.zoom{display:flex;flex-direction:column;padding:3px;gap:2px}
.zoom button{width:30px;height:30px;border:0;border-radius:7px;background:none;color:var(--text-2);font-size:16px;line-height:1;display:grid;place-items:center}
.zoom button:hover{background:var(--surface-2);color:var(--text)}
.hint{display:inline-block;font-size:12px;color:var(--text-3);padding:6px 10px;transition:opacity .5s}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none;background:var(--other)}
.dot.t-system{background:var(--system)}.dot.t-decision{background:var(--decision)}.dot.t-convention{background:var(--convention)}.dot.t-constraint{background:var(--constraint)}
.tip{position:absolute;z-index:4;pointer-events:none;max-width:280px;padding:9px 11px;transform:translate(-50%,calc(-100% - 12px));border-radius:10px;background:var(--glass);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid var(--border);box-shadow:var(--shadow-lg);font-size:12.5px}
.tip b{display:block;font-weight:600;line-height:1.35;margin-bottom:4px}
.tip .t-meta{display:flex;align-items:center;gap:6px;color:var(--text-3);font-size:11.5px;flex-wrap:wrap}
.drawer{position:relative;flex:none;width:0;overflow:hidden;transition:width .25s ease,margin .25s ease}
.drawer.open{width:400px;margin-left:12px}
.drawer-in{position:absolute;inset:0 auto 0 0;width:400px;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
.drawer-head{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 16px;border-bottom:1px solid var(--border);min-height:50px}
.drawer-head .back{border:0;background:none;color:var(--text-2);font-size:13px;padding:4px 8px 4px 4px;border-radius:7px;display:inline-flex;align-items:center;gap:4px;margin-left:-6px}
.drawer-head .back:hover{color:var(--text);background:var(--surface-2)}
.drawer-head .ttl{font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.drawer-head .x{margin-left:auto;width:30px;height:30px;border:0;border-radius:8px;background:none;color:var(--text-3);font-size:19px;line-height:1;flex:none}
.drawer-head .x:hover{background:var(--surface-2);color:var(--text)}
.drawer-body{flex:1;overflow:auto;overscroll-behavior:contain;padding:16px 18px 22px}
.eyebrow{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);text-transform:capitalize}
.dtitle{margin:8px 0 3px;font-size:19px;line-height:1.3;font-weight:650;letter-spacing:-.01em;outline:none}
.nid{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text-3);word-break:break-all}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.pill{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--border);font-size:12px;color:var(--text-2)}
.callout{margin-top:14px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.45}
.callout.warn{background:var(--warn-soft);color:var(--warn)}.callout.info{background:var(--info-soft);color:var(--info)}.callout.danger{background:var(--danger-soft);color:var(--danger)}
.h4{margin:20px 0 8px;font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);display:flex;justify-content:space-between;align-items:center;gap:8px}
.linkbtn{border:0;background:none;color:var(--accent);font-size:12px;padding:0;text-transform:none;letter-spacing:0;font-weight:500}
.linkbtn:hover{text-decoration:underline}
.nb{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:8px 10px;border-radius:9px;border:1px solid var(--border);background:var(--surface);font-size:13px;color:var(--text)}
.nb:hover{border-color:var(--accent);background:var(--accent-soft)}
.nb .rel{font-size:11.5px;color:var(--text-3);white-space:nowrap}
.nb .nt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb.off{cursor:default;color:var(--text-3)}.nb.off:hover{border-color:var(--border);background:var(--surface)}
.nbs{display:flex;flex-direction:column;gap:5px}
.body{white-space:pre-wrap;word-break:break-word;font:13.5px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--surface-2);border-radius:10px;padding:12px 14px;margin:0}
details.fm{margin-top:16px}
details.fm summary{cursor:pointer;font-size:12.5px;color:var(--text-2)}
dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:10px 0 0;font-size:12px}
dl.kv dt{color:var(--text-3)}dl.kv dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-word;color:var(--text-2)}
.ctl{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
select{height:32px;border-radius:9px;border:1px solid var(--border);background:var(--surface);padding:0 10px;font-size:13px;flex:1;min-width:140px}
.switch{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);cursor:pointer;user-select:none}
.switch input{appearance:none;-webkit-appearance:none;width:30px;height:18px;border-radius:999px;background:var(--border-strong);position:relative;cursor:pointer;margin:0;transition:background .15s}
.switch input::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.switch input:checked{background:var(--accent)}.switch input:checked::after{transform:translateX(12px)}
.group{display:flex;align-items:center;gap:7px;margin:16px 0 4px;font-size:12px;font-weight:600;color:var(--text-2);text-transform:capitalize}
.row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;background:none;border-radius:9px;padding:7px 9px}
.row:hover{background:var(--surface-2)}
.row.sel{background:var(--accent-soft)}
.row-main{display:flex;flex-direction:column;min-width:0;flex:1}
.row-title{font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-id{font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;flex:none;background:var(--surface-2);color:var(--text-2)}
.tag.warn{background:var(--warn-soft);color:var(--warn)}.tag.danger{background:var(--danger-soft);color:var(--danger)}.tag.info{background:var(--info-soft);color:var(--info)}
.item{font-size:13px;color:var(--text-2);padding:8px 10px;border-radius:8px;background:var(--surface-2);word-break:break-word;margin-bottom:4px}
.lede{font-size:13px;color:var(--text-2);margin:0 0 12px}
footer.note{font-size:11px;color:var(--text-3);text-align:center}
@media (max-width:900px){
.app{padding:12px 12px 8px;gap:10px}
.search{flex-basis:100%;order:3;max-width:none}
.drawer{position:fixed;left:0;right:0;bottom:0;width:auto!important;height:0;margin:0!important;z-index:10;transition:height .25s ease}
.drawer.open{height:58vh}
.drawer-in{position:absolute;inset:0;width:auto;border-radius:16px 16px 0 0;box-shadow:var(--shadow-lg)}
}
@media (max-width:560px){.hint,.btn .lbl,.tchip .count{display:none}.tchip{padding:0 7px;gap:5px}.achip{height:30px;font-size:12px;padding:0 10px 0 9px}.seg button{padding:0 8px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const AUDIT_META = {
  orphans: { label: 'Unlinked', tone: 'info', lede: 'Notes with no links in or out. Nothing in the graph leads to them; link them or archive them.' },
  dangling: { label: 'Dangling', tone: 'danger', lede: 'Links that point at a note that does not exist.' },
  contradictions: { label: 'Contradictions', tone: 'danger', lede: 'Pairs joined by a contradicts link. Settle each one.' },
  stale: { label: 'Stale', tone: 'warn', lede: 'Captured 10 or more commits ago in this repository, or at a commit no longer in its history. Check each still holds.' },
  broken: { label: 'Unreadable', tone: 'danger', lede: 'Note files that do not parse.' },
  unchecked: { label: 'Unchecked', tone: 'info', lede: 'Captured in other repositories, so their staleness cannot be measured from here.' },
};

const KNOWN_TYPES = ['system', 'decision', 'convention', 'constraint'];

/** A short arrow from just outside one circle to just outside the other. */
function edgeEnds(a, b, ra, rb) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d < ra + rb + 6) return [a.x, a.y, b.x, b.y];
  const ux = dx / d;
  const uy = dy / d;
  return [a.x + ux * (ra + 2), a.y + uy * (ra + 2), b.x - ux * (rb + 4), b.y - uy * (rb + 4)].map(round1);
}

/** Fits a shelf label to its column; the full id stays in the tooltip. */
function fitLabel(id, maxW) {
  if (labelWidth(id) <= maxW) return id;
  const keep = Math.max(4, Math.floor((maxW - 10) / 7.2) - 1);
  return `${id.slice(0, keep)}…`;
}

function renderNode(n, p, shelf) {
  const r = nodeRadius(n.degree);
  const onShelf = !n.degree;
  const type = KNOWN_TYPES.includes(n.type) ? ` t-${n.type}` : '';
  const stale = n.stale && typeof n.stale === 'object';
  const label = onShelf ? fitLabel(n.id, shelf.colW - 34) : n.id;
  const text = onShelf
    ? `<text x="${round1(p.x + r + 9)}" y="${round1(p.y + 4.5)}">${escapeHtml(label)}</text>`
    : `<text x="${p.x}" y="${round1(p.y + r + 17)}" text-anchor="middle">${escapeHtml(label)}</text>`;
  return `<g class="node${n.archived ? ' archived' : ''}" data-id="${escapeHtml(n.id)}">`
    + `<circle class="halo" cx="${p.x}" cy="${p.y}" r="${r + 6}"></circle>`
    + `<circle class="nd${type}" cx="${p.x}" cy="${p.y}" r="${r}"></circle>`
    + (stale ? `<circle class="flag" cx="${round1(p.x + r * 0.75)}" cy="${round1(p.y - r * 0.75)}" r="3.4"></circle>` : '')
    + text
    + `<title>${escapeHtml(`${n.id} (${n.type}): ${n.title}`)}</title></g>`;
}

/**
 * The static drawing. With scripts off this is the whole picture, every label shown;
 * with scripts on it is the starting frame the live simulation takes over from.
 */
function renderSvg(model, positions) {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const shelf = shelfFrame(model, positions);
  const vb = sceneBox(model, positions);
  const parts = [`<svg viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" role="img" aria-label="note graph" preserveAspectRatio="xMidYMid meet">`];
  parts.push('<defs>'
    + '<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 1L9 5L0 9z"></path></marker>'
    + '<marker id="arrow-hot" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="arrowhead-hot" d="M0 1L9 5L0 9z"></path></marker>'
    + '<marker id="arrow-x" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead-x" d="M0 1L9 5L0 9z"></path></marker>'
    + '</defs>');
  parts.push('<g id="edges">');
  for (const e of model.edges) {
    if (e.dangling) continue;
    const a = positions[e.src];
    const b = positions[e.dst];
    if (!a || !b) continue;
    const sa = byId.get(e.src);
    const sb = byId.get(e.dst);
    const [x1, y1, x2, y2] = edgeEnds(a, b, nodeRadius(sa.degree), nodeRadius(sb.degree));
    const contra = e.rel === 'contradicts';
    const cls = ['edge', contra ? 'contradicts' : '', sa.archived || sb.archived ? 'archived' : '']
      .filter(Boolean).join(' ');
    parts.push(
      `<line class="${cls}" data-src="${escapeHtml(e.src)}" data-dst="${escapeHtml(e.dst)}" data-rel="${escapeHtml(e.rel)}"`
      + ` x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${contra ? 'arrow-x' : 'arrow'})">`
      + `<title>${escapeHtml(`${e.src} ${e.rel} ${e.dst}`)}</title></line>`,
    );
  }
  parts.push('</g>');
  parts.push('<g id="elabels"></g>');
  if (shelf) {
    const active = shelf.items.filter((n) => !n.archived).length;
    parts.push('<g id="shelf">');
    parts.push(`<rect class="shelf" x="${shelf.x}" y="${shelf.y}" width="${shelf.w}" height="${shelf.height}" rx="14"></rect>`);
    parts.push(`<text class="shelf-title" x="${round1(shelf.x + shelf.pad)}" y="${round1(shelf.y + 26)}">UNLINKED NOTES · ${active}</text>`);
    for (const n of shelf.items) if (positions[n.id]) parts.push(renderNode(n, positions[n.id], shelf));
    parts.push('</g>');
  }
  parts.push('<g id="nodes">');
  for (const n of model.nodes) {
    if (!n.degree || !positions[n.id]) continue;
    parts.push(renderNode(n, positions[n.id], shelf));
  }
  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('\n');
}

function renderAuditChips(model) {
  return AUDIT_ORDER.map((k) => {
    const c = auditCount(model.audits, k);
    const m = AUDIT_META[k];
    return `<button type="button" class="achip ${c ? m.tone : 'zero'}" data-audit="${k}" aria-pressed="false"${c ? '' : ' disabled'}`
      + ` data-label="${m.label}" title="${escapeHtml(m.lede)}"><span class="n">${c}</span><span class="sig" aria-hidden="true"></span><span class="label">${m.label}</span></button>`;
  }).join('\n');
}

/**
 * Browser-side behaviour. Kept as a real function so Node parses it at import time,
 * and serialised into the page with `toString()`. It must never contain the
 * characters that would close the script element it is placed in.
 *
 * Shape: overview first, zoom and filter, details on demand. A small force simulation
 * (springs on links, repulsion between notes, collision) starts from the static layout;
 * labels appear by zoom level and focus; hover lights a note's links and fades the
 * rest; selecting opens a drawer and frames the neighbourhood.
 */
function clientMain() {
  var model = JSON.parse(document.getElementById('data').textContent);
  var root = document.documentElement;
  var body = document.body;
  body.classList.add('js');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var svg = document.querySelector('#graph > svg');
  var graph = document.getElementById('graph');
  var AUDITS = model.audits;

  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function wait(fn, ms) { return setTimeout(fn, reduce ? 0 : ms); }

  // --- theme -------------------------------------------------------------------
  var themeBtn = document.getElementById('theme');
  var modes = ['auto', 'light', 'dark'];
  var icons = { auto: '◐', light: '☀', dark: '☾' };
  var mode = 'auto';
  function setTheme(m, save) {
    mode = m;
    if (m === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', m);
    themeBtn.textContent = icons[m];
    themeBtn.title = 'Theme: ' + m;
    themeBtn.setAttribute('aria-label', 'Theme: ' + m);
    if (save) { try { localStorage.setItem('agent-memory-theme', m); } catch (e) { /* storage blocked */ } }
  }
  var saved = 'auto';
  try { saved = localStorage.getItem('agent-memory-theme') || 'auto'; } catch (e) { /* storage blocked */ }
  setTheme(modes.indexOf(saved) === -1 ? 'auto' : saved, false);
  themeBtn.addEventListener('click', function () { setTheme(modes[(modes.indexOf(mode) + 1) % modes.length], true); });

  // --- model -------------------------------------------------------------------
  // Null-prototype map: an id like "constructor" must not hit an inherited key.
  var S = Object.create(null);
  var all = [];
  model.nodes.forEach(function (n) {
    var s = { id: n.id, n: n, free: !n.degree, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, r: 6, hidden: false, nbrs: [] };
    S[n.id] = s;
    all.push(s);
  });
  var sims = [];
  var E = [];
  if (svg) {
    svg.querySelectorAll('g.node').forEach(function (g) {
      var s = S[g.getAttribute('data-id')];
      if (!s) return;
      s.g = g;
      s.nd = g.querySelector('.nd');
      s.halo = g.querySelector('.halo');
      s.flag = g.querySelector('.flag');
      s.text = g.querySelector('text');
      s.x = +s.nd.getAttribute('cx');
      s.y = +s.nd.getAttribute('cy');
      s.r = +s.nd.getAttribute('r');
      s.lw = s.id.length * 7.2 + 10;
      // The hover card replaces the browser's own tooltip.
      var t = g.querySelector('title');
      if (t) t.remove();
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', (s.n.title || s.id) + ' (' + s.n.type + ')');
      if (!s.free) sims.push(s);
    });
    svg.querySelectorAll('line[data-src]').forEach(function (l) {
      var a = S[l.getAttribute('data-src')];
      var b = S[l.getAttribute('data-dst')];
      if (!a || !b) return;
      var t = l.querySelector('title');
      if (t) t.remove();
      E.push({ a: a, b: b, el: l, rel: l.getAttribute('data-rel') || '', contra: l.classList.contains('contradicts'), label: null });
      a.nbrs.push(b);
      b.nbrs.push(a);
    });
  }
  var degs = sims.map(function (s) { return s.n.degree; }).sort(function (a, b) { return b - a; });
  var hubDeg = Math.max(3, degs[Math.floor(degs.length * 0.2)] || 0);

  // --- state -------------------------------------------------------------------
  var hoverId = null;
  var selectedId = null;
  var auditKey = null;
  var auditSet = null;
  var matchSet = null;
  var scope = 0;
  var types = Object.create(null);
  var showArchived = body.classList.contains('show-archived');
  var repoSel = document.getElementById('repo');
  var archBox = document.getElementById('show-archived');

  // --- simulation --------------------------------------------------------------
  var alpha = 0;
  var alphaTarget = 0;
  var raf = 0;
  var LINK = 120;
  var CHARGE = 900;
  function live(s) { return !s.free && !s.hidden; }
  function tick() {
    var list = sims.filter(live);
    var i, j, a, b, dx, dy, d2, d, w;
    for (i = 0; i < list.length; i++) {
      a = list[i];
      for (j = i + 1; j < list.length; j++) {
        b = list[j];
        dx = a.x - b.x;
        dy = a.y - b.y;
        if (dx === 0 && dy === 0) { dx = (i - j) * 0.37; dy = (j - i) * 0.21; }
        d2 = Math.max(dx * dx + dy * dy, 36);
        // Repulsion fades out past a few link lengths, so separate clusters can sit close.
        if (d2 < 90000) {
          w = (CHARGE * alpha) / d2;
          a.vx += dx * w; a.vy += dy * w;
          b.vx -= dx * w; b.vy -= dy * w;
        }
        // Collision: every note keeps a ring of clear space around it.
        d = Math.sqrt(d2);
        var min = a.r + b.r + 34;
        if (d < min) {
          var push = ((min - d) / d) * 0.35;
          a.vx += dx * push; a.vy += dy * push;
          b.vx -= dx * push; b.vy -= dy * push;
        }
        // Labels sit under their notes: two on one line need their widths apart.
        var ady = Math.abs(dy);
        var need = (a.lw + b.lw) / 2 + 10;
        if (ady < 24 && Math.abs(dx) < need) {
          var sx = dx >= 0 ? 1 : -1;
          var shove = (need - Math.abs(dx)) * 0.12;
          a.vx += sx * shove; b.vx -= sx * shove;
        }
      }
    }
    E.forEach(function (e) {
      if (!live(e.a) || !live(e.b)) return;
      dx = e.b.x + e.b.vx - e.a.x - e.a.vx;
      dy = e.b.y + e.b.vy - e.a.y - e.a.vy;
      d = Math.sqrt(dx * dx + dy * dy) || 1;
      var k = ((d - LINK) / d) * alpha * 0.45;
      dx *= k; dy *= k;
      e.b.vx -= dx * 0.5; e.b.vy -= dy * 0.5;
      e.a.vx += dx * 0.5; e.a.vy += dy * 0.5;
    });
    var mx = 0, my = 0;
    list.forEach(function (s) { mx += s.x; my += s.y; });
    if (list.length) { mx /= list.length; my /= list.length; }
    list.forEach(function (s) {
      // A gentle pull to the middle keeps separate clusters from drifting apart.
      s.vx += (mx - s.x) * 0.045 * alpha;
      s.vy += (my - s.y) * 0.06 * alpha;
      if (s.fx !== null) { s.x = s.fx; s.y = s.fy; s.vx = 0; s.vy = 0; return; }
      s.vx *= 0.6; s.vy *= 0.6;
      s.x += s.vx; s.y += s.vy;
    });
    alpha += (alphaTarget - alpha) * 0.03;
  }
  function settle(n) { for (var k = 0; k < n; k++) tick(); }
  function loop() {
    raf = 0;
    tick();
    draw();
    if (alpha > 0.004 || alphaTarget > 0) raf = requestAnimationFrame(loop);
  }
  function reheat(a) {
    alpha = Math.max(alpha, a);
    if (reduce) { alphaTarget = 0; settle(160); draw(); return; }
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // --- drawing -----------------------------------------------------------------
  var shelfG = svg ? svg.querySelector('#shelf') : null;
  var elabels = svg ? svg.querySelector('#elabels') : null;
  function freeList() { return all.filter(function (s) { return s.free && s.g && !s.hidden; }); }
  // Unlinked notes sit on a shelf under the live graph, shown only when asked for.
  function placeShelf() {
    if (!shelfG) return;
    var free = freeList();
    var b = bounds(sims.filter(live), 0);
    var w = Math.max(760, b ? b.r - b.l : 760);
    var colW = 230;
    var cols = Math.max(1, Math.floor((w - 40) / colW));
    var x0 = b ? (b.l + b.r) / 2 - w / 2 : 0;
    var y0 = b ? b.b + 40 : 0;
    var rows = Math.ceil(free.length / cols) || 1;
    var rr = shelfG.querySelector('rect');
    rr.setAttribute('x', x0); rr.setAttribute('y', y0);
    rr.setAttribute('width', w); rr.setAttribute('height', 52 + rows * 34);
    var title = shelfG.querySelector('.shelf-title');
    title.setAttribute('x', x0 + 20); title.setAttribute('y', y0 + 26);
    title.textContent = 'UNLINKED NOTES · ' + free.length;
    free.forEach(function (s, i) {
      s.x = x0 + 34 + (i % cols) * colW;
      s.y = y0 + 50 + Math.floor(i / cols) * 34;
      drawNode(s);
    });
  }
  function drawNode(s) {
    s.nd.setAttribute('cx', s.x); s.nd.setAttribute('cy', s.y);
    s.halo.setAttribute('cx', s.x); s.halo.setAttribute('cy', s.y);
    if (s.flag) { s.flag.setAttribute('cx', s.x + s.r * 0.75); s.flag.setAttribute('cy', s.y - s.r * 0.75); }
    if (s.free) { s.text.setAttribute('x', s.x + s.r + 9); s.text.setAttribute('y', s.y + 4.5); }
    else { s.text.setAttribute('x', s.x); s.text.setAttribute('y', s.y + s.r + 4 + 13 * inv); }
  }
  function ends(e) {
    var dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / d, uy = dy / d;
    return [e.a.x + ux * (e.a.r + 2), e.a.y + uy * (e.a.r + 2), e.b.x - ux * (e.b.r + 4), e.b.y - uy * (e.b.r + 4)];
  }
  function draw() {
    sims.forEach(function (s) { if (s.g) drawNode(s); });
    E.forEach(function (e) {
      var p = ends(e);
      e.el.setAttribute('x1', p[0]); e.el.setAttribute('y1', p[1]);
      e.el.setAttribute('x2', p[2]); e.el.setAttribute('y2', p[3]);
      if (e.label) {
        e.label.setAttribute('x', (e.a.x + e.b.x) / 2);
        e.label.setAttribute('y', (e.a.y + e.b.y) / 2 - 5);
      }
    });
    if (body.classList.contains('show-free')) placeShelf();
    positionTip();
  }

  // --- camera: the viewBox -------------------------------------------------------
  var vb = svg ? svg.getAttribute('viewBox').split(' ').map(Number) : [0, 0, 1, 1];
  var anim = 0;
  function rect() { return svg.getBoundingClientRect(); }
  // Text keeps one size on screen whatever the zoom: the font scales against it.
  var inv = 1;
  function setVB() {
    svg.setAttribute('viewBox', vb.map(function (v) { return Math.round(v * 100) / 100; }).join(' '));
    var k = scale();
    var ninv = k > 0 ? Math.min(3, Math.max(0.6, 1 / k)) : 1;
    if (Math.abs(ninv - inv) > 0.01) {
      inv = ninv;
      svg.style.setProperty('--fs', (12.5 * inv).toFixed(2) + 'px');
      svg.style.setProperty('--fe', (11 * inv).toFixed(2) + 'px');
      all.forEach(function (s) { if (s.g) drawNode(s); });
    }
    labels();
    positionTip();
  }
  function scale() { return rect().width / vb[2]; }
  // Keep the viewBox the panel's own shape, so a unit is the same size on both axes.
  function matchAspect() {
    var r = rect();
    if (!r.width || !r.height) return;
    var cy = vb[1] + vb[3] / 2;
    vb[3] = vb[2] * (r.height / r.width);
    vb[1] = cy - vb[3] / 2;
  }
  function toSvg(px, py) {
    var r = rect();
    return [vb[0] + ((px - r.left) / r.width) * vb[2], vb[1] + ((py - r.top) / r.height) * vb[3]];
  }
  function bounds(list, pad) {
    if (!list.length) return null;
    var l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    list.forEach(function (s) {
      var lw = s.free ? 0 : 70;
      l = Math.min(l, s.x - s.r - lw); r = Math.max(r, s.x + s.r + (s.free ? 200 : lw));
      t = Math.min(t, s.y - s.r); b = Math.max(b, s.y + s.r + 22);
    });
    return { l: l - pad, r: r + pad, t: t - pad, b: b + pad };
  }
  function fit(list, animate) {
    var b = bounds(list, 56);
    if (!b) return;
    b.b += 40;
    var rr = rect();
    // On a phone the drawer is a bottom sheet: frame the notes in the part left showing.
    var visH = rr.height;
    if (window.innerWidth <= 900 && drawer.classList.contains('open')) {
      visH = Math.max(120, Math.min(rr.height, window.innerHeight * 0.42 - 12 - rr.top));
    }
    var aspect = rr.width / visH || 1.5;
    var w = Math.max(b.r - b.l, (b.b - b.t) * aspect, 420);
    var h = w / aspect;
    var H = w * (rr.height / rr.width);
    tween([(b.l + b.r) / 2 - w / 2, (b.t + b.b) / 2 - h / 2, w, H], animate);
  }
  function tween(target, animate) {
    if (anim) cancelAnimationFrame(anim);
    if (!animate || reduce) { vb = target; setVB(); return; }
    var from = vb.slice();
    var t0 = performance.now();
    function step(now) {
      var t = Math.min(1, (now - t0) / 420);
      var k = 1 - Math.pow(1 - t, 3);
      vb = from.map(function (v, i) { return v + (target[i] - v) * k; });
      setVB();
      anim = t < 1 ? requestAnimationFrame(step) : 0;
    }
    anim = requestAnimationFrame(step);
  }
  function zoomAt(px, py, f) {
    if (vb[2] * f < 160) f = 160 / vb[2];
    if (vb[2] * f > 8000) f = 8000 / vb[2];
    vb[0] = px - (px - vb[0]) * f;
    vb[1] = py - (py - vb[1]) * f;
    vb[2] *= f; vb[3] *= f;
    setVB();
  }
  function zoomCentre(f) { zoomAt(vb[0] + vb[2] / 2, vb[1] + vb[3] / 2, f); }
  function visibleList() {
    var list = sims.filter(live);
    if (body.classList.contains('show-free')) list = list.concat(freeList());
    return list.length ? list : freeList();
  }
  function fitAll(animate) { fit(visibleList(), animate); }

  // --- labels on demand ------------------------------------------------------------
  function isNbr(a, b) {
    var s = S[a];
    if (!s) return false;
    for (var i = 0; i < s.nbrs.length; i++) if (s.nbrs[i].id === b) return true;
    return false;
  }
  function labels() {
    if (!svg) return;
    var k = scale();
    var count = sims.filter(live).length;
    var focus = hoverId || selectedId;
    all.forEach(function (s) {
      if (!s.g) return;
      var show = s.free
        || count <= 8
        || k >= 1.05
        || (s.n.degree >= hubDeg && k >= 0.5)
        || s.id === focus
        || (focus && k >= 0.45 && isNbr(focus, s.id))
        || (matchSet && matchSet.has(s.id))
        || (auditSet && auditSet.has(s.id));
      s.g.classList.toggle('lbl', !!show);
    });
    // Relation names need room; at a far zoom they would only add noise.
    svg.classList.toggle('far', k < 0.6);
  }

  // --- filters and focus -------------------------------------------------------------
  function inScope() {
    if (!scope || !selectedId || !S[selectedId] || S[selectedId].free) return null;
    var seen = new Set([selectedId]);
    var frontier = [S[selectedId]];
    for (var d = 0; d < scope; d++) {
      var next = [];
      frontier.forEach(function (s) {
        s.nbrs.forEach(function (o) { if (!seen.has(o.id)) { seen.add(o.id); next.push(o); } });
      });
      frontier = next;
    }
    return seen;
  }
  function refresh(opts) {
    opts = opts || {};
    var repo = repoSel.value;
    var sc = inScope();
    var changed = false;
    all.forEach(function (s) {
      var n = s.n;
      var hide = types[n.type] === false
        || (repo === 'g:' && n.repos.length > 0)
        || (repo && repo !== 'g:' && n.repos.indexOf(repo.slice(2)) === -1)
        || (n.archived && !showArchived)
        || (sc && !sc.has(s.id));
      if (hide !== s.hidden) { s.hidden = hide; changed = true; }
      if (s.g) s.g.style.display = hide ? 'none' : '';
    });
    var focus = hoverId || selectedId;
    var focusSet = null;
    if (focus && S[focus]) {
      focusSet = new Set([focus]);
      S[focus].nbrs.forEach(function (o) { focusSet.add(o.id); });
    }
    var dimBy = focusSet || matchSet || auditSet;
    all.forEach(function (s) {
      if (!s.g) return;
      s.g.classList.toggle('fade', !!(dimBy && !dimBy.has(s.id)));
      s.g.classList.toggle('hot', s.id === hoverId);
      s.g.classList.toggle('sel', s.id === selectedId);
      s.g.classList.toggle('hl', !!(auditSet && auditSet.has(s.id)) && !focusSet);
      s.g.classList.toggle('match', !!(matchSet && matchSet.has(s.id)));
    });
    E.forEach(function (e) {
      e.el.style.display = e.a.hidden || e.b.hidden ? 'none' : '';
      var hot = !!focus && (e.a.id === focus || e.b.id === focus);
      e.el.classList.toggle('hot', hot && !e.contra);
      e.el.setAttribute('marker-end', 'url(#' + (e.contra ? 'arrow-x' : hot ? 'arrow-hot' : 'arrow') + ')');
      var keep = focusSet ? hot : !dimBy || (dimBy.has(e.a.id) && dimBy.has(e.b.id));
      e.el.classList.toggle('fade', !keep);
    });
    edgeLabels(focus);
    labels();
    document.getElementById('shown').textContent = all.filter(function (s) { return !s.hidden; }).length + ' notes shown';
    if (changed) {
      reheat(0.35);
      if (opts.refit !== false) wait(function () { fitAll(true); }, 260);
    }
  }
  function edgeLabels(focus) {
    if (!elabels) return;
    elabels.textContent = '';
    E.forEach(function (e) { e.label = null; });
    if (focus) {
      E.forEach(function (e) {
        if (e.a.hidden || e.b.hidden || (e.a.id !== focus && e.b.id !== focus)) return;
        var t = document.createElementNS(svg.namespaceURI, 'text');
        t.setAttribute('class', 'elabel');
        t.setAttribute('text-anchor', 'middle');
        t.textContent = e.rel;
        e.label = t;
        elabels.appendChild(t);
      });
    }
    draw();
  }

  // --- hover card ----------------------------------------------------------------------
  var tip = document.getElementById('tip');
  function statusText(n) {
    var s = n.stale;
    if (!s) return null;
    if (s === 'unchecked') return ['unchecked', 'info'];
    if (s.status === 'rewritten') return ['history rewritten', 'danger'];
    return [s.commits + ' commits since capture', 'warn'];
  }
  function showTip(s) {
    tip.textContent = '';
    tip.appendChild(el('b', s.n.title || s.id));
    var m = el('div', null, 't-meta');
    m.appendChild(el('span', null, 'dot t-' + s.n.type));
    m.appendChild(document.createTextNode(s.n.type + ' · ' + s.n.degree + (s.n.degree === 1 ? ' link' : ' links')));
    var st = statusText(s.n);
    if (st) m.appendChild(el('span', st[0], 'tag ' + st[1]));
    tip.appendChild(m);
    tip.hidden = false;
    tip.dataset.id = s.id;
    positionTip();
  }
  function positionTip() {
    if (!tip || tip.hidden || !svg) return;
    var s = S[tip.dataset.id];
    if (!s) return;
    var r = rect();
    var g = graph.getBoundingClientRect();
    var k = r.width / vb[2];
    var x = r.left - g.left + (s.x - vb[0]) * k;
    tip.style.left = Math.max(150, Math.min(g.width - 150, x)) + 'px';
    tip.style.top = (r.top - g.top + (s.y - vb[1]) * k - s.r * k) + 'px';
  }
  function hideTip() { tip.hidden = true; }
  function setHover(id) {
    if (id === hoverId) return;
    hoverId = id;
    if (id) showTip(S[id]); else hideTip();
    refresh({ refit: false });
  }

  // --- pointer: pan the canvas, drag a note, click to select -----------------------------
  var pointers = new Map();
  var gesture = null;
  var hinted = false;
  function hint() {
    if (hinted) return;
    hinted = true;
    var h = document.getElementById('hint');
    if (h) h.style.opacity = '0';
  }
  if (svg) {
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = toSvg(e.clientX, e.clientY);
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(p[0], p[1], Math.exp(Math.max(-0.5, Math.min(0.5, dy * (e.ctrlKey ? 0.01 : 0.0016)))));
      hint();
    }, { passive: false });
    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      var g = e.target.closest && e.target.closest('g.node');
      gesture = { x: e.clientX, y: e.clientY, moved: false, node: g ? S[g.getAttribute('data-id')] : null, pinch: null };
    });
    svg.addEventListener('pointermove', function (e) {
      if (!gesture) {
        var g = e.target.closest && e.target.closest('g.node');
        setHover(g ? g.getAttribute('data-id') : null);
        return;
      }
      if (!pointers.has(e.pointerId)) return;
      var prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        var d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
        if (gesture.pinch) {
          var mid = toSvg((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
          zoomAt(mid[0], mid[1], gesture.pinch / d);
        }
        gesture.pinch = d;
        gesture.moved = true;
        gesture.node = null;
        return;
      }
      if (!gesture.moved && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < 4) return;
      if (!gesture.moved) {
        gesture.moved = true;
        svg.setPointerCapture(e.pointerId);
        hideTip();
        hint();
        if (gesture.node && !gesture.node.free) {
          alphaTarget = 0.25;
          reheat(0.3);
        } else {
          gesture.node = null;
          svg.classList.add('panning');
        }
      }
      if (gesture.node) {
        var p = toSvg(e.clientX, e.clientY);
        gesture.node.fx = p[0];
        gesture.node.fy = p[1];
        if (reduce) { settle(3); draw(); }
      } else {
        var k = vb[2] / rect().width;
        vb[0] -= (e.clientX - prev[0]) * k;
        vb[1] -= (e.clientY - prev[1]) * k;
        setVB();
      }
    });
    var end = function (e) {
      pointers.delete(e.pointerId);
      if (!gesture || pointers.size > 0) return;
      var gst = gesture;
      gesture = null;
      svg.classList.remove('panning');
      if (gst.node && gst.moved) {
        gst.node.fx = null;
        gst.node.fy = null;
        alphaTarget = 0;
        reheat(0.1);
        return;
      }
      if (!gst.moved && e.type === 'pointerup') {
        if (gst.node) select(gst.node.id, { frame: true });
        else if (selectedId) deselect();
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', function () { if (!gesture) setHover(null); });
    svg.addEventListener('dblclick', function (e) {
      var p = toSvg(e.clientX, e.clientY);
      zoomAt(p[0], p[1], 0.55);
    });
    svg.addEventListener('keydown', function (e) {
      var g = e.target.closest && e.target.closest('g.node');
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(g.getAttribute('data-id'), { frame: true }); }
    });
    svg.addEventListener('focusin', function (e) {
      var g = e.target.closest && e.target.closest('g.node');
      if (g) setHover(g.getAttribute('data-id'));
    });
    svg.addEventListener('focusout', function () { setHover(null); });
  }
  document.getElementById('zin').addEventListener('click', function () { zoomCentre(0.7); });
  document.getElementById('zout').addEventListener('click', function () { zoomCentre(1 / 0.7); });
  document.getElementById('zfit').addEventListener('click', function () { fitAll(true); });

  // --- drawer --------------------------------------------------------------------------
  var drawer = document.getElementById('drawer');
  var dBody = document.getElementById('drawer-body');
  var dTitle = document.getElementById('drawer-title');
  var dBack = document.getElementById('drawer-back');
  var browse = document.getElementById('browse');
  var detail = document.getElementById('detail');
  var auditPane = document.getElementById('audit-pane');
  var browseBtn = document.getElementById('browse-btn');
  var view = null;
  var backTo = null;
  function chip(key) { return document.querySelector('button[data-audit="' + key + '"]'); }
  function reframe() { if (svg) wait(function () { matchAspect(); setVB(); }, 270); }
  function openDrawer(which, title, back) {
    view = which;
    backTo = back || null;
    browse.hidden = which !== 'browse';
    detail.hidden = which !== 'note';
    auditPane.hidden = which !== 'audit';
    dTitle.textContent = title;
    dBack.hidden = !backTo;
    dBack.lastChild.textContent = backTo === 'browse' ? 'All notes' : backTo === 'audit' && auditKey ? chip(auditKey).getAttribute('data-label') : '';
    var wasOpen = drawer.classList.contains('open');
    drawer.classList.add('open');
    drawer.removeAttribute('aria-hidden');
    browseBtn.setAttribute('aria-pressed', String(which === 'browse'));
    dBody.scrollTop = 0;
    if (!wasOpen) reframe();
  }
  function closeDrawer() {
    if (!drawer.classList.contains('open')) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    browseBtn.setAttribute('aria-pressed', 'false');
    view = null;
    backTo = null;
    reframe();
  }
  document.getElementById('drawer-close').addEventListener('click', function () {
    backTo = null;
    if (selectedId) deselect(); else { if (auditKey) setAudit(null); closeDrawer(); }
  });
  dBack.addEventListener('click', function () { deselect(); });

  function staleCallout(n) {
    var s = n.stale;
    if (!s) return null;
    if (s === 'unchecked') {
      return el('div', 'Not checked: run agent-memory view from inside ' + (n.repos.length ? n.repos.join(' or ') : 'a git repository') + ' to measure it.', 'callout info');
    }
    if (s.status === 'rewritten') return el('div', 'History rewritten: the commit this was captured at is no longer in the repo. Check it still holds.', 'callout danger');
    return el('div', 'Captured ' + s.commits + ' commits ago. Worth checking it still holds.', 'callout warn');
  }

  function renderDetail(s) {
    var n = s.n;
    detail.textContent = '';
    var eb = el('div', null, 'eyebrow');
    eb.appendChild(el('span', null, 'dot t-' + n.type));
    eb.appendChild(document.createTextNode(n.type));
    if (n.archived) eb.appendChild(el('span', 'archived', 'tag'));
    detail.appendChild(eb);
    var h = el('h2', n.title || n.id, 'dtitle');
    h.tabIndex = -1;
    detail.appendChild(h);
    detail.appendChild(el('div', n.id, 'nid'));
    var mc = el('div', null, 'chips');
    mc.style.marginTop = '12px';
    (n.repos.length ? n.repos : ['global']).forEach(function (r) { mc.appendChild(el('span', r, 'pill')); });
    detail.appendChild(mc);
    var co = staleCallout(n);
    if (co) detail.appendChild(co);

    var rels = model.edges.filter(function (e) { return e.src === n.id || e.dst === n.id; });
    if (rels.length) {
      var hh = el('div', null, 'h4');
      hh.appendChild(el('span', 'Linked notes · ' + rels.length));
      if (!s.free) {
        var lg = el('button', scope ? 'Show whole graph' : 'Show only these', 'linkbtn');
        lg.type = 'button';
        lg.addEventListener('click', function () { setScope(scope ? 0 : 1); renderDetail(s); });
        hh.appendChild(lg);
      }
      detail.appendChild(hh);
      var list = el('div', null, 'nbs');
      rels.forEach(function (e) {
        var other = e.src === n.id ? e.dst : e.src;
        var o = S[other];
        var b = el('button', null, 'nb');
        b.type = 'button';
        b.appendChild(el('span', null, 'dot t-' + (o ? o.n.type : 'other')));
        b.appendChild(el('span', o ? (o.n.title || other) : other, 'nt'));
        b.appendChild(el('span', e.src === n.id ? e.rel + ' →' : '← ' + e.rel, 'rel'));
        if (e.dangling || !o || (o.n.archived && !showArchived)) {
          b.className = 'nb off';
          b.disabled = true;
          b.appendChild(el('span', e.dangling ? 'missing' : 'archived', 'tag'));
        } else {
          b.title = other;
          b.addEventListener('mouseenter', function () { setHover(other); });
          b.addEventListener('mouseleave', function () { setHover(null); });
          b.addEventListener('click', function () { select(other, { frame: true, back: backTo }); });
        }
        list.appendChild(b);
      });
      detail.appendChild(list);
    }
    var nh = el('div', null, 'h4');
    nh.appendChild(el('span', 'Note'));
    detail.appendChild(nh);
    detail.appendChild(el('pre', n.body || '(empty)', 'body'));
    var fm = el('details', null, 'fm');
    fm.appendChild(el('summary', 'Frontmatter'));
    var dl = el('dl', null, 'kv');
    Object.keys(n.frontmatter).forEach(function (k) {
      var v = n.frontmatter[k];
      dl.appendChild(el('dt', k));
      dl.appendChild(el('dd', typeof v === 'string' ? v : JSON.stringify(v)));
    });
    fm.appendChild(dl);
    detail.appendChild(fm);
  }

  function select(id, opts) {
    opts = opts || {};
    var s = S[id];
    if (!s) return;
    var back = opts.back !== undefined ? opts.back : view === 'browse' ? 'browse' : view === 'audit' ? 'audit' : view === 'note' ? backTo : null;
    selectedId = id;
    hoverId = null;
    hideTip();
    if (s.free) { body.classList.add('show-free'); if (scope) setScope(0, true); }
    renderDetail(s);
    openDrawer('note', s.n.type + ' note', back);
    Object.keys(rows).forEach(function (k) { rows[k].classList.toggle('sel', k === id); });
    syncScopeButtons();
    refresh({ refit: false });
    if (opts.frame) {
      wait(function () {
        fit([s].concat(s.free ? [] : s.nbrs.filter(function (o) { return !o.hidden; })), true);
      }, 280);
    }
  }
  function deselect() {
    var to = backTo;
    selectedId = null;
    if (scope) setScope(0, true);
    Object.keys(rows).forEach(function (k) { rows[k].classList.remove('sel'); });
    if (auditKey !== 'orphans' && !(matchSet && Array.from(matchSet).some(function (id) { return S[id].free; }))) body.classList.remove('show-free');
    if (to === 'browse') openBrowse();
    else if (to === 'audit' && auditKey) openAudit(auditKey);
    else closeDrawer();
    syncScopeButtons();
    refresh({ refit: false });
  }

  // --- local graph scope ------------------------------------------------------------------
  var segBtns = document.querySelectorAll('#scope button');
  function setScope(d, quiet) {
    scope = d;
    segBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(+b.getAttribute('data-depth') === d)); });
    if (!quiet) refresh();
  }
  segBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      setScope(+b.getAttribute('data-depth'));
      if (selectedId && S[selectedId]) renderDetail(S[selectedId]);
    });
  });
  function syncScopeButtons() {
    var ok = !!selectedId && S[selectedId] && !S[selectedId].free;
    segBtns.forEach(function (b) {
      if (+b.getAttribute('data-depth') > 0) {
        b.disabled = !ok;
        b.title = ok ? 'Show notes within ' + b.getAttribute('data-depth') + ' link(s) of the selected note' : 'Select a linked note first';
      }
    });
  }

  // --- type toggles: the legend is the filter --------------------------------------------
  document.querySelectorAll('#legend [data-type]').forEach(function (b) {
    var t = b.getAttribute('data-type');
    types[t] = true;
    b.addEventListener('click', function () {
      types[t] = !types[t];
      b.setAttribute('aria-pressed', String(types[t]));
      refresh();
    });
  });

  // --- browse: every note, grouped by type -------------------------------------------------
  var rows = Object.create(null);
  var listBox = document.getElementById('list');
  var groupType = null;
  model.nodes.forEach(function (n) {
    if (groupType !== n.type) {
      var h = el('div', null, 'group');
      h.appendChild(el('span', null, 'dot t-' + n.type));
      h.appendChild(document.createTextNode(n.type));
      listBox.appendChild(h);
      groupType = n.type;
    }
    var b = el('button', null, 'row' + (n.archived ? ' archived' : ''));
    b.type = 'button';
    var main = el('span', null, 'row-main');
    main.appendChild(el('span', n.title || n.id, 'row-title'));
    main.appendChild(el('span', n.id, 'row-id'));
    b.appendChild(main);
    var st = statusText(n);
    if (st) b.appendChild(el('span', st[1] === 'warn' ? n.stale.commits + ' commits' : st[0], 'tag ' + st[1]));
    b.addEventListener('mouseenter', function () { setHover(n.id); });
    b.addEventListener('mouseleave', function () { setHover(null); });
    b.addEventListener('click', function () { select(n.id, { frame: true, back: 'browse' }); });
    rows[n.id] = b;
    listBox.appendChild(b);
  });
  function openBrowse() { openDrawer('browse', 'All notes', null); }
  browseBtn.addEventListener('click', function () {
    if (view === 'browse') { closeDrawer(); return; }
    if (selectedId) { selectedId = null; if (scope) setScope(0, true); syncScopeButtons(); }
    if (auditKey) setAudit(null, true);
    openBrowse();
    refresh({ refit: false });
  });
  repoSel.addEventListener('change', function () { refresh(); });
  archBox.addEventListener('change', function () {
    showArchived = archBox.checked;
    body.classList.toggle('show-archived', showArchived);
    if (!showArchived && selectedId && S[selectedId] && S[selectedId].n.archived) deselect();
    refresh();
  });

  // --- audits ---------------------------------------------------------------------------------
  function auditIds(key) {
    var out = new Set();
    if (key === 'orphans' || key === 'stale') AUDITS[key].forEach(function (id) { out.add(id); });
    if (key === 'dangling') AUDITS.dangling.forEach(function (d) { out.add(d.src); });
    if (key === 'contradictions') AUDITS.contradictions.forEach(function (c) { out.add(c.a); out.add(c.b); });
    if (key === 'unchecked') model.nodes.forEach(function (n) { if (!n.archived && n.stale === 'unchecked') out.add(n.id); });
    return out;
  }
  var chips = document.querySelectorAll('button[data-audit]');
  function openAudit(key) {
    var c = chip(key);
    auditPane.textContent = '';
    auditPane.appendChild(el('p', c.title, 'lede'));
    if (key === 'broken') {
      AUDITS.broken.forEach(function (b) { auditPane.appendChild(el('div', b.path + ': ' + b.error, 'item')); });
    } else {
      auditIds(key).forEach(function (id) {
        var s = S[id];
        if (!s) return;
        var b = el('button', null, 'row');
        b.type = 'button';
        b.appendChild(el('span', null, 'dot t-' + s.n.type));
        var main = el('span', null, 'row-main');
        main.appendChild(el('span', s.n.title || id, 'row-title'));
        var sub = id;
        if (key === 'dangling') AUDITS.dangling.forEach(function (d) { if (d.src === id) sub = d.rel + ' → ' + d.dst + ' (missing)'; });
        if (key === 'contradictions') AUDITS.contradictions.forEach(function (x) { if (x.a === id) sub = 'contradicts ' + x.b; });
        main.appendChild(el('span', sub, 'row-id'));
        b.appendChild(main);
        if (key === 'stale' && s.n.stale && s.n.stale.commits) b.appendChild(el('span', s.n.stale.commits + ' commits', 'tag warn'));
        b.addEventListener('mouseenter', function () { setHover(id); });
        b.addEventListener('mouseleave', function () { setHover(null); });
        b.addEventListener('click', function () { select(id, { frame: true, back: 'audit' }); });
        auditPane.appendChild(b);
      });
    }
    openDrawer('audit', c.getAttribute('data-label') + ' · ' + c.querySelector('.n').textContent, null);
  }
  function setAudit(key, quiet) {
    auditKey = key;
    auditSet = key ? auditIds(key) : null;
    chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c.getAttribute('data-audit') === key)); });
    selectedId = null;
    if (scope) setScope(0, true);
    syncScopeButtons();
    body.classList.toggle('show-free', key === 'orphans' || (!!auditSet && Array.from(auditSet).some(function (id) { return S[id] && S[id].free; })));
    if (key) openAudit(key); else if (view === 'audit' && !quiet) closeDrawer();
    if (quiet) return;
    refresh({ refit: false });
    wait(function () {
      var list = key ? visibleList().filter(function (s) { return auditSet.has(s.id); }) : visibleList();
      fit(list.length ? list : visibleList(), true);
    }, 280);
  }
  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      var k = c.getAttribute('data-audit');
      setAudit(auditKey === k ? null : k);
    });
  });

  // --- search ----------------------------------------------------------------------------------
  var q = document.getElementById('q');
  var qMeta = document.getElementById('q-meta');
  var qTimer = 0;
  function runSearch() {
    var query = q.value.trim().toLowerCase();
    clearTimeout(qTimer);
    if (!query) {
      matchSet = null;
      qMeta.textContent = '';
      qMeta.appendChild(el('kbd', '/'));
      if (!auditKey && !(selectedId && S[selectedId].free)) body.classList.remove('show-free');
      refresh({ refit: false });
      return;
    }
    matchSet = new Set();
    all.forEach(function (s) {
      var n = s.n;
      if (!s.hidden && (n.id + '\n' + n.title + '\n' + n.body).toLowerCase().indexOf(query) !== -1) matchSet.add(s.id);
    });
    qMeta.textContent = matchSet.size ? matchSet.size + (matchSet.size === 1 ? ' match · ↵' : ' matches · ↵') : 'no matches';
    body.classList.toggle('show-free', Array.from(matchSet).some(function (id) { return S[id].free; }) || auditKey === 'orphans');
    refresh({ refit: false });
    qTimer = setTimeout(function () {
      var list = all.filter(function (s) { return matchSet && matchSet.has(s.id) && s.g; });
      if (list.length) fit(list, true);
    }, 350);
  }
  q.addEventListener('input', runSearch);
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && matchSet && matchSet.size) {
      e.preventDefault();
      select(Array.from(matchSet)[0], { frame: true });
    }
    if (e.key === 'Escape') { e.stopPropagation(); q.value = ''; runSearch(); q.blur(); }
  });

  // --- keyboard ----------------------------------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var typing = document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); q.focus(); q.select(); return; }
    if (typing) return;
    if (e.key === 'Escape') {
      if (selectedId) deselect();
      else if (auditKey) setAudit(null);
      else if (view) closeDrawer();
      return;
    }
    if (!svg) return;
    if (e.key === '+' || e.key === '=') zoomCentre(0.75);
    if (e.key === '-') zoomCentre(1 / 0.75);
    if (e.key === '0') fitAll(true);
    // Arrow keys walk the selected note's links, in order around it.
    if (selectedId && /^Arrow/.test(e.key) && S[selectedId]) {
      var cur = S[selectedId];
      var nb = cur.nbrs.filter(function (o) { return !o.hidden; });
      if (!nb.length) return;
      e.preventDefault();
      nb.sort(function (a, b) { return Math.atan2(a.y - cur.y, a.x - cur.x) - Math.atan2(b.y - cur.y, b.x - cur.x); });
      var fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      var last = cur.lastStep && nb.indexOf(cur.lastStep);
      var next = nb[((typeof last === 'number' && last >= 0 ? last : fwd ? -1 : 0) + (fwd ? 1 : -1) + nb.length) % nb.length];
      next.lastStep = cur;
      select(next.id, { frame: true, back: backTo });
    }
  });

  // --- start ---------------------------------------------------------------------------------------
  syncScopeButtons();
  if (svg && sims.length) {
    // Settle before the first paint: the page opens on a calm picture, not a jiggle.
    alpha = 1;
    settle(300);
    alpha = 0;
  }
  if (svg) {
    matchAspect();
    refresh({ refit: false });
    fitAll(false);
    var resizeT = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(function () { matchAspect(); setVB(); }, 60);
    });
  }
  runSearch();
}

/** "2026-11-19T22:10:15.518Z" reads as "2026-11-19 22:10 UTC"; anything else passes through. */
function prettyTime(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso));
  return m ? `${m[1]} ${m[2]} UTC` : String(iso ?? '');
}

/** The full page. `showArchived` sets the initial state of the archived toggle. */
export function renderHtml(model, positions, { showArchived = false } = {}) {
  const engagement = escapeHtml(model.engagement);
  const active = model.nodes.filter((n) => !n.archived).length;
  const archived = model.nodes.length - active;
  const legend = KNOWN_TYPES.map((t) => {
    const c = model.nodes.filter((n) => n.type === t && !n.archived).length;
    return `<button type="button" class="tchip" data-type="${t}" aria-pressed="true" title="Show or hide ${t} notes">`
      + `<span class="dot t-${t}"></span>${t}<span class="count">${c}</span></button>`;
  }).join('');
  const repos = [...new Set(model.nodes.flatMap((n) => n.repos))].sort();
  const graph = model.nodes.length
    ? renderSvg(model, positions)
    : '<svg viewBox="0 0 1200 400" role="img" aria-label="note graph"><text x="600" y="200" text-anchor="middle" class="shelf-title">NO NOTES YET</text></svg>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-memory: ${engagement}</title>
<style>${STYLE}</style>
</head>
<body${showArchived ? ' class="show-archived"' : ''}>
<div class="app">
<header class="top">
<div class="brand">
<div class="mark" aria-hidden="true"><svg viewBox="0 0 20 20"><line x1="5" y1="6" x2="14" y2="5"></line><line x1="5" y1="6" x2="9" y2="15"></line><line x1="14" y1="5" x2="9" y2="15"></line><circle cx="5" cy="6" r="2.6"></circle><circle cx="14" cy="5" r="2.2"></circle><circle cx="9" cy="15" r="2.8"></circle></svg></div>
<div><h1>agent-memory</h1><div class="sub">${engagement} · ${active} notes${archived ? ` · ${archived} archived` : ''} · ${escapeHtml(prettyTime(model.generated))}</div></div>
</div>
<label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg><input id="q" type="search" placeholder="Search notes" aria-label="Search notes by id, title or body" autocomplete="off"><span class="meta" id="q-meta"></span></label>
<button type="button" class="btn" id="browse-btn" aria-pressed="false" title="Browse every note"><svg viewBox="0 0 24 24" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6"></line><line x1="9" y1="12" x2="20" y2="12"></line><line x1="9" y1="18" x2="20" y2="18"></line><circle cx="4.5" cy="6" r="1"></circle><circle cx="4.5" cy="12" r="1"></circle><circle cx="4.5" cy="18" r="1"></circle></svg><span class="lbl">All notes</span></button>
<button type="button" class="btn icon" id="theme" aria-label="Theme">◐</button>
</header>
<nav class="audits" aria-label="Audits">
${renderAuditChips(model)}
</nav>
<main class="stage">
<section id="graph" aria-label="Graph">
${graph}
<div class="hud hud-tl"><span class="hint glass" id="hint">Scroll to zoom · drag to pan or move a note · click a note to open it</span></div>
<div class="hud hud-bl"><div class="legend glass" id="legend">${legend}</div><div class="seg glass" id="scope" role="group" aria-label="Show"><button type="button" data-depth="0" aria-pressed="true">Whole graph</button><button type="button" data-depth="1" aria-pressed="false">1 hop</button><button type="button" data-depth="2" aria-pressed="false">2 hops</button></div></div>
<div class="hud hud-br"><div class="zoom glass"><button type="button" id="zin" aria-label="Zoom in" title="Zoom in (+)">+</button><button type="button" id="zout" aria-label="Zoom out" title="Zoom out (−)">−</button><button type="button" id="zfit" aria-label="Fit to view" title="Fit (0)">⤢</button></div></div>
<div class="tip" id="tip" role="tooltip" hidden></div>
</section>
<aside class="drawer" id="drawer" aria-hidden="true" aria-label="Details">
<div class="drawer-in">
<div class="drawer-head"><button type="button" class="back" id="drawer-back" hidden><span aria-hidden="true">‹</span><span></span></button><span class="ttl" id="drawer-title"></span><button type="button" class="x" id="drawer-close" aria-label="Close" title="Close (Esc)">×</button></div>
<div class="drawer-body" id="drawer-body">
<section id="detail" aria-live="polite" hidden></section>
<section id="audit-pane" hidden></section>
<section id="browse" hidden>
<div class="ctl"><select id="repo" aria-label="Repository"><option value="">All repositories</option><option value="g:">Global (no repo)</option>${repos.map((r) => `<option value="r:${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}</select>
<label class="switch"><input id="show-archived" type="checkbox"${showArchived ? ' checked' : ''}> Archived</label></div>
<div class="sub" id="shown"></div>
<div id="list"></div>
</section>
</div>
</div>
</aside>
</main>
<footer class="note">Local snapshot of “${engagement}”, generated ${escapeHtml(model.generated)}. Secrets were scrubbed at capture; personal details were not. Do not share.</footer>
</div>
<script type="application/json" id="data">${embedJson(model)}</script>
<script>(${clientMain.toString()})();</script>
</body>
</html>
`;
}
