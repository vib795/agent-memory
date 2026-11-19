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
    if (Array.isArray(node.repos) && node.repos.length && !node.repos.includes(here)) return 'unchecked';
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

/**
 * Force-directed placement, computed once in Node so the page needs no script to
 * draw. Seeded and iteration-bounded, so the picture is the same on every run.
 */
export function layout(model, { width = 1200, height = 800 } = {}) {
  const ids = model.nodes.map((n) => n.id);
  const n = ids.length;
  if (n === 0) return {};
  const cx = width / 2;
  const cy = height / 2;
  const margin = 30;
  if (n === 1) return { [ids[0]]: { x: cx, y: cy } };

  const rand = mulberry32(1);
  const index = new Map(ids.map((id, i) => [id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const r0 = Math.min(width, height) / 2 - margin;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    // A little seeded jitter breaks the perfect symmetry a circle starts with.
    xs[i] = cx + r0 * Math.cos(a) + (rand() - 0.5) * 2;
    ys[i] = cy + r0 * Math.sin(a) + (rand() - 0.5) * 2;
  }

  const links = [];
  for (const e of model.edges) {
    if (e.dangling) continue;
    links.push([index.get(e.src), index.get(e.dst)]);
  }

  const k = Math.sqrt(((width - 2 * margin) * (height - 2 * margin)) / n);
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
        if (d2 < 0.01) {
          ddx = 0.1;
          ddy = 0.1;
          d2 = 0.02;
        }
        const f = k2 / d2; // k²/d, applied along the unit vector (ddx/d)
        dx[i] += ddx * f;
        dy[i] += ddy * f;
        dx[j] -= ddx * f;
        dy[j] -= ddy * f;
      }
    }
    for (const [a, b] of links) {
      const ddx = xs[a] - xs[b];
      const ddy = ys[a] - ys[b];
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      const f = d / k; // d²/k along the unit vector
      dx[a] -= ddx * f;
      dy[a] -= ddy * f;
      dx[b] += ddx * f;
      dy[b] += ddy * f;
    }
    for (let i = 0; i < n; i++) {
      // A firm pull to the centre. Unlinked notes feel only repulsion, so a weak pull
      // lets them drift far out, and fitting that spread to the canvas squeezes every
      // linked note into an unreadable knot in the middle.
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

  // Fit the settled layout to the canvas afterwards rather than clamping during the
  // run: a clamp pins every node that drifts outward to the same wall, where they stack
  // in a line and their labels overprint. One uniform scale keeps the shape the forces
  // found, and the right edge keeps room for the label each node draws beside itself.
  const LABEL_ROOM = 170;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]);
    minY = Math.min(minY, ys[i]); maxY = Math.max(maxY, ys[i]);
  }
  const availW = width - 2 * margin - LABEL_ROOM;
  const availH = height - 2 * margin;
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  const scale = Math.min(availW / bw, availH / bh);
  const offX = margin + (availW - bw * scale) / 2;
  const offY = margin + (availH - bh * scale) / 2;

  const out = {};
  for (let i = 0; i < n; i++) {
    const x = offX + (xs[i] - minX) * scale;
    const y = offY + (ys[i] - minY) * scale;
    out[ids[i]] = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
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

const COLORS = {
  system: '#4e79a7',
  decision: '#f28e2b',
  convention: '#59a14f',
  constraint: '#b07aa1',
};

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#222;background:#fafafa}
header{padding:8px 12px;border-bottom:1px solid #ddd;background:#fff}
.bar{display:flex;gap:8px;flex-wrap:wrap}
.bar button{font:inherit;border:1px solid #ccc;background:#f4f4f4;border-radius:4px;padding:3px 8px;cursor:pointer}
.bar button.nonzero{border-color:#c66;background:#fdeeee}
.bar button.on{outline:2px solid #333}
details{margin-top:4px}
details ul{margin:2px 0 2px 18px;padding:0}
main{display:flex;min-height:calc(100vh - 120px)}
#graph{flex:1;min-width:0;padding:8px}
#graph svg{width:100%;height:auto;background:#fff;border:1px solid #ddd}
aside{width:360px;border-left:1px solid #ddd;background:#fff;padding:8px 12px;overflow:auto;max-height:calc(100vh - 80px)}
aside h3{margin:10px 0 4px;font-size:13px}
#list{max-height:220px;overflow:auto;border:1px solid #eee}
#list button{display:block;width:100%;text-align:left;font:inherit;border:0;background:none;padding:2px 6px;cursor:pointer}
#list button:hover{background:#eef}
#detail table{border-collapse:collapse;width:100%}
#detail td{border-top:1px solid #eee;padding:2px 4px;vertical-align:top;word-break:break-word}
#detail pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;padding:6px;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace}
#detail a{color:#2457a6;cursor:pointer;margin-right:6px}
.badge{display:inline-block;background:#fde7c4;border:1px solid #e0a040;border-radius:3px;padding:0 6px;margin:4px 0}
g.node{cursor:pointer}
g.node text{font-size:11px;fill:#333}
line{stroke:#9a9a9a;stroke-width:1.2}
line.contradicts{stroke:#d62728;stroke-dasharray:4 3;stroke-width:1.6}
g.node.sel circle{stroke:#000;stroke-width:3}
.dim{opacity:.15}
g.node.hl circle{stroke:#d62728;stroke-width:3}
body:not(.show-archived) .archived{display:none}
footer{padding:8px 12px;color:#666;border-top:1px solid #ddd;font-size:12px}
`;

function renderSvg(model, positions, width, height) {
  const archivedIds = new Set(model.nodes.filter((n) => n.archived).map((n) => n.id));
  const parts = [`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="note graph">`];
  for (const e of model.edges) {
    if (e.dangling) continue;
    const a = positions[e.src];
    const b = positions[e.dst];
    const cls = [e.rel === 'contradicts' ? 'contradicts' : '',
      archivedIds.has(e.src) || archivedIds.has(e.dst) ? 'archived' : ''].filter(Boolean).join(' ');
    parts.push(
      `<line${cls ? ` class="${cls}"` : ''} data-src="${escapeHtml(e.src)}" data-dst="${escapeHtml(e.dst)}"`
      + ` x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}">`
      + `<title>${escapeHtml(`${e.src} ${e.rel} ${e.dst}`)}</title></line>`,
    );
  }
  for (const n of model.nodes) {
    const p = positions[n.id];
    const fill = COLORS[n.type] || '#888';
    const stroke = n.type === 'constraint' ? ' stroke="#5b3b56" stroke-width="3"' : '';
    parts.push(
      `<g class="node${n.archived ? ' archived' : ''}" data-id="${escapeHtml(n.id)}">`
      + `<circle cx="${p.x}" cy="${p.y}" r="7" fill="${fill}"${stroke}></circle>`
      + `<text x="${Math.round((p.x + 10) * 10) / 10}" y="${Math.round((p.y + 4) * 10) / 10}">${escapeHtml(n.id)}</text>`
      + `<title>${escapeHtml(`${n.id} (${n.type}): ${n.title}`)}</title></g>`,
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function auditItems(model, key) {
  const a = model.audits;
  switch (key) {
    case 'dangling': return a.dangling.map((d) => `${d.src} -${d.rel}-> ${d.dst}`);
    case 'contradictions': return a.contradictions.map((c) => `${c.a} contradicts ${c.b}`);
    case 'broken': return a.broken.map((b) => `${b.path}: ${b.error}`);
    case 'unchecked': return model.nodes.filter((n) => !n.archived && n.stale === 'unchecked').map((n) => n.id);
    default: return a[key];
  }
}

function renderAudits(model) {
  const buttons = AUDIT_ORDER.map((k) => {
    const c = auditCount(model.audits, k);
    return `<button type="button" data-audit="${k}"${c ? ' class="nonzero"' : ''}>${k} <b>${c}</b></button>`;
  });
  const lists = AUDIT_ORDER.filter((k) => auditCount(model.audits, k) > 0).map((k) =>
    `<details data-audit-list="${k}"><summary>${k} (${auditCount(model.audits, k)})</summary><ul>`
    + auditItems(model, k).map((s) => `<li>${escapeHtml(s)}</li>`).join('')
    + '</ul></details>');
  return `<div class="bar">${buttons.join('')}</div>\n${lists.join('\n')}`;
}

/**
 * Browser-side behaviour. Kept as a real function so Node parses it at import time,
 * and serialised into the page with `toString()`. It must never contain the
 * characters that would close the script element it is placed in.
 */
function clientMain() {
  var model = JSON.parse(document.getElementById('data').textContent);
  var byId = {};
  model.nodes.forEach(function (n) { byId[n.id] = n; });
  var gs = {};
  document.querySelectorAll('g.node').forEach(function (g) { gs[g.getAttribute('data-id')] = g; });
  var lines = Array.prototype.slice.call(document.querySelectorAll('line[data-src]'));
  var rows = {};
  var auditOn = null;
  var auditSet = null;
  var selected = null;

  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  // Filters: one checkbox per type, a repo dropdown, a free-text box.
  var types = {};
  var typeBox = document.getElementById('types');
  ['system', 'decision', 'convention', 'constraint'].forEach(function (t) {
    var label = el('label');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', function () { types[t] = cb.checked; apply(); });
    types[t] = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + t + ' '));
    typeBox.appendChild(label);
  });
  var repoSel = document.getElementById('repo');
  var repos = {};
  model.nodes.forEach(function (n) { n.repos.forEach(function (r) { repos[r] = true; }); });
  Object.keys(repos).sort().forEach(function (r) {
    var o = el('option', r);
    o.value = r;
    repoSel.appendChild(o);
  });
  repoSel.addEventListener('change', apply);
  var q = document.getElementById('q');
  q.addEventListener('input', apply);

  var list = document.getElementById('list');
  model.nodes.forEach(function (n) {
    var b = el('button', n.id + ' (' + n.type + ')', n.archived ? 'archived' : '');
    b.type = 'button';
    b.addEventListener('click', function () { select(n.id); });
    rows[n.id] = b;
    list.appendChild(b);
  });

  function matches(n) {
    if (!types[n.type]) return false;
    var r = repoSel.value;
    if (r === '__global') { if (n.repos.length) return false; } else if (r && n.repos.indexOf(r) === -1) return false;
    var t = q.value.trim().toLowerCase();
    if (t && (n.id + '\n' + n.title + '\n' + n.body).toLowerCase().indexOf(t) === -1) return false;
    return true;
  }

  function apply() {
    var visible = {};
    model.nodes.forEach(function (n) {
      var on = matches(n) && (!auditSet || auditSet[n.id]);
      visible[n.id] = on;
      if (gs[n.id]) {
        gs[n.id].classList.toggle('dim', !on);
        gs[n.id].classList.toggle('hl', !!(auditSet && auditSet[n.id]));
      }
      rows[n.id].classList.toggle('dim', !on);
    });
    lines.forEach(function (l) {
      var on = visible[l.getAttribute('data-src')] && visible[l.getAttribute('data-dst')];
      l.classList.toggle('dim', !on);
    });
  }

  function staleText(n) {
    var s = n.stale;
    if (!s) return '';
    if (s === 'unchecked') return 'not checked: run from inside ' + (n.repos.length ? n.repos.join(' or ') : 'a git repository');
    if (s.status === 'rewritten') return 'history rewritten';
    return 'stale: ' + s.commits + ' commits';
  }

  function select(id) {
    var n = byId[id];
    if (!n) return;
    if (selected && gs[selected]) gs[selected].classList.remove('sel');
    selected = id;
    if (gs[id]) gs[id].classList.add('sel');
    var d = document.getElementById('detail');
    d.textContent = '';
    d.appendChild(el('h3', n.title));
    d.appendChild(el('div', n.id + ' · ' + n.type + (n.archived ? ' · archived' : '')));
    d.appendChild(el('div', 'repos: ' + (n.repos.length ? n.repos.join(', ') : '(global)')));
    var st = staleText(n);
    if (st) d.appendChild(el('div', st, 'badge'));
    var nb = el('div');
    nb.appendChild(el('b', 'neighbors: '));
    model.edges.forEach(function (e) {
      var other = e.src === id ? e.dst : e.dst === id ? e.src : null;
      if (other === null) return;
      var label = (e.src === id ? e.rel + ' → ' : '← ' + e.rel + ' ') + other;
      if (e.dangling) { nb.appendChild(el('span', label + ' (missing) ')); return; }
      var a = el('a', label);
      a.addEventListener('click', function () { select(other); });
      nb.appendChild(a);
    });
    d.appendChild(nb);
    var tbl = el('table');
    Object.keys(n.frontmatter).forEach(function (k) {
      var v = n.frontmatter[k];
      var tr = el('tr');
      tr.appendChild(el('td', k));
      tr.appendChild(el('td', typeof v === 'string' ? v : JSON.stringify(v)));
      tbl.appendChild(tr);
    });
    d.appendChild(tbl);
    d.appendChild(el('pre', n.body));
  }

  Object.keys(gs).forEach(function (id) {
    gs[id].addEventListener('click', function () { select(id); });
  });

  var arch = document.getElementById('show-archived');
  arch.addEventListener('change', function () {
    document.body.classList.toggle('show-archived', arch.checked);
  });

  function auditIds(key) {
    var a = model.audits;
    var out = {};
    if (key === 'orphans' || key === 'stale') a[key].forEach(function (id) { out[id] = true; });
    if (key === 'dangling') a.dangling.forEach(function (d) { out[d.src] = true; });
    if (key === 'contradictions') a.contradictions.forEach(function (c) { out[c.a] = true; out[c.b] = true; });
    if (key === 'unchecked') model.nodes.forEach(function (n) { if (!n.archived && n.stale === 'unchecked') out[n.id] = true; });
    return out;
  }

  document.querySelectorAll('button[data-audit]').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-audit');
      document.querySelectorAll('button[data-audit]').forEach(function (x) { x.classList.remove('on'); });
      if (auditOn === key) {
        auditOn = null;
        auditSet = null;
      } else {
        auditOn = key;
        auditSet = auditIds(key);
        b.classList.add('on');
        var det = document.querySelector('details[data-audit-list="' + key + '"]');
        if (det) det.open = true;
      }
      apply();
    });
  });
}

/** The full page. `showArchived` sets the initial state of the archived toggle. */
export function renderHtml(model, positions, { showArchived = false, width = 1200, height = 800 } = {}) {
  const engagement = escapeHtml(model.engagement);
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
<header>
${renderAudits(model)}
</header>
<main>
<div id="graph">
${renderSvg(model, positions, width, height)}
</div>
<aside>
<h3>Filter</h3>
<div id="types"></div>
<div><select id="repo"><option value="">all repos</option><option value="__global">(global)</option></select></div>
<div><input id="q" type="search" placeholder="id, title or body" style="width:100%"></div>
<div><label><input id="show-archived" type="checkbox"${showArchived ? ' checked' : ''}> show archived</label></div>
<h3>Notes (${model.nodes.length})</h3>
<div id="list"></div>
<div id="detail"><p>Click a node or a row for its details.</p></div>
</aside>
</main>
<footer>Local snapshot of engagement "${engagement}", generated ${escapeHtml(model.generated)}. Secrets were scrubbed at capture; personal details were not. Do not share.</footer>
<script type="application/json" id="data">${embedJson(model)}</script>
<script>(${clientMain.toString()})();</script>
</body>
</html>
`;
}
