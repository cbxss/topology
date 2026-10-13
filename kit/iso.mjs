// The drawing core: an orthographic camera over a floor (x, y) with z up, shaded prisms,
// lines laid on faces, SVG string emitters, and the framed card a figure sits in.
// World units are about one pixel of the real thing; the camera is fitted to the scene.

const DEG = Math.PI / 180;

// --- camera -------------------------------------------------------------------------------------

// P = { origin: [sx, sy], scale, azimuth, elevation } (degrees). Azimuth turns the floor;
// elevation tilts it toward the viewer: 90 looks straight down.
export function cameraOf(P) {
  const a = (P.azimuth ?? 45) * DEG;
  const e = (P.elevation ?? 30) * DEG;
  return { sa: Math.sin(a), ca: Math.cos(a), se: Math.sin(e), ce: Math.cos(e), k: P.scale };
}

export function iso([x, y, z], P) {
  const c = cameraOf(P);
  const across = x * c.sa - y * c.ca;
  const away = x * c.ca + y * c.sa;
  return [P.origin[0] + across * c.k, P.origin[1] + (away * c.se - z * c.ce) * c.k];
}

// Larger is nearer the viewer: sort ascending to paint back to front.
export function depthOf([x, y, z], P) {
  const c = cameraOf(P);
  return (x * c.ca + y * c.sa) * c.ce + z * c.se;
}

// The floor direction that points at the viewer: faces whose normal has a positive dot
// product with it are visible.
const viewerOf = (P) => {
  const c = cameraOf(P);
  return [c.ca, c.sa];
};

// Fit these world points into a width × height box with `pad` to spare.
// `maxScale` caps the zoom, so a small scene stays at its natural size, centred.
export function fitProjection(points, width, height, { pad = 24, azimuth = 45, elevation = 30, maxScale = Infinity } = {}) {
  const unit = { origin: [0, 0], scale: 1, azimuth, elevation };
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const point of points) {
    const [x, y] = iso(point, unit);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const scale = Math.min(maxScale, (width - 2 * pad) / Math.max(x1 - x0, 1e-6), (height - 2 * pad) / Math.max(y1 - y0, 1e-6));
  return { origin: [width / 2 - ((x0 + x1) / 2) * scale, height / 2 - ((y0 + y1) / 2) * scale], scale, azimuth, elevation };
}

export const pointsAt = (points, P) => points.map((point) => iso(point, P));

// --- paths --------------------------------------------------------------------------------------

const num = (n) => {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
};
export function pathOf(points, closed = false) {
  if (!points.length) return "";
  let d = "";
  points.forEach(([x, y], i) => (d += `${i ? "L" : "M"}${num(x)} ${num(y)}`));
  return closed ? d + "Z" : d;
}

// Monotone-chain convex hull of screen points.
export function convexHull(points) {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const turn = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length > 1 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half(sorted.slice().reverse())];
}

// --- plans on the floor ---------------------------------------------------------------------------

// A plan is a rounded rectangle { x, y, w, d, r } on the floor.
export const insetPlan = ({ x, y, w, d, r }, by) => ({ x: x + by, y: y + by, w: w - 2 * by, d: d - 2 * by, r: Math.max(0, r - by) });

// The plan's outline as floor points, counter-clockwise seen from above (x right, y down).
export function roundedPlan({ x, y, w, d, r }, steps = 8) {
  const rr = Math.max(0, Math.min(r, w / 2, d / 2));
  const centres = [
    [x + w - rr, y + rr, -90],
    [x + w - rr, y + d - rr, 0],
    [x + rr, y + d - rr, 90],
    [x + rr, y + rr, 180],
  ];
  const out = [];
  for (const [cx, cy, from] of centres) {
    const n = rr > 0 ? steps : 0;
    for (let i = 0; i <= n; i++) {
      const t = (from + (n ? (90 * i) / n : 45)) * DEG;
      out.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
    }
  }
  return out;
}

export function circleRing(cx, cy, r, steps = 40) {
  return Array.from({ length: steps }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / steps), cy + r * Math.sin((2 * Math.PI * i) / steps)]);
}

export const corners = ({ x, y, w, d }, inset = 0) => [
  [x + inset, y + inset],
  [x + w - inset, y + inset],
  [x + inset, y + d - inset],
  [x + w - inset, y + d - inset],
];

export function boxCorners({ x, y, w, d }, z0, z1) {
  const out = [];
  for (const px of [x, x + w]) for (const py of [y, y + d]) for (const z of [z0, z1]) out.push([px, py, z]);
  return out;
}

// --- solids -------------------------------------------------------------------------------------

// A convex floor outline extruded from z to z + height. Each visible side gets one of four
// tones by how squarely it faces the light (from the viewer's left); the top is lightest.
// Returns paths: fill (hides what's behind), shades[4], top, crease (top meets sides),
// bevel (a highlight just inside the visible top edges) and outline (the silhouette).
export function extrude(ring, z, height, P, { bevel = 0 } = {}) {
  const n = ring.length;
  let area = 0;
  for (let i = 0; i < n; i++) area += ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1];
  const outward = area > 0 ? 1 : -1;
  const view = viewerOf(P);
  const c = cameraOf(P);
  const light = [-c.sa, c.ca];
  const top = ring.map(([x, y]) => iso([x, y, z + height], P));
  const base = ring.map(([x, y]) => iso([x, y, z], P));
  const shades = [[], [], [], []];
  const crease = [];
  const bevels = [];
  const centre = ring.reduce((sum, p) => [sum[0] + p[0] / n, sum[1] + p[1] / n], [0, 0]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const normal = [(outward * (by - ay)) / len, (-outward * (bx - ax)) / len];
    if (normal[0] * view[0] + normal[1] * view[1] <= 1e-9) continue;
    if (height > 0) {
      const lit = (normal[0] * light[0] + normal[1] * light[1] + 1) / 2;
      shades[Math.min(3, Math.floor(lit * 4))].push(pathOf([top[i], top[j], base[j], base[i]], true));
    }
    crease.push(pathOf([top[i], top[j]]));
    if (bevel > 0) {
      const inset = (p) => {
        const dx = centre[0] - p[0];
        const dy = centre[1] - p[1];
        const l = Math.hypot(dx, dy) || 1;
        return iso([p[0] + (dx / l) * bevel, p[1] + (dy / l) * bevel, z + height], P);
      };
      bevels.push(pathOf([inset(ring[i]), inset(ring[j])]));
    }
  }
  const hull = convexHull([...top, ...base]);
  return {
    fill: pathOf(hull, true),
    shades: shades.map((list) => list.join("")),
    top: pathOf(top, true),
    crease: crease.join(""),
    bevel: bevels.join(""),
    outline: pathOf(hull, true),
  };
}

export const slabOf = (plan, z, height, P, steps = 8, bevel = 0) => extrude(roundedPlan(plan, steps), z, height, P, { bevel });
export const cylinder = (cx, cy, r, z, height, P, steps = 32, bevel = 0) => extrude(circleRing(cx, cy, r, steps), z, height, P, { bevel });
// A soft shadow under something: the slab's fill, blurred by CSS.
export const haloOf = (plan, z, height, P) => slabOf(plan, z, height, P).fill;

// --- lines on faces -----------------------------------------------------------------------------

export const onTop = (points, z, P, closed = false) => pathOf(points.map(([x, y]) => iso([x, y, z], P)), closed);
export const lineOnTop = (a, b, z, P) => onTop([a, b], z, P);
export const segment = (a, b, P) => pathOf([iso(a, P), iso(b, P)]);
export const planOutline = (plan, z, P, steps = 8) => onTop(roundedPlan(plan, steps), z, P, true);
export const ring = (cx, cy, r, z, P, steps = 40) => onTop(circleRing(cx, cy, r, steps), z, P, true);

// The half of a horizontal circle at height z that faces the viewer: a band on a cylinder.
export function sideArc(cx, cy, r, z, P, steps = 24) {
  const [vx, vy] = viewerOf(P);
  const mid = Math.atan2(vy, vx);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = mid - Math.PI / 2 + (Math.PI * i) / steps;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t), z]);
  }
  return pathOf(pointsAt(pts, P));
}

// The visible near side of a plan at height z: a seam that wraps a box's corners.
export function sideSeam(plan, z, P, steps = 8) {
  const pts = roundedPlan(plan, steps);
  const [vx, vy] = viewerOf(P);
  const cx = plan.x + plan.w / 2;
  const cy = plan.y + plan.d / 2;
  const facing = pts.map(([x, y]) => (x - cx) * vx + (y - cy) * vy > 0);
  // Start just after a hidden point so the visible run is contiguous.
  const start = facing.findIndex((f, i) => !f && facing[(i + 1) % pts.length]);
  if (start < 0) return "";
  const run = [];
  for (let k = 1; k <= pts.length; k++) {
    const i = (start + k) % pts.length;
    if (!facing[i]) break;
    run.push([...pts[i], z]);
  }
  return pathOf(pointsAt(run, P));
}

// Ticks pointing inward from radius r on a horizontal face: every `every`th is major.
// Angle 0 points to −y and runs clockwise seen from above.
export function radialTicks(cx, cy, r, count, every, z, [minor, major], P) {
  const out = { minor: "", major: "" };
  for (let i = 0; i < count; i++) {
    const t = (2 * Math.PI * i) / count;
    const big = i % every === 0;
    const len = big ? major : minor;
    const ux = Math.sin(t);
    const uy = -Math.cos(t);
    const d = lineOnTop([cx + ux * r, cy + uy * r], [cx + ux * (r - len), cy + uy * (r - len)], z, P);
    if (big) out.major += d;
    else out.minor += d;
  }
  return out;
}

// An SVG transform that lays text flat on the floor at `at`, reading along x or y.
export function topMatrix(at, z, P, along = "x") {
  const o = iso([at[0], at[1], z], P);
  const vec = (dx, dy) => {
    const p = iso([at[0] + dx, at[1] + dy, z], P);
    return [p[0] - o[0], p[1] - o[1]];
  };
  const [u, v] = along === "y" ? [vec(0, -1), vec(1, 0)] : [vec(1, 0), vec(0, 1)];
  return `matrix(${[u[0], u[1], v[0], v[1], o[0], o[1]].map((n) => n.toFixed(4)).join(" ")})`;
}

// --- SVG strings --------------------------------------------------------------------------------

export const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// tone: hi | mid | lo | faint (the outline); crease: tone of the top edges, or "none";
// lit: the one accent part.
export function solidSvg(paths, { tone = "hi", crease = "faint", lit = false } = {}) {
  let out = `<g class="k-solid"${lit ? " data-lit" : ""}><path class="k-fill" d="${paths.fill}"/>`;
  paths.shades.forEach((d, i) => d && (out += `<path class="k-shade" data-shade="${i}" d="${d}"/>`));
  out += `<path class="k-top" d="${paths.top}"/>`;
  if (crease !== "none" && paths.crease) out += `<path class="k-line k-crease" data-tone="${crease}" d="${paths.crease}"/>`;
  if (crease !== "none" && paths.bevel) out += `<path class="k-line k-bevel" data-tone="${crease}" d="${paths.bevel}"/>`;
  return out + `<path class="k-line k-edge" data-tone="${tone}" d="${paths.outline}"/></g>`;
}

// free: true | "start" | "end" marks a line end that is meant to stop on a bare face
// (printed text, a pointer tip, an arrowhead) for scripts/lines.mjs.
export function lineSvg(d, { tone = "lo", dashed = false, free } = {}) {
  if (!d) return "";
  const freeAttr = free === true ? ' data-free=""' : free ? ` data-free="${free}"` : "";
  return `<path class="k-line" data-tone="${tone}"${dashed ? " data-dashed" : ""}${freeAttr} d="${d}"/>`;
}

export function dotsSvg(points, { size = 0.5, tone = "mid" } = {}) {
  return `<g class="k-dots" data-tone="${tone}">${points.map(([x, y]) => `<circle cx="${num(x)}" cy="${num(y)}" r="${size}"/>`).join("")}</g>`;
}

export function faceTextSvg(transform, text, { size = 3, tone = "mid", anchor = "start" } = {}) {
  return `<text class="k-text" data-tone="${tone}" transform="${transform}" font-size="${size}" text-anchor="${anchor}">${escape(text)}</text>`;
}

export function figureSvg({ width, height, label, body, className = "" }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="k-svg${className ? " " + className : ""}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(label)}">${[].concat(body).join("")}</svg>`;
}

// --- the card and the page ----------------------------------------------------------------------

const SWATCH = {
  lit: "M2 4.5 8 1.5 14 4.5 14 6 8 9 2 6Z",
  raised: "M2 4.5 8 1.5 14 4.5 14 6 8 9 2 6Z",
};
function swatch(mark) {
  const d = SWATCH[mark] || "M1.5 5h13";
  return `<svg class="k-swatch" data-mark="${mark}" viewBox="0 0 16 10" aria-hidden="true"><path d="${d}"/></svg>`;
}

// A framed card: Fig n top left, title top right, hint bottom left, live readout bottom
// right ([data-readout]), then the legend keys and a caption under it.
export function plateHtml({ fig, title, hint, readout = "", keys = [], caption, body }) {
  const corner = (name, text, extra = "") => `<span class="k-corner" data-corner="${name}"${extra}>${escape(text ?? "")}</span>`;
  const legend = keys.length || caption ? `<figcaption class="k-legend">${keys.length ? `<span class="k-keys">${keys.map((key) => `<span class="k-key">${swatch(key.mark)}${escape(key.label)}</span>`).join("")}</span>` : ""}${caption ? `<span class="k-caption">${escape(caption)}</span>` : ""}</figcaption>` : "";
  return `<figure class="k-figure"><div class="k-card"><div class="k-corners" aria-hidden="true">${corner("fig", fig)}${title ? corner("title", title) : ""}${hint ? corner("hint", hint) : ""}${corner("readout", readout, " data-readout")}</div>${body}</div>${legend}</figure>`;
}

export function pageHtml({ title, theme = "dark", body, script = "", width = 650 }) {
  const code = script ? `<script type="module">${script.replace(/<\/(script)/gi, "<\\/$1")}</script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${KIT_CSS}
*{box-sizing:border-box}html{color-scheme:dark}body[data-theme="light"]{color-scheme:light}
body{margin:0;background:var(--tp-page);color:var(--tp-text);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.k-page{width:min(${width}px,100% - 32px);margin:64px auto 96px}</style></head><body class="tp" data-theme="${theme}"><main class="k-page">${body}</main>${code}</body></html>`;
}

// Palette tokens (--tp-*) for both themes, the solids and lines, and the card.
export const KIT_CSS = `
.tp{
  --tp-page:#0a0a0b;--tp-card:#121214;--tp-text:#a4a4a8;--tp-strong:#e8e8ea;--tp-muted:#6c6c72;
  --tp-face:#1a1a1d;--tp-top:#1d1d20;--tp-lit-top:#28282c;--tp-lit-shade:#1e1e21;
  --tp-shade-0:#0e0e10;--tp-shade-1:#111113;--tp-shade-2:#151517;--tp-shade-3:#18181b;
  --tp-hi:#d6d6da;--tp-mid:#6b6b71;--tp-lo:#3d3d42;--tp-faint:#29292d;--tp-lit:#ffffff;
  --tp-halo:#040405;--tp-halo-opacity:.9;--tp-dot:#e8e8ea;
  --tp-red:#ff6b6b;--tp-green:#6be0a0;--tp-blue:#6b9bff;--tp-amber:#f0b64a;
  --tp-weight:.6px;--tp-ease:cubic-bezier(.32,.72,0,1);
  --tp-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
.tp[data-theme="light"]{
  --tp-page:#f1f1ee;--tp-card:#fafaf8;--tp-text:#56565a;--tp-strong:#18181a;--tp-muted:#8b8b90;
  --tp-face:#ffffff;--tp-top:#ffffff;--tp-lit-top:#ffffff;--tp-lit-shade:#ededea;
  --tp-shade-0:#dbdbd8;--tp-shade-1:#e4e4e1;--tp-shade-2:#ecece9;--tp-shade-3:#f3f3f0;
  --tp-hi:#25252a;--tp-mid:#89898e;--tp-lo:#b3b3b7;--tp-faint:#d3d3d5;--tp-lit:#000000;
  --tp-halo:#88887e;--tp-halo-opacity:.3;--tp-dot:#39393d;
  --tp-red:#e5484d;--tp-green:#30a46c;--tp-blue:#3e63dd;--tp-amber:#c27c0e;
}
.k-svg{display:block;width:100%;height:auto;overflow:visible;margin:0 auto}
.k-svg path,.k-svg circle{vector-effect:non-scaling-stroke}
.k-fill{fill:var(--tp-card);stroke:none}
.k-solid[data-lit]>.k-fill{fill:var(--tp-face)}
.k-shade,.k-top{stroke:none}
.k-shade[data-shade="0"]{fill:var(--tp-shade-0)}
.k-shade[data-shade="1"]{fill:var(--tp-shade-1)}
.k-shade[data-shade="2"]{fill:var(--tp-shade-2)}
.k-shade[data-shade="3"]{fill:var(--tp-shade-3)}
.k-top{fill:var(--tp-top)}
.k-solid[data-lit]>.k-top{fill:var(--tp-lit-top)}
.k-solid[data-lit]>.k-shade{fill:var(--tp-lit-shade)}
.k-solid[data-lit]>.k-edge{stroke:var(--tp-lit)}
.k-halo{fill:var(--tp-halo);stroke:none;filter:blur(9px);opacity:var(--tp-halo-opacity);transform:translateY(3px)}
.k-line{fill:none;stroke:var(--tp-lo);stroke-width:var(--tp-weight);stroke-linecap:round;stroke-linejoin:round}
.k-line[data-tone="hi"]{stroke:var(--tp-hi)}
.k-line[data-tone="mid"]{stroke:var(--tp-mid)}
.k-line[data-tone="faint"]{stroke:var(--tp-faint)}
.k-line[data-tone="lit"]{stroke:var(--tp-lit)}
.k-line[data-dashed]{stroke-dasharray:3 3}
.k-dots circle{fill:var(--tp-dot);stroke:none;opacity:.32}
.k-dots[data-tone="hi"] circle{opacity:.85}
.k-dots[data-tone="mid"] circle{opacity:.45}
.k-dots[data-tone="lo"] circle{opacity:.22}
.k-text{fill:var(--tp-mid);font-family:var(--tp-mono);letter-spacing:.04em}
.k-text[data-tone="hi"]{fill:var(--tp-hi)}
.k-text[data-tone="lo"]{fill:var(--tp-lo)}
.k-figure{margin:32px 0 36px}
.k-card{position:relative;padding:52px 24px;background:var(--tp-card);box-shadow:0 0 0 1px var(--tp-mid)}
.k-corners{position:absolute;inset:18px 20px;pointer-events:none}
.k-corner{position:absolute;color:var(--tp-muted);font-family:var(--tp-mono);font-size:10.5px;line-height:1;letter-spacing:.04em;white-space:nowrap}
.k-corner[data-corner="fig"]{top:0;left:0;color:var(--tp-text)}
.k-corner[data-corner="title"]{top:0;right:0;text-transform:uppercase;letter-spacing:.1em}
.k-corner[data-corner="hint"]{bottom:0;left:0;text-transform:uppercase;letter-spacing:.1em}
.k-corner[data-corner="readout"]{right:0;bottom:0;color:var(--tp-text);font-variant-numeric:tabular-nums}
.k-legend{display:grid;gap:8px;margin-top:12px;color:var(--tp-muted);font-size:13px;line-height:1.55}
.k-keys{display:flex;flex-wrap:wrap;gap:6px 18px}
.k-key{display:inline-flex;align-items:center;gap:7px}
.k-swatch{width:16px;height:10px;flex:none;overflow:visible}
.k-swatch path{fill:none;stroke:var(--tp-hi);stroke-width:1;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.k-swatch[data-mark="raised"] path{stroke:var(--tp-mid)}
.k-swatch[data-mark="lit"] path{stroke:var(--tp-lit)}
.k-swatch[data-mark="dashed"] path{stroke-dasharray:3 2.5}
.k-swatch[data-mark="red"] path{stroke:var(--tp-red)}
.k-swatch[data-mark="green"] path{stroke:var(--tp-green)}
.k-swatch[data-mark="blue"] path{stroke:var(--tp-blue)}
.k-swatch[data-mark="amber"] path{stroke:var(--tp-amber)}
@media (max-width:560px){.k-card{padding:48px 12px 70px}.k-corner[data-corner="hint"]{bottom:18px}}
`;
