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
--bg:#0e1015;--surface:#161920;--surface-2:#1c2029;--border:#262b35;--border-strong:#353c48;
--text:#e7eaf0;--text-2:#a5adbb;--text-3:#717a8a;--accent:#8198ff;--accent-soft:rgba(129,152,255,.17);
--edge:#3b4250;--grid:rgba(231,234,240,.05);
--warn:#eaa84a;--warn-soft:rgba(234,168,74,.16);--danger:#f07070;--danger-soft:rgba(240,112,112,.14);
--info:#8198ff;--info-soft:rgba(129,152,255,.12);
--system:#6e9cf2;--decision:#f2a463;--convention:#55c495;--constraint:#b78ff2;--other:#8a93a3;
--shadow:0 1px 2px rgba(0,0,0,.3)`;

const STYLE = `
:root{color-scheme:light;
--bg:#f5f6f8;--surface:#fff;--surface-2:#f2f4f7;--border:#e4e7ec;--border-strong:#d0d5dd;
--text:#1b2230;--text-2:#576071;--text-3:#8a93a3;--accent:#4f6bed;--accent-soft:rgba(79,107,237,.13);
--edge:#c5cbd5;--grid:rgba(27,34,48,.07);
--warn:#b86e00;--warn-soft:rgba(232,153,30,.16);--danger:#cf3f3f;--danger-soft:rgba(207,63,63,.12);
--info:#4f6bed;--info-soft:rgba(79,107,237,.1);
--system:#4f7fd6;--decision:#e2873a;--convention:#35a174;--constraint:#9a68d6;--other:#8a93a3;
--shadow:0 1px 2px rgba(16,24,40,.04),0 2px 6px rgba(16,24,40,.05);--radius:14px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK_TOKENS}}}
:root[data-theme="dark"]{${DARK_TOKENS}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.app{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;gap:16px;height:100vh;height:100dvh;max-width:1680px;margin:0 auto;padding:18px 22px 12px}
.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px;min-width:0}
.mark{width:34px;height:34px;border-radius:10px;background:var(--accent-soft);display:grid;place-items:center;flex:none}
.mark svg{width:20px;height:20px}
.mark circle{fill:var(--accent)}.mark line{stroke:var(--accent);stroke-width:1.6}
h1{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em;line-height:1.2}
.sub{color:var(--text-3);font-size:12.5px}
.top-right{margin-left:auto;display:flex;gap:8px;align-items:center;flex:1 1 280px;justify-content:flex-end;min-width:0}
.search{position:relative;flex:1;max-width:380px}
.search input{width:100%;height:36px;padding:0 12px 0 34px;border-radius:10px;border:1px solid var(--border);background:var(--surface);box-shadow:var(--shadow)}
.search input::placeholder{color:var(--text-3)}
.search svg{position:absolute;left:11px;top:50%;width:15px;height:15px;transform:translateY(-50%);stroke:var(--text-3);fill:none;stroke-width:2}
.icon-btn{height:36px;min-width:36px;padding:0 9px;border-radius:10px;border:1px solid var(--border);background:var(--surface);box-shadow:var(--shadow);cursor:pointer;display:inline-grid;place-items:center;color:var(--text-2)}
.icon-btn:hover{color:var(--text);border-color:var(--border-strong)}
.cards{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.card{display:flex;flex-direction:column;gap:1px;text-align:left;padding:12px 14px 11px;border-radius:var(--radius);border:1px solid var(--border);background:var(--surface);box-shadow:var(--shadow);cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .15s;min-width:0}
.card:hover:not(:disabled){border-color:var(--border-strong);transform:translateY(-1px)}
.card:disabled{cursor:default}
.card .n{font-size:24px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.card .label{font-size:13px;font-weight:560}
.card .hint{font-size:12px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card.warn .n{color:var(--warn)}.card.danger .n{color:var(--danger)}.card.info .n{color:var(--info)}.card.zero .n{color:var(--text-3)}
.card.zero .label{color:var(--text-2)}
.card[aria-pressed="true"]{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.main{display:grid;grid-template-columns:minmax(0,1fr) 390px;gap:16px;min-height:0}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);min-height:0}
#graph{position:relative;overflow:hidden;display:flex;flex-direction:column;background-color:var(--surface);background-image:radial-gradient(var(--grid) 1px,transparent 1.2px);background-size:22px 22px}
#graph svg{display:block;width:100%;flex:1;min-height:0;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab}
#graph svg.dragging{cursor:grabbing}
.graph-bar{display:flex;align-items:center;gap:10px;padding:12px 12px 0}
.tools{margin-left:auto;display:flex;gap:6px;flex:none}
.tools .icon-btn{height:32px;min-width:32px;padding:0;font-size:16px;line-height:1}
.legend{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
.pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--border);background:var(--surface);font-size:12px;color:var(--text-2);white-space:nowrap}
.legend-hint{align-self:center;font-size:11.5px;color:var(--text-3);padding-left:4px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none;background:var(--other)}
.dot.t-system{background:var(--system)}.dot.t-decision{background:var(--decision)}.dot.t-convention{background:var(--convention)}.dot.t-constraint{background:var(--constraint)}
.edge{stroke:var(--edge);stroke-width:1.5;fill:none;transition:stroke .15s,opacity .2s}
.edge.contradicts{stroke:var(--danger);stroke-dasharray:6 4}
.edge.nbr{stroke:var(--accent);stroke-width:2}
.arrowhead{fill:var(--edge)}.arrowhead-x{fill:var(--danger)}
g.node{cursor:pointer;outline:none;transition:opacity .2s}
g.node .halo{fill:transparent;transition:fill .15s}
g.node:hover .halo,g.node:focus-visible .halo{fill:var(--accent-soft)}
g.node .nd{stroke:var(--surface);stroke-width:2.5;fill:var(--other)}
g.node .nd.t-system{fill:var(--system)}g.node .nd.t-decision{fill:var(--decision)}g.node .nd.t-convention{fill:var(--convention)}g.node .nd.t-constraint{fill:var(--constraint)}
g.node text{font-size:12.5px;fill:var(--text-2);paint-order:stroke;stroke:var(--surface);stroke-width:4px;stroke-linejoin:round}
g.node:hover text{fill:var(--text)}
g.node.sel .halo{fill:var(--accent-soft);stroke:var(--accent);stroke-width:2}
g.node.sel text{fill:var(--text);font-weight:650}
g.node.hl .halo{fill:var(--warn-soft);stroke:var(--warn);stroke-width:1.5}
.flag{fill:var(--warn);stroke:var(--surface);stroke-width:1.5}
.shelf{fill:var(--surface-2);stroke:var(--border)}
.shelf-title{font-size:10.5px;font-weight:650;letter-spacing:.08em;fill:var(--text-3)}
.dim{opacity:.13}
body:not(.show-archived) .archived{display:none}
aside{display:flex;flex-direction:column;overflow:auto;overscroll-behavior:contain}
.sec{padding:16px 18px;border-bottom:1px solid var(--border)}
.sec:last-child{border-bottom:0}
.sec-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px;font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-size:12.5px;color:var(--text-2);transition:background .15s,border-color .15s,opacity .15s}
.chip:hover{border-color:var(--border-strong);color:var(--text)}
.chip[aria-pressed="true"]{background:var(--surface-2);color:var(--text);border-color:var(--border-strong)}
.chip[aria-pressed="false"]{opacity:.5}
.chip .count{color:var(--text-3);font-variant-numeric:tabular-nums}
.row-ctl{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
select{height:32px;border-radius:9px;border:1px solid var(--border);background:var(--surface);padding:0 10px;font-size:13px;flex:1;min-width:140px}
.switch{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);cursor:pointer;user-select:none}
.switch input{appearance:none;-webkit-appearance:none;width:30px;height:18px;border-radius:999px;background:var(--border-strong);position:relative;cursor:pointer;margin:0;transition:background .15s}
.switch input::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.switch input:checked{background:var(--accent)}.switch input:checked::after{transform:translateX(12px)}
#list{display:flex;flex-direction:column;gap:2px}
.group{display:flex;align-items:center;gap:7px;margin:12px 0 4px;font-size:12px;font-weight:600;color:var(--text-2);text-transform:capitalize}
.group:first-child{margin-top:0}
.group .count{color:var(--text-3);font-weight:500}
.row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;background:none;border-radius:9px;padding:7px 9px;cursor:pointer}
.row:hover{background:var(--surface-2)}
.row.sel{background:var(--accent-soft)}
.row-main{display:flex;flex-direction:column;min-width:0;flex:1}
.row-title{font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-id{font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;flex:none;background:var(--surface-2);color:var(--text-2)}
.tag.warn{background:var(--warn-soft);color:var(--warn)}.tag.danger{background:var(--danger-soft);color:var(--danger)}.tag.info{background:var(--info-soft);color:var(--info)}
.audit-list{display:flex;flex-direction:column;gap:4px}
.audit-list .item{font-size:13px;color:var(--text-2);padding:6px 9px;border-radius:8px;background:var(--surface-2);word-break:break-word}
.audit-list .row{background:var(--surface-2)}
.audit-list .row:hover{background:var(--accent-soft)}
.empty{color:var(--text-3);font-size:13px;margin:0}
#detail .eyebrow{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);text-transform:capitalize}
#detail .x{margin-left:auto;border:0;background:none;color:var(--text-3);cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:6px}
#detail .x:hover{color:var(--text);background:var(--surface-2)}
#detail h2{margin:8px 0 4px;font-size:18px;line-height:1.3;font-weight:650;letter-spacing:-.01em;outline:none}
#detail .nid{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text-3);word-break:break-all}
#detail .meta-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.callout{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.45}
.callout.warn{background:var(--warn-soft);color:var(--warn)}
.callout.info{background:var(--info-soft);color:var(--info)}
.callout.danger{background:var(--danger-soft);color:var(--danger)}
#detail h4{margin:18px 0 8px;font-size:11px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3)}
.nb{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-height:28px;padding:3px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);cursor:pointer;font-size:12.5px;color:var(--text);text-align:left;word-break:break-all}
.nb:hover{border-color:var(--accent);background:var(--accent-soft)}
.nb .rel{color:var(--text-3);word-break:normal;white-space:nowrap}
.nb.off{cursor:default;color:var(--text-3)}.nb.off:hover{border-color:var(--border);background:var(--surface)}
.body{white-space:pre-wrap;word-break:break-word;font-size:13.5px;line-height:1.65;color:var(--text);background:var(--surface-2);border-radius:10px;padding:12px 14px;margin:0;font-family:inherit}
details.fm{margin-top:14px}
details.fm summary{cursor:pointer;font-size:12.5px;color:var(--text-2)}
dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:10px 0 0;font-size:12px}
dl.kv dt{color:var(--text-3)}dl.kv dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-word;color:var(--text-2)}
footer{font-size:11.5px;color:var(--text-3);text-align:center;padding:2px 0}
@media (max-width:1180px){.cards{grid-template-columns:repeat(3,minmax(0,1fr))}.main{grid-template-columns:minmax(0,1fr) 340px}}
@media (max-width:880px){.app{height:auto;padding:14px 16px 12px}.main{grid-template-columns:minmax(0,1fr)}#graph svg{flex:none;height:auto;aspect-ratio:var(--ar);min-height:260px;max-height:70vh}aside{overflow:visible}}
@media (max-width:560px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.top-right{flex-basis:100%}.search{max-width:none}.card .n{font-size:21px}.legend-hint{display:none}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const AUDIT_META = {
  orphans: { label: 'Unlinked', hint: 'no links in or out', tone: 'info' },
  dangling: { label: 'Dangling links', hint: 'point at missing notes', tone: 'danger' },
  contradictions: { label: 'Contradictions', hint: 'notes that disagree', tone: 'danger' },
  stale: { label: 'Stale', hint: 'captured 10+ commits ago', tone: 'warn' },
  broken: { label: 'Unreadable', hint: 'files that do not parse', tone: 'danger' },
  unchecked: { label: 'Unchecked', hint: 'other repos; not measured', tone: 'info' },
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

function renderSvg(model, positions) {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const shelf = shelfFrame(model, positions);
  const vb = sceneBox(model, positions);
  const parts = [`<svg viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" role="img" aria-label="note graph" preserveAspectRatio="xMidYMid meet" style="--ar:${vb.w} / ${vb.h}">`];
  parts.push('<defs>'
    + '<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 1L9 5L0 9z"></path></marker>'
    + '<marker id="arrow-x" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead-x" d="M0 1L9 5L0 9z"></path></marker>'
    + '</defs>');
  if (shelf) {
    const active = shelf.items.filter((n) => !n.archived).length;
    parts.push(`<rect class="shelf" x="${shelf.x}" y="${shelf.y}" width="${shelf.w}" height="${shelf.height}" rx="14"></rect>`);
    parts.push(`<text class="shelf-title" x="${round1(shelf.x + shelf.pad)}" y="${round1(shelf.y + 26)}">UNLINKED NOTES · ${active}</text>`);
  }
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
      `<line class="${cls}" data-src="${escapeHtml(e.src)}" data-dst="${escapeHtml(e.dst)}"`
      + ` x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${contra ? 'arrow-x' : 'arrow'})">`
      + `<title>${escapeHtml(`${e.src} ${e.rel} ${e.dst}`)}</title></line>`,
    );
  }
  for (const n of model.nodes) {
    const p = positions[n.id];
    if (!p) continue;
    const r = nodeRadius(n.degree);
    const onShelf = !n.degree;
    const type = KNOWN_TYPES.includes(n.type) ? ` t-${n.type}` : '';
    const stale = n.stale && typeof n.stale === 'object';
    const label = onShelf ? fitLabel(n.id, shelf.colW - 34) : n.id;
    const text = onShelf
      ? `<text x="${round1(p.x + r + 9)}" y="${round1(p.y + 4.5)}">${escapeHtml(label)}</text>`
      : `<text x="${p.x}" y="${round1(p.y + r + 17)}" text-anchor="middle">${escapeHtml(label)}</text>`;
    parts.push(
      `<g class="node${n.archived ? ' archived' : ''}" data-id="${escapeHtml(n.id)}">`
      + `<circle class="halo" cx="${p.x}" cy="${p.y}" r="${r + 6}"></circle>`
      + `<circle class="nd${type}" cx="${p.x}" cy="${p.y}" r="${r}"></circle>`
      + (stale ? `<circle class="flag" cx="${round1(p.x + r * 0.75)}" cy="${round1(p.y - r * 0.75)}" r="3.4"></circle>` : '')
      + text
      + `<title>${escapeHtml(`${n.id} (${n.type}): ${n.title}`)}</title></g>`,
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function renderCards(model) {
  return AUDIT_ORDER.map((k) => {
    const c = auditCount(model.audits, k);
    const m = AUDIT_META[k];
    return `<button type="button" class="card ${c ? m.tone : 'zero'}" data-audit="${k}" aria-pressed="false"${c ? '' : ' disabled'}>`
      + `<span class="n">${c}</span><span class="label">${m.label}</span><span class="hint">${c ? m.hint : 'none'}</span></button>`;
  }).join('\n');
}

/** Per-audit item lists, shown in the side panel while that audit's card is on. */
function renderAuditLists(model) {
  const a = model.audits;
  const titles = new Map(model.nodes.map((n) => [n.id, n.title || n.id]));
  const note = (id, extra) =>
    `<button type="button" class="row" data-go="${escapeHtml(id)}"><span class="row-main"><span class="row-title">${escapeHtml(titles.get(id) ?? id)}</span>`
    + `${extra ?? `<span class="row-id">${escapeHtml(id)}</span>`}</span></button>`;
  const lists = {
    orphans: a.orphans.map((id) => note(id)),
    stale: a.stale.map((id) => note(id)),
    unchecked: model.nodes.filter((n) => !n.archived && n.stale === 'unchecked').map((n) => note(n.id)),
    dangling: a.dangling.map((d) => note(d.src, `<span class="row-id">${escapeHtml(`${d.rel} → ${d.dst} (missing)`)}</span>`)),
    contradictions: a.contradictions.map((c) => note(c.a, `<span class="row-id">${escapeHtml(`contradicts ${c.b}`)}</span>`)),
    broken: a.broken.map((b) => `<div class="item">${escapeHtml(`${b.path}: ${b.error}`)}</div>`),
  };
  return AUDIT_ORDER.filter((k) => auditCount(a, k) > 0).map((k) =>
    `<section class="sec" data-audit-list="${k}" hidden><div class="sec-h"><span>${AUDIT_META[k].label} · ${auditCount(a, k)}</span>`
    + '<button type="button" class="chip" data-audit-clear>Clear</button></div>'
    + `<div class="audit-list">${lists[k].join('')}</div></section>`).join('\n');
}

/**
 * Browser-side behaviour. Kept as a real function so Node parses it at import time,
 * and serialised into the page with `toString()`. It must never contain the
 * characters that would close the script element it is placed in.
 */
function clientMain() {
  var model = JSON.parse(document.getElementById('data').textContent);
  // Null-prototype maps: an id like "constructor" must not hit an inherited key.
  var byId = Object.create(null);
  model.nodes.forEach(function (n) { byId[n.id] = n; });
  var gs = Object.create(null);
  document.querySelectorAll('g.node').forEach(function (g) { gs[g.getAttribute('data-id')] = g; });
  var lines = Array.prototype.slice.call(document.querySelectorAll('line[data-src]'));
  var rows = Object.create(null);
  var groups = [];
  var auditOn = null;
  var auditSet = null;
  var selected = null;
  var arch = document.getElementById('show-archived');
  var TYPES = ['system', 'decision', 'convention', 'constraint'];
  var types = Object.create(null);

  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  // Theme: follows the OS until chosen; the choice is a per-browser convenience only.
  var root = document.documentElement;
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

  // Type filter chips, with counts of active notes.
  var typeBox = document.getElementById('types');
  TYPES.forEach(function (t) {
    var count = model.nodes.filter(function (n) { return n.type === t && !n.archived; }).length;
    var b = el('button', null, 'chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'true');
    b.appendChild(el('span', null, 'dot t-' + t));
    b.appendChild(document.createTextNode(t));
    b.appendChild(el('span', String(count), 'count'));
    types[t] = true;
    b.addEventListener('click', function () {
      types[t] = !types[t];
      b.setAttribute('aria-pressed', String(types[t]));
      apply();
    });
    typeBox.appendChild(b);
  });

  var repoSel = document.getElementById('repo');
  // A Set, not an object: a repo named __proto__ or constructor is still a repo.
  var repos = new Set();
  model.nodes.forEach(function (n) { n.repos.forEach(function (r) { repos.add(r); }); });
  Array.from(repos).sort().forEach(function (r) {
    var o = el('option', r);
    // Prefixed so no repository name can collide with the "all" or "(global)" modes.
    o.value = 'r:' + r;
    repoSel.appendChild(o);
  });
  repoSel.addEventListener('change', apply);
  var q = document.getElementById('q');
  q.addEventListener('input', apply);

  function statusTag(n) {
    var s = n.stale;
    if (!s) return null;
    if (s === 'unchecked') return el('span', 'unchecked', 'tag info');
    if (s.status === 'rewritten') return el('span', 'rewritten', 'tag danger');
    return el('span', s.commits + ' commits', 'tag warn');
  }

  // Notes, grouped by type (the model is already sorted by type, then id).
  var list = document.getElementById('list');
  var current = null;
  model.nodes.forEach(function (n) {
    if (!current || current.type !== n.type) {
      var h = el('div', null, 'group');
      h.appendChild(el('span', null, 'dot t-' + n.type));
      h.appendChild(document.createTextNode(n.type + ' '));
      var c = el('span', '', 'count');
      h.appendChild(c);
      list.appendChild(h);
      current = { type: n.type, head: h, count: c, ids: [] };
      groups.push(current);
    }
    current.ids.push(n.id);
    var b = el('button', null, 'row' + (n.archived ? ' archived' : ''));
    b.type = 'button';
    var main = el('span', null, 'row-main');
    main.appendChild(el('span', n.title || n.id, 'row-title'));
    main.appendChild(el('span', n.id, 'row-id'));
    b.appendChild(main);
    var tag = statusTag(n);
    if (tag) b.appendChild(tag);
    b.addEventListener('click', function () { select(n.id, true); });
    rows[n.id] = b;
    list.appendChild(b);
  });

  function matches(n) {
    if (types[n.type] === false) return false;
    var r = repoSel.value;
    if (r === 'g:') { if (n.repos.length) return false; } else if (r && n.repos.indexOf(r.slice(2)) === -1) return false;
    var t = q.value.trim().toLowerCase();
    if (t && (n.id + '\n' + n.title + '\n' + n.body).toLowerCase().indexOf(t) === -1) return false;
    return true;
  }

  function apply() {
    var visible = Object.create(null);
    var shown = 0;
    model.nodes.forEach(function (n) {
      var on = matches(n) && (!auditSet || auditSet.has(n.id));
      visible[n.id] = on;
      if (gs[n.id]) {
        gs[n.id].classList.toggle('dim', !on);
        gs[n.id].classList.toggle('hl', !!(auditSet && auditSet.has(n.id)));
      }
      rows[n.id].hidden = !on;
      if (on && (!n.archived || arch.checked)) shown++;
    });
    groups.forEach(function (g) {
      var k = g.ids.filter(function (id) { return visible[id] && (!byId[id].archived || arch.checked); }).length;
      g.count.textContent = String(k);
      g.head.hidden = k === 0;
    });
    lines.forEach(function (l) {
      var on = visible[l.getAttribute('data-src')] && visible[l.getAttribute('data-dst')];
      l.classList.toggle('dim', !on);
    });
    document.getElementById('shown').textContent = shown + ' shown';
  }

  // --- pan and zoom: the viewBox is the camera ---------------------------------
  var svg = document.querySelector('#graph svg');
  var home = svg.getAttribute('viewBox').split(' ').map(Number);
  var vb = home.slice();
  function setVB() { svg.setAttribute('viewBox', vb.map(function (v) { return Math.round(v * 10) / 10; }).join(' ')); }
  function pxScale() {
    var r = svg.getBoundingClientRect();
    return Math.max(vb[2] / r.width, vb[3] / r.height);
  }
  function toSvg(cx, cy) {
    var r = svg.getBoundingClientRect();
    var s = pxScale();
    return [vb[0] + (cx - r.left) * s - (r.width * s - vb[2]) / 2, vb[1] + (cy - r.top) * s - (r.height * s - vb[3]) / 2];
  }
  function zoomAt(px, py, f) {
    var w = vb[2] * f;
    if (w < home[2] / 6) f = home[2] / 6 / vb[2];
    if (w > home[2] * 2.5) f = (home[2] * 2.5) / vb[2];
    vb[0] = px - (px - vb[0]) * f;
    vb[1] = py - (py - vb[1]) * f;
    vb[2] *= f;
    vb[3] *= f;
    setVB();
  }
  function zoomCenter(f) { zoomAt(vb[0] + vb[2] / 2, vb[1] + vb[3] / 2, f); }
  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = toSvg(e.clientX, e.clientY);
    var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(p[0], p[1], Math.exp(Math.max(-1, Math.min(1, dy * (e.ctrlKey ? 0.01 : 0.0018)))));
  }, { passive: false });
  var pointers = new Map();
  var drag = null;
  var suppressClick = false;
  svg.addEventListener('pointerdown', function (e) {
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    drag = { x: e.clientX, y: e.clientY, moved: false, pinch: null };
  });
  svg.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId) || !drag) return;
    var prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      if (drag.pinch) {
        var mid = toSvg((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
        zoomAt(mid[0], mid[1], drag.pinch / d);
      }
      drag.pinch = d;
      drag.moved = true;
      return;
    }
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('dragging');
    }
    var s = pxScale();
    vb[0] -= (e.clientX - prev[0]) * s;
    vb[1] -= (e.clientY - prev[1]) * s;
    setVB();
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (drag && drag.moved) suppressClick = true;
    if (pointers.size === 0) { drag = null; svg.classList.remove('dragging'); }
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  // A drag that ends over a note must not also open it.
  svg.addEventListener('click', function (e) {
    if (suppressClick) { e.stopPropagation(); suppressClick = false; }
  }, true);
  svg.addEventListener('dblclick', function (e) {
    var p = toSvg(e.clientX, e.clientY);
    zoomAt(p[0], p[1], 0.6);
  });
  document.getElementById('zin').addEventListener('click', function () { zoomCenter(0.75); });
  document.getElementById('zout').addEventListener('click', function () { zoomCenter(1 / 0.75); });
  document.getElementById('zfit').addEventListener('click', function () { vb = home.slice(); setVB(); });
  function reveal(id) {
    var c = gs[id] && gs[id].querySelector('.nd');
    if (!c) return;
    var x = +c.getAttribute('cx');
    var y = +c.getAttribute('cy');
    var mx = vb[2] * 0.1;
    var my = vb[3] * 0.1;
    if (x < vb[0] + mx || x > vb[0] + vb[2] - mx || y < vb[1] + my || y > vb[1] + vb[3] - my) {
      vb[0] = x - vb[2] / 2;
      vb[1] = y - vb[3] / 2;
      setVB();
    }
  }

  // --- detail ------------------------------------------------------------------
  var detail = document.getElementById('detail');
  function emptyDetail() {
    detail.textContent = '';
    detail.appendChild(el('div', 'Note', 'sec-h'));
    detail.appendChild(el('p', 'Select a note in the graph or the list to read it here.', 'empty'));
  }

  function staleCallout(n) {
    var s = n.stale;
    if (!s) return null;
    if (s === 'unchecked') {
      return el('div', 'Not checked: run agent-memory view from inside ' + (n.repos.length ? n.repos.join(' or ') : 'a git repository') + ' to measure it.', 'callout info');
    }
    if (s.status === 'rewritten') return el('div', 'History rewritten: the commit this was captured at is no longer in the repo. Check it still holds.', 'callout danger');
    return el('div', 'Captured ' + s.commits + ' commits ago. Worth checking it still holds.', 'callout warn');
  }

  function clearSelection() {
    if (selected && gs[selected]) gs[selected].classList.remove('sel');
    if (selected && rows[selected]) rows[selected].classList.remove('sel');
    lines.forEach(function (l) { l.classList.remove('nbr'); });
    selected = null;
    emptyDetail();
  }

  function select(id, fromList) {
    var n = byId[id];
    if (!n) return;
    if (selected && gs[selected]) gs[selected].classList.remove('sel');
    if (selected && rows[selected]) rows[selected].classList.remove('sel');
    selected = id;
    if (gs[id]) gs[id].classList.add('sel');
    if (rows[id]) rows[id].classList.add('sel');
    lines.forEach(function (l) {
      l.classList.toggle('nbr', l.getAttribute('data-src') === id || l.getAttribute('data-dst') === id);
    });
    detail.textContent = '';
    var eb = el('div', null, 'eyebrow');
    eb.appendChild(el('span', null, 'dot t-' + n.type));
    eb.appendChild(document.createTextNode(n.type));
    if (n.archived) eb.appendChild(el('span', 'archived', 'tag'));
    var x = el('button', '×', 'x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close note');
    x.addEventListener('click', clearSelection);
    eb.appendChild(x);
    detail.appendChild(eb);
    var h = el('h2', n.title || n.id);
    h.tabIndex = -1;
    detail.appendChild(h);
    detail.appendChild(el('div', n.id, 'nid'));
    var mc = el('div', null, 'meta-chips');
    if (n.repos.length) n.repos.forEach(function (r) { mc.appendChild(el('span', r, 'pill')); });
    else mc.appendChild(el('span', 'global', 'pill'));
    detail.appendChild(mc);
    var co = staleCallout(n);
    if (co) detail.appendChild(co);

    var links = el('div', null, 'chips');
    model.edges.forEach(function (e) {
      var other = e.src === id ? e.dst : e.dst === id ? e.src : null;
      if (other === null) return;
      var b = el('button', null, 'nb');
      b.type = 'button';
      b.appendChild(el('span', e.src === id ? e.rel + ' →' : '← ' + e.rel, 'rel'));
      b.appendChild(document.createTextNode(other));
      // A missing or hidden archived neighbour stays named but is not a way back in.
      if (e.dangling || (byId[other] && byId[other].archived && !arch.checked)) {
        b.className = 'nb off';
        b.disabled = true;
        b.appendChild(el('span', e.dangling ? '(missing)' : '(archived)', 'rel'));
      } else {
        b.addEventListener('click', function () {
          select(other, true);
          var t = detail.querySelector('h2');
          if (t) t.focus();
        });
      }
      links.appendChild(b);
    });
    if (links.childNodes.length) {
      detail.appendChild(el('h4', 'Linked notes'));
      detail.appendChild(links);
    }
    detail.appendChild(el('h4', 'Note'));
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
    if (fromList) reveal(id);
    if (window.matchMedia('(max-width: 880px)').matches) detail.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else document.querySelector('aside').scrollTop = 0;
  }

  Object.keys(gs).forEach(function (id) {
    // Keyboard reachable: Tab lands on each note, Enter or Space opens it.
    gs[id].setAttribute('tabindex', '0');
    gs[id].setAttribute('role', 'button');
    gs[id].setAttribute('aria-label', (byId[id] ? (byId[id].title || id) + ' (' + byId[id].type + ')' : id));
    gs[id].addEventListener('click', function () { select(id); });
    gs[id].addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); }
    });
  });

  arch.addEventListener('change', function () {
    document.body.classList.toggle('show-archived', arch.checked);
    // Hiding archives must hide an archived note already open in the detail pane too.
    if (!arch.checked && selected && byId[selected] && byId[selected].archived) clearSelection();
    else if (selected) select(selected); // re-render so neighbour links match the toggle
    apply();
  });

  // --- audits ------------------------------------------------------------------
  function auditIds(key) {
    var a = model.audits;
    // A Set, so an id like "constructor" is a member only when it is really in the audit.
    var out = new Set();
    if (key === 'orphans' || key === 'stale') a[key].forEach(function (id) { out.add(id); });
    if (key === 'dangling') a.dangling.forEach(function (d) { out.add(d.src); });
    if (key === 'contradictions') a.contradictions.forEach(function (c) { out.add(c.a); out.add(c.b); });
    if (key === 'unchecked') model.nodes.forEach(function (n) { if (!n.archived && n.stale === 'unchecked') out.add(n.id); });
    return out;
  }
  var cards = document.querySelectorAll('button[data-audit]');
  function setAudit(key) {
    auditOn = key;
    auditSet = key ? auditIds(key) : null;
    cards.forEach(function (c) { c.setAttribute('aria-pressed', String(c.getAttribute('data-audit') === key)); });
    document.querySelectorAll('[data-audit-list]').forEach(function (s) { s.hidden = s.getAttribute('data-audit-list') !== key; });
    apply();
  }
  cards.forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-audit');
      setAudit(auditOn === key ? null : key);
      if (auditOn) document.querySelector('aside').scrollTop = 0;
    });
  });
  document.querySelectorAll('[data-audit-clear]').forEach(function (b) {
    b.addEventListener('click', function () { setAudit(null); });
  });
  document.querySelectorAll('[data-go]').forEach(function (b) {
    b.addEventListener('click', function () { select(b.getAttribute('data-go'), true); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (selected) clearSelection(); else if (auditOn) setAudit(null); }
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  });

  emptyDetail();
  apply();
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
  const legend = KNOWN_TYPES.map((t) => `<span class="pill"><span class="dot t-${t}"></span>${t}</span>`).join('')
    + '<span class="legend-hint">Scroll to zoom · drag to pan</span>';
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
<div class="top-right">
<label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg><input id="q" type="search" placeholder="Search notes  ( / )" aria-label="Search notes by id, title or body"></label>
<button type="button" class="icon-btn" id="theme" aria-label="Theme">◐</button>
</div>
</header>
<nav class="cards" aria-label="Audits">
${renderCards(model)}
</nav>
<main class="main">
<section id="graph" class="panel" aria-label="Graph">
<div class="graph-bar"><div class="legend">${legend}</div>
<div class="tools"><button type="button" class="icon-btn" id="zin" aria-label="Zoom in" title="Zoom in">+</button><button type="button" class="icon-btn" id="zout" aria-label="Zoom out" title="Zoom out">−</button><button type="button" class="icon-btn" id="zfit" aria-label="Fit to view" title="Fit to view">⤢</button></div></div>
${graph}
</section>
<aside class="panel" aria-label="Notes">
${renderAuditLists(model)}
<section class="sec" id="detail" aria-live="polite"></section>
<section class="sec">
<div class="sec-h"><span>Filter</span><span id="shown"></span></div>
<div class="chips" id="types"></div>
<div class="row-ctl"><select id="repo" aria-label="Repository"><option value="">All repositories</option><option value="g:">Global (no repo)</option></select>
<label class="switch"><input id="show-archived" type="checkbox"${showArchived ? ' checked' : ''}> Show archived</label></div>
</section>
<section class="sec">
<div class="sec-h"><span>Notes</span></div>
<div id="list"></div>
</section>
</aside>
</main>
<footer>Local snapshot of engagement “${engagement}”, generated ${escapeHtml(model.generated)}. Secrets were scrubbed at capture; personal details were not. Do not share.</footer>
</div>
<script type="application/json" id="data">${embedJson(model)}</script>
<script>(${clientMain.toString()})();</script>
</body>
</html>
`;
}
