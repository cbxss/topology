// Topology: turn a declarative system spec into an interactive figure, drawn either
// isometric (solids on a floor, built with kit/iso.mjs) or flat (2D glyphs on the same layout).
// One world layout feeds both views, so edges, packets and ports line up in each.

import * as k from "./iso.mjs";
import { validateSpec } from "./validate.mjs";
import { COMPONENTS, baseKind, isoComponent, flatComponent } from "./components.mjs";
import { groupOf, isLog } from "./topo-sim.mjs";
import { resolveFeatures, stripFeatures } from "./topo-features.mjs";
import { CHAR, anchorFor, lineAt, localBox, placeLabels, planBox, wrapLabel } from "./labels.mjs";

// Footprints in world units (x along the flow, y across it).
export const KINDS = {
  client: { w: 40, d: 30, h: 22 },
  lb: { w: 42, d: 42, h: 10 },
  gateway: { w: 48, d: 34, h: 16 },
  service: { w: 54, d: 36, h: 8 },
  worker: { w: 54, d: 36, h: 8 },
  cache: { w: 52, d: 36, h: 8 },
  db: { w: 42, d: 42, h: 30 },
  storage: { w: 42, d: 42, h: 26 },
  kafka: { w: 104, d: 0, h: 6 },
  queue: { w: 104, d: 26, h: 6 },
  box: { w: 52, d: 36, h: 14 },
  cdn: { w: 50, d: 36, h: 10 },
  dns: { w: 34, d: 34, h: 26 },
  external: { w: 54, d: 36, h: 14 },
  scheduler: { w: 40, d: 34, h: 12 },
  flags: { w: 48, d: 34, h: 8 },
};
for (const [kind, component] of Object.entries(COMPONENTS)) KINDS[kind] = { ...KINDS[component.base], h: component.h };

export const SLOTS = 12;
const PITCH = 7;
const LANE = 11;

const { escape } = k;
const r1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------------------------
// Spec → model

export function prepare(spec) {
  const nodes = spec.nodes.map((raw, index) => {
    const kind = KINDS[raw.kind] ? raw.kind : "box";
    const base = KINDS[kind];
    const partitions = kind === "kafka" ? raw.partitions || 3 : kind === "queue" ? 1 : 0;
    const d = raw.d ?? (kind === "kafka" ? partitions * LANE + 14 : base.d);
    const replicas = Math.max(1, Math.min(raw.replicas || 1, kind === "service" || kind === "worker" ? 4 : 1));
    const w = raw.w ?? (kind === "kafka" && raw.brokers ? base.w + 26 : base.w);
    return { ...raw, kind, index, w, d, h: base.h, partitions, replicas, label: raw.label ?? raw.id };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = (spec.edges || []).map((raw, index) => {
    const [from, to] = raw.from ? [raw.from, raw.to] : raw;
    if (!byId.has(from) || !byId.has(to)) throw new Error(`edge ${index}: unknown node ${byId.has(from) ? to : from}`);
    const viaLog = isLog(byId.get(to)) || isLog(byId.get(from));
    return { ...(Array.isArray(raw) ? {} : raw), from, to, index, kind: raw.kind || (viaLog ? "async" : "sync"), sync: raw.sync ?? (!raw.kind && !viaLog) };
  });
  const grid = layout(nodes, edges, spec);
  // Long labels wrap to two lines that fit a column; longer still, they are shortened.
  const maxChars = Math.max(8, Math.min(18, Math.floor((grid[0] - 16) / (CHAR * 8))));
  for (const node of nodes) {
    const { lines, shortened } = wrapLabel(node.label, maxChars);
    node.labelLines = lines;
    node.labelShortened = shortened;
  }
  const groups = groupsOf(spec.groups || [], byId);
  route(nodes, edges, byId);
  for (const node of nodes) if (node.kind === "flags") node.flagNames = Object.keys(spec.flags || {});
  for (const edge of edges) if (edge.kind === "replication" && byId.get(edge.from).tables && baseKind(byId.get(edge.to).kind) === "db") byId.get(edge.to).hasTables = true;
  for (const node of nodes) {
    if (!isLog(node)) continue;
    const names = [];
    for (const edge of edges) if (edge.from === node.id) {
      const name = groupOf(node, edge);
      if (!names.includes(name)) names.push(name);
    }
    node.groups = names.length ? names : ["default"];
  }
  return { labels: spec.labels, title: spec.title || "System", fig: spec.fig || "Fig 1", caption: spec.caption, hint: spec.hint, nodes, edges, groups, byId, sim: spec.sim || {}, grid, scenario: spec.scenario, flags: spec.flags, records: spec.records, ...(spec.traffic ? { traffic: spec.traffic } : {}), ...(spec.policies ? { policies: spec.policies } : {}), features: spec.features };
}

function layout(nodes, edges, spec) {
  const maxW = Math.max(...nodes.map((node) => node.w));
  const maxD = Math.max(...nodes.map((node) => node.d));
  const [gx, gy] = spec.grid || [maxW + 78, maxD + 44];
  const placed = nodes.filter((node) => node.at);
  if (placed.length !== nodes.length) autoRank(nodes, edges);
  for (const node of nodes) {
    const [col, row] = node.at || node.auto;
    node.cx = col * gx;
    node.cy = row * gy;
    node.plan = { x: node.cx - node.w / 2, y: node.cy - node.d / 2, w: node.w, d: node.d, r: 3 };
  }
  return [gx, gy];
}

// Longest-path ranks left to right; replicas sit under their primary; rows by barycentre.
function autoRank(nodes, edges) {
  const flow = edges.filter((edge) => edge.kind !== "replication");
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const edge of flow) {
      if (edge.back) continue;
      const want = rank.get(edge.from) + 1;
      if (want > rank.get(edge.to) && want < nodes.length) {
        rank.set(edge.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const replicaOf = new Map();
  for (const edge of edges) if (edge.kind === "replication") replicaOf.set(edge.to, edge.from);
  for (const [replica, primary] of replicaOf) rank.set(replica, rank.get(primary));
  const columns = new Map();
  for (const node of nodes) {
    if (node.at) continue;
    const r = rank.get(node.id);
    if (!columns.has(r)) columns.set(r, []);
    columns.get(r).push(node);
  }
  const rowOf = new Map();
  for (const r of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(r).filter((node) => !replicaOf.has(node.id));
    const bary = (node) => {
      const ins = flow.filter((edge) => edge.to === node.id && rowOf.has(edge.from));
      return ins.length ? ins.reduce((sum, edge) => sum + rowOf.get(edge.from), 0) / ins.length : node.index * 1e-3;
    };
    column.sort((a, b) => bary(a) - bary(b) || a.index - b.index);
    // Replicas sit right after their primary, on the side away from the column's centre.
    const ordered = [];
    const attach = (node) => {
      ordered.push(node);
      for (const replica of columns.get(r)) if (replicaOf.get(replica.id) === node.id) attach(replica);
    };
    column.forEach(attach);
    for (const replica of columns.get(r)) if (!ordered.includes(replica)) ordered.push(replica);
    ordered.forEach((node, index) => {
      rowOf.set(node.id, index - (ordered.length - 1) / 2);
      node.auto = [r, rowOf.get(node.id)];
    });
  }
}

function groupsOf(list, byId) {
  const groups = list.map((group) => ({ ...group, label: group.label ?? group.id }));
  const byGroup = new Map(groups.map((group) => [group.id, group]));
  const boxOf = (group, seen = new Set()) => {
    if (group.box) return group.box;
    if (seen.has(group.id)) throw new Error(`group ${group.id} contains itself`);
    seen.add(group.id);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let depth = 0;
    for (const id of group.nodes) {
      const inner = byGroup.get(id);
      const box = inner ? boxOf(inner, seen) : byId.get(id)?.plan;
      if (!box) throw new Error(`group ${group.id}: unknown member ${id}`);
      if (inner) depth = Math.max(depth, inner.depth + 1);
      x0 = Math.min(x0, box.x); y0 = Math.min(y0, box.y);
      x1 = Math.max(x1, box.x + box.w); y1 = Math.max(y1, box.y + box.d);
    }
    const pad = group.pad ?? 16;
    group.depth = depth;
    group.box = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, d: y1 - y0 + pad * 2 + 10, r: 6 };
    return group.box;
  };
  groups.forEach((group) => boxOf(group));
  return groups.sort((a, b) => b.depth - a.depth || b.box.w * b.box.d - a.box.w * a.box.d);
}

// Orthogonal routes on the floor: leave the face that looks at the target, one elbow pair
// in the middle, ports spread along each face so parallel edges don't sit on each other.
function route(nodes, edges, byId) {
  const faces = new Map();
  const faceOf = (node, side) => {
    const key = `${node.id}:${side}`;
    if (!faces.has(key)) faces.set(key, []);
    return faces.get(key);
  };
  for (const edge of edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const across = edge.axis ? edge.axis === "y" : Math.abs(dy) > Math.abs(dx) * 1.2;
    edge.axisOf = across ? "y" : "x";
    const sign = across ? Math.sign(dy) || 1 : Math.sign(dx) || 1;
    edge.ends = [
      { node: a, side: across ? (sign > 0 ? "+y" : "-y") : sign > 0 ? "+x" : "-x", other: b },
      { node: b, side: across ? (sign > 0 ? "-y" : "+y") : sign > 0 ? "-x" : "+x", other: a },
    ];
    edge.ends.forEach((end, which) => faceOf(end.node, end.side).push({ edge, which, end }));
  }
  for (const list of faces.values()) {
    const along = list[0].end.side.endsWith("x") ? "cy" : "cx";
    list.sort((p, q) => p.end.other[along] - q.end.other[along] || p.edge.index - q.edge.index);
    list.forEach((entry, index) => {
      const node = entry.end.node;
      const span = (along === "cy" ? node.d : node.w) * 0.56;
      entry.end.offset = list.length === 1 ? 0 : -span / 2 + (span * index) / (list.length - 1);
    });
  }
  for (const edge of edges) edge.ports = edge.ends.map(({ node, side, offset }) => portOf(node, side, offset));
  // Edges whose elbows fall in the same channel get their own lane in it, so their
  // middle legs run side by side instead of on top of each other.
  const channels = new Map();
  for (const edge of edges) {
    if (edge.via || edge.bend != null) continue;
    const [p, q] = edge.ports;
    const i = edge.axisOf === "x" ? 0 : 1;
    const j = 1 - i;
    if (Math.abs(p[j] - q[j]) < 0.5) continue;
    const key = `${edge.axisOf}:${Math.round(((p[i] + q[i]) / 2) / 24)}`;
    if (!channels.has(key)) channels.set(key, []);
    channels.get(key).push(edge);
  }
  for (const list of channels.values()) {
    if (list.length < 2) continue;
    const i = list[0].axisOf === "x" ? 0 : 1;
    const j = 1 - i;
    const room = Math.min(...list.map((edge) => Math.abs(edge.ports[1][i] - edge.ports[0][i]))) * 0.6;
    const gap = Math.min(9, room / (list.length - 1));
    // Rising legs nearest the source turn first: fewer crossings for a fan in or out.
    list.sort((a, b) => (a.ports[0][j] - b.ports[0][j]) * Math.sign(a.ports[1][i] - a.ports[0][i]) || a.ports[1][j] - b.ports[1][j]);
    const mid = list.reduce((sum, edge) => sum + (edge.ports[0][i] + edge.ports[1][i]) / 2, 0) / list.length;
    list.forEach((edge, index) => {
      edge.channel = mid + (index - (list.length - 1) / 2) * gap * Math.sign(edge.ports[1][i] - edge.ports[0][i] || 1);
    });
  }
  for (const edge of edges) {
    const [p, q] = edge.ports;
    let corners;
    if (edge.axisOf === "x") {
      const mx = edge.bend != null ? p[0] + (q[0] - p[0]) * edge.bend : edge.channel ?? (p[0] + q[0]) / 2;
      corners = Math.abs(p[1] - q[1]) < 0.5 ? [p, q] : [p, [mx, p[1]], [mx, q[1]], q];
    } else {
      const my = edge.bend != null ? p[1] + (q[1] - p[1]) * edge.bend : edge.channel ?? (p[1] + q[1]) / 2;
      corners = Math.abs(p[0] - q[0]) < 0.5 ? [p, q] : [p, [p[0], my], [q[0], my], q];
    }
    if (edge.via) corners = [p, ...edge.via, q];
    edge.corners = corners;
    edge.points = rounded(corners, 7);
    measure(edge);
  }
}

// Where two edges cross at right angles, the later one hops over the earlier with a small
// arc, so a crossing never reads as a junction. Works on the routed points, so packets follow.
export function applyHops(model, radius = 4.2) {
  const legsOf = (edge) => {
    const legs = [];
    for (let i = 1; i < edge.points.length; i++) {
      const [a, b] = [edge.points[i - 1], edge.points[i]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < radius * 3) continue;
      if (Math.abs(a[1] - b[1]) < 0.01) legs.push({ i, axis: "x", at: a[1], from: Math.min(a[0], b[0]), to: Math.max(a[0], b[0]) });
      else if (Math.abs(a[0] - b[0]) < 0.01) legs.push({ i, axis: "y", at: a[0], from: Math.min(a[1], b[1]), to: Math.max(a[1], b[1]) });
    }
    return legs;
  };
  const margin = radius * 1.6;
  const fits = (leg, c) => c > leg.from + margin && c < leg.to - margin;
  const legs = new Map(model.edges.map((edge) => [edge.index, legsOf(edge)]));
  const hopsOf = new Map(model.edges.map((edge) => [edge.index, []]));
  for (const edge of model.edges) {
    for (const other of model.edges) {
      if (other.index >= edge.index) continue;
      for (const leg of legs.get(edge.index)) for (const cross of legs.get(other.index)) {
        if (leg.axis === cross.axis) continue;
        if (!(cross.at > leg.from - 0.5 && cross.at < leg.to + 0.5 && leg.at > cross.from - 0.5 && leg.at < cross.to + 0.5)) continue;
        // The later edge hops if its leg has room around the crossing, else the earlier one does.
        if (fits(leg, cross.at)) hopsOf.get(edge.index).push({ i: leg.i, axis: leg.axis, c: cross.at, line: leg.at });
        else if (fits(cross, leg.at)) hopsOf.get(other.index).push({ i: cross.i, axis: cross.axis, c: leg.at, line: cross.at });
      }
    }
  }
  for (const edge of model.edges) {
    const hops = hopsOf.get(edge.index);
    if (!hops.length) continue;
    // Insert from the last leg backwards so earlier indices stay valid.
    const byLeg = new Map();
    for (const hop of hops) byLeg.set(hop.i, [...(byLeg.get(hop.i) || []), hop]);
    for (const [i, list] of [...byLeg].sort((p, q) => q[0] - p[0])) {
      const [a, b] = [edge.points[i - 1], edge.points[i]];
      const axis = list[0].axis;
      const dir = axis === "x" ? Math.sign(b[0] - a[0]) : Math.sign(b[1] - a[1]);
      list.sort((p, q) => (p.c - q.c) * dir);
      const inserted = [];
      for (const hop of list) {
        for (let s = 0; s <= 6; s++) {
          const angle = (Math.PI * s) / 6;
          const along = hop.c - dir * radius * Math.cos(angle);
          const offset = -radius * Math.sin(angle);
          inserted.push(axis === "x" ? [along, hop.line + offset] : [hop.line + offset, along]);
        }
      }
      edge.points.splice(i, 0, ...inserted);
    }
    measure(edge);
    edge.hops = hops.length;
  }
}

// Where a link meets a node: on the face, `offset` along it. Round bodies (disks, the
// octagonal LB) and inset ones (the DNS tower's base) are met on their real outline, so a
// link spread off-centre still touches the body.
const ROUND = { db: 1, storage: 1, cdn: 0, lb: Math.cos(Math.PI / 8) };
const INSET = { dns: 4 };
function portOf(node, side, offset) {
  const across = side.endsWith("x");
  const sign = side[0] === "+" ? 1 : -1;
  const half = across ? node.w / 2 : node.d / 2;
  let reach = half - (INSET[node.kind] || 0);
  if (ROUND[node.kind]) {
    const r = (Math.min(node.w, node.d) / 2) * ROUND[node.kind];
    reach = Math.sqrt(Math.max(0, r * r - offset * offset));
  }
  return across ? [node.cx + sign * reach, node.cy + offset] : [node.cx + offset, node.cy + sign * reach];
}

// Cumulative lengths along an edge's points: packets are placed by them.
function measure(edge) {
  edge.lens = [0];
  for (let i = 1; i < edge.points.length; i++) edge.lens.push(edge.lens[i - 1] + Math.hypot(edge.points[i][0] - edge.points[i - 1][0], edge.points[i][1] - edge.points[i - 1][1]));
  edge.len = edge.lens[edge.lens.length - 1];
}

function rounded(points, radius, steps = 5) {
  if (points.length < 3) return points.map((p) => [...p]);
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) {
      out.push(b);
      continue;
    }
    const u = [(a[0] - b[0]) / l1, (a[1] - b[1]) / l1];
    const v = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
    const s = [b[0] + u[0] * r, b[1] + u[1] * r];
    const e = [b[0] + v[0] * r, b[1] + v[1] * r];
    for (let t = 0; t <= steps; t++) {
      const f = t / steps;
      // quadratic Bézier through the corner: close to a quarter circle for right angles
      const m = (1 - f) * (1 - f);
      const n = 2 * (1 - f) * f;
      const o = f * f;
      out.push([m * s[0] + n * b[0] + o * e[0], m * s[1] + n * b[1] + o * e[1]]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Views

export const VIEWS = {
  iso: { azimuth: 56, elevation: 32 },
  flat: { azimuth: 90, elevation: 90 },
};

function extentOf(model, view) {
  const pts = [];
  for (const node of model.nodes) pts.push(...k.boxCorners(node.plan, 0, view === "iso" ? heightOf(node) : 0));
  for (const group of model.groups) pts.push(...k.boxCorners(group.box, -2, 0));
  for (const node of model.nodes) {
    const half = Math.max(...node.labelLines.map((line) => line.length)) * 2.6;
    const y = node.plan.y + node.plan.d + 14 + (node.labelLines.length - 1) * 9;
    pts.push([node.cx - half, y, 0], [node.cx + half, y, 0]);
  }
  return pts;
}

export function heightOf(node) {
  if (node.kind === "service" || node.kind === "worker") return node.replicas * 8.8 + 1;
  if (isLog(node)) return 10;
  return node.h;
}

export function projectionOf(model, view, width = 640, camera, { maxScale } = {}) {
  const { azimuth, elevation } = camera || VIEWS[view];
  const pts = extentOf(model, view);
  const unit = { origin: [0, 0], scale: 1, azimuth, elevation };
  const flat = pts.map((p) => k.iso(p, unit));
  const xs = flat.map(([x]) => x);
  const ys = flat.map(([, y]) => y);
  const [spanX, spanY] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  const pad = 26;
  // With a scale cap the height follows the content; otherwise the card keeps a sensible minimum.
  const scale = Math.min(maxScale ?? Infinity, (width - pad * 2) / spanX);
  const height = Math.round(Math.min(760, Math.max(maxScale ? 120 : 240, spanY * scale + pad * 2)));
  return { P: k.fitProjection(pts, width, height, { pad, azimuth, elevation, maxScale }), width, height };
}

// ---------------------------------------------------------------------------------------------
// Isometric renderers. Each returns markup for one node at rest; the live page only toggles
// attributes (LEDs, record cells, down) and moves cursors and packets.

function isoKit(P) {
  const at = (p) => k.iso(p, P);
  const S = (paths, style) => k.solidSvg(paths, style);
  const L = (d, style) => k.lineSvg(d, style);
  const led = (id, p, r = 1.3) => {
    const [x, y] = at(p);
    return `<circle class="tp-led" data-led="${escape(id)}" cx="${r1(x)}" cy="${r1(y)}" r="${r}"/>`;
  };
  const dots = (pts, style) => k.dotsSvg(pts.map(at), style);
  // A closed rectangle on the +y face (the face toward the lower left).
  const faceY = (x0, x1, y, z0, z1) => k.pathOf([at([x0, y, z0]), at([x1, y, z0]), at([x1, y, z1]), at([x0, y, z1])], true);
  const faceX = (x, y0, y1, z0, z1) => k.pathOf([at([x, y0, z0]), at([x, y1, z0]), at([x, y1, z1]), at([x, y0, z1])], true);
  return { at, S, L, led, dots, faceY, faceX, P };
}

const ISO = {
  service(node, c) {
    const { plan } = node;
    const out = [];
    for (let r = 0; r < node.replicas; r++) {
      const z = r * 8.8;
      const top = r === node.replicas - 1;
      out.push(c.S(k.slabOf(plan, z, 8, c.P, 3, 0.6), { tone: "mid", crease: "faint" }));
      const fy = plan.y + plan.d;
      for (let b = 0; b < 3; b++) out.push(c.L(c.faceY(plan.x + 14 + b * 11, plan.x + 23 + b * 11, fy, z + 2.4, z + 5.6), { tone: "lo" }));
      out.push(c.L(c.faceX(plan.x + plan.w, plan.y + 6, plan.y + plan.d - 6, z + 3.2, z + 4.8), { tone: "faint" }));
      out.push(c.led(`${node.id}:${r}`, [plan.x + 6, fy, z + 4]));
      if (top) {
        out.push(c.L(k.planOutline(k.insetPlan(plan, 4), z + 8, c.P, 3), { tone: "faint" }));
        out.push(c.dots(k.corners(plan, 2.2).map(([x, y]) => [x, y, z + 8]), { size: 0.5, tone: "lo" }));
        if (node.kind === "worker") out.push(c.L(k.ring(node.cx, node.cy, 6, z + 8, c.P, 24) + k.ring(node.cx, node.cy, 2.4, z + 8, c.P, 16), { tone: "lo" }));
      }
    }
    return out.join("");
  },
  worker(node, c) {
    return ISO.service(node, c);
  },
  cache(node, c) {
    const { plan } = node;
    const out = [c.S(k.slabOf(plan, 0, 5, c.P, 3, 0.6), { tone: "mid" })];
    out.push(c.L(k.planOutline(k.insetPlan(plan, 3), 5, c.P, 3), { tone: "faint" }));
    const chips = [];
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 4; col++) chips.push({ x: plan.x + 6 + col * 11.4, y: plan.y + 6 + row * 13, w: 8.6, d: 10, r: 0.8 });
    chips.sort((a, b) => a.x + a.y - (b.x + b.y));
    for (const chip of chips) out.push(c.S(k.slabOf(chip, 5, 2.6, c.P, 2), { tone: "hi", crease: "lo" }));
    out.push(c.led(`${node.id}:0`, [plan.x + 5, plan.y + plan.d, 2.5]));
    out.push(c.dots([[plan.x + 11, plan.y + plan.d, 2.5], [plan.x + 15, plan.y + plan.d, 2.5]], { size: 0.6, tone: "lo" }));
    return out.join("");
  },
  db(node, c) {
    const r = Math.min(node.w, node.d) / 2;
    const out = [];
    const toward = [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)];
    for (let s = 0; s < 3; s++) {
      const z = s * 10;
      out.push(c.S(k.cylinder(node.cx, node.cy, r, z, 9, c.P, 48, s === 2 ? 0.8 : 0), { tone: "mid" }));
      out.push(c.L(k.sideArc(node.cx, node.cy, r, z + 4.5, c.P, 32), { tone: "faint" }));
      out.push(c.led(`${node.id}:${s === 2 ? 0 : "x" + s}`, [node.cx + r * toward[0], node.cy + r * toward[1], z + 4.5], 1.1));
    }
    out.push(c.L(k.ring(node.cx, node.cy, r - 4, 29, c.P, 40), { tone: "lo" }));
    out.push(c.dots([[node.cx, node.cy, 29]], { size: 0.8, tone: "mid" }));
    if (node.role) out.push(k.faceTextSvg(k.topMatrix([node.cx, node.cy + 4], 29, c.P, "x"), node.role.toUpperCase(), { size: 4, tone: "lo", anchor: "middle" }));
    // Level 0 for a database with tables: a live row count, nothing more.
    if (node.tables || node.hasTables) out.push(`<g class="tp-rows-badge" data-rows="${escape(node.id)}">${k.faceTextSvg(k.topMatrix([node.cx, node.cy + 11], 29, c.P, "x"), "0 rows", { size: 4, tone: "mid", anchor: "middle" })}</g>`);
    return out.join("");
  },
  storage(node, c) {
    const r = Math.min(node.w, node.d) / 2;
    const out = [];
    [r - 5, r - 2.5, r].forEach((radius, s) => {
      out.push(c.S(k.cylinder(node.cx, node.cy, radius, s * 8, s === 2 ? 10 : 8, c.P, 48, s === 2 ? 0.8 : 0), { tone: "mid" }));
    });
    out.push(c.L(k.ring(node.cx, node.cy, r - 3, 26, c.P, 40), { tone: "lo" }));
    out.push(c.L(k.ring(node.cx, node.cy, r - 7, 26, c.P, 40), { tone: "faint" }));
    out.push(c.led(`${node.id}:0`, [node.cx + r * 0.707, node.cy + r * 0.707, 21], 1.1));
    return out.join("");
  },
  lb(node, c) {
    const r = Math.min(node.w, node.d) / 2;
    const rot = Array.from({ length: 8 }, (_, i) => {
      const a = ((i + 0.5) / 8) * Math.PI * 2;
      return [node.cx + r * Math.cos(a), node.cy + r * Math.sin(a)];
    });
    const out = [c.S(k.extrude(rot, 0, 10, c.P, { bevel: 0.8 }), { tone: "mid" })];
    out.push(c.L(k.ring(node.cx, node.cy, r - 6, 10, c.P, 40), { tone: "faint" }));
    const fan = [-0.6, 0, 0.6].map((a) => k.lineOnTop([node.cx - 9, node.cy], [node.cx + 11 * Math.cos(a), node.cy + 11 * Math.sin(a)], 10, c.P)).join("");
    out.push(c.L(fan, { tone: "mid", free: "end" }));
    out.push(c.dots([[node.cx - 9, node.cy, 10]], { size: 0.9, tone: "hi" }));
    out.push(c.led(`${node.id}:0`, [node.cx + r * 0.92 * 0.707, node.cy + r * 0.92 * 0.707, 5], 1.2));
    return out.join("");
  },
  gateway(node, c) {
    const { plan } = node;
    const out = [c.S(k.slabOf(plan, 0, 4, c.P, 3, 0.6), { tone: "mid" })];
    const posts = [
      { x: plan.x + 4, y: plan.y + 4, w: 9, d: plan.d - 8, r: 1 },
      { x: plan.x + plan.w - 13, y: plan.y + 4, w: 9, d: plan.d - 8, r: 1 },
    ];
    for (const post of posts) out.push(c.S(k.slabOf(post, 4, 9, c.P, 2, 0.4), { tone: "mid" }));
    const beam = { x: plan.x + 2, y: plan.y + 3, w: plan.w - 4, d: plan.d - 6, r: 1.5 };
    out.push(c.S(k.slabOf(beam, 13, 3, c.P, 3, 0.6), { tone: "hi", crease: "lo" }));
    out.push(c.L(k.planOutline(k.insetPlan(beam, 3), 16, c.P, 3), { tone: "faint" }));
    out.push(c.led(`${node.id}:0`, [plan.x + plan.w / 2, plan.y + plan.d - 3, 14.5]));
    return out.join("");
  },
  client(node, c) {
    const { plan } = node;
    const out = [];
    const deck = { x: plan.x, y: plan.y + 8, w: plan.w, d: plan.d - 8, r: 2 };
    out.push(c.S(k.slabOf(deck, 0, 2.4, c.P, 3, 0.4), { tone: "mid" }));
    out.push(c.L(k.planOutline(k.insetPlan({ ...deck, y: deck.y + 3, d: deck.d - 9 }, 3), 2.4, c.P, 2), { tone: "faint" }));
    out.push(c.L(k.planOutline({ x: node.cx - 6, y: deck.y + deck.d - 6, w: 12, d: 4, r: 1 }, 2.4, c.P, 2), { tone: "faint" }));
    const lid = { x: plan.x, y: plan.y + 4, w: plan.w, d: 3, r: 1 };
    out.push(c.S(k.slabOf(lid, 2.4, 22, c.P, 2, 0.4), { tone: "mid" }));
    const fy = lid.y + lid.d;
    out.push(`<path class="tp-screen" d="${c.faceY(plan.x + 3, plan.x + plan.w - 3, fy, 5, 22)}"/>`);
    for (let i = 0; i < 3; i++) out.push(c.L(k.segment([plan.x + 7, fy, 18 - i * 4], [plan.x + 7 + [22, 16, 19][i], fy, 18 - i * 4], c.P), { tone: "lo", free: true }));
    out.push(c.led(`${node.id}:0`, [plan.x + plan.w - 7, fy, 8]));
    return out.join("");
  },
  box(node, c) {
    const { plan } = node;
    const out = [c.S(k.slabOf(plan, 0, 14, c.P, 3, 0.6), { tone: "mid" })];
    out.push(c.L(k.planOutline(k.insetPlan(plan, 4), 14, c.P, 3), { tone: "faint" }));
    out.push(c.L(k.sideSeam(plan, 4, c.P, 3), { tone: "faint" }));
    out.push(c.led(`${node.id}:0`, [plan.x + 6, plan.y + plan.d, 9]));
    return out.join("");
  },
  kafka(node, c) {
    const { plan } = node;
    const out = [c.S(k.slabOf(plan, 0, 6, c.P, 3, 0.8), { tone: "mid" })];
    const fy = plan.y + plan.d;
    if (node.brokers) {
      // One small broker unit per broker down the left end; click one to fail it.
      const n = node.brokers;
      const span = (plan.d - 8) / n;
      for (let i = n - 1; i >= 0; i--) {
        const unit = { x: plan.x + 5, y: plan.y + 4 + i * span + 0.8, w: 12, d: span - 1.6, r: 1 };
        out.push(`<g class="tp-broker" data-part="broker:${i}">${c.S(k.slabOf(unit, 6, 5, c.P, 2, 0.4), { tone: "mid" })}${c.led(`${node.id}:b${i}`, [unit.x + unit.w, unit.y + unit.d / 2, 8.5], 1)}</g>`);
      }
    } else {
      for (let b = 0; b < 3; b++) out.push(c.led(`${node.id}:b${b}`, [plan.x + 6 + b * 5, fy, 3], 1.1));
      out.push(c.L(c.faceY(plan.x + 24, plan.x + plan.w - 6, fy, 2, 4), { tone: "faint" }));
    }
    for (let p = 0; p < node.partitions; p++) {
      const lane = laneOf(node, p);
      out.push(`<g class="tp-lane" data-lane="${escape(node.id)}:${p}">`);
      out.push(c.S(k.slabOf({ ...lane, x: lane.x - 2, w: lane.w + 4, y: lane.y - 0.5, d: lane.d + 1, r: 1 }, 6, 0.6, c.P, 2), { tone: "lo", crease: "none" }));
      for (let i = 0; i < SLOTS; i++) {
        const cell = { x: lane.x + i * PITCH + 0.7, y: lane.y + 0.8, w: PITCH - 1.4, d: lane.d - 1.6, r: 0.6 };
        out.push(`<g class="tp-cell" data-cell="${escape(node.id)}:${p}:${i}">${c.S(k.slabOf(cell, 6.6, 2.2, c.P, 2), { tone: "lo", crease: "none" })}</g>`);
      }
      (node.groups || ["default"]).slice(0, 3).forEach((_, g) => {
        const post = { x: lane.x - 0.8, y: lane.y - 1.4, w: 1.6, d: lane.d + 2.8, r: 0.4 };
        out.push(`<g class="tp-cursor" data-cursor="${escape(node.id)}:${g}:${p}" data-g="${g}">${c.S(k.slabOf(post, 6.6, 4.4 + g * 1.6, c.P, 1), { tone: "hi", lit: g === 0 })}</g>`);
      });
      out.push(`</g>`);
    }
    return out.join("");
  },
  cdn(node, c) {
    const { plan } = node;
    const r = Math.min(plan.w, plan.d) / 2 - 5;
    const out = [c.S(k.slabOf(plan, 0, 4, c.P, 3, 0.6), { tone: "mid" })];
    out.push(c.S(k.cylinder(node.cx, node.cy, r, 4, 6, c.P, 48, 0.6), { tone: "hi", crease: "lo" }));
    out.push(c.L(k.sideArc(node.cx, node.cy, r, 7, c.P, 32), { tone: "faint" }));
    out.push(c.L(k.ring(node.cx, node.cy, r * 0.62, 10, c.P, 40) + k.ring(node.cx, node.cy, r * 0.25, 10, c.P, 24), { tone: "lo" }));
    out.push(c.L(k.lineOnTop([node.cx - r, node.cy], [node.cx + r, node.cy], 10, c.P) + k.lineOnTop([node.cx, node.cy - r], [node.cx, node.cy + r], 10, c.P), { tone: "faint" }));
    out.push(c.led(`${node.id}:0`, [plan.x + 5, plan.y + plan.d, 2]));
    return out.join("");
  },
  dns(node, c) {
    const out = [c.S(k.slabOf(k.insetPlan(node.plan, 4), 0, 3, c.P, 3, 0.5), { tone: "mid" })];
    out.push(c.S(k.cylinder(node.cx, node.cy, 3, 3, 17, c.P, 20), { tone: "mid", crease: "none" }));
    out.push(c.L([8, 13].map((z) => k.sideArc(node.cx, node.cy, 3, z, c.P, 12)).join(""), { tone: "faint" }));
    out.push(c.S(k.cylinder(node.cx, node.cy, 10, 20, 2.4, c.P, 40, 0.5), { tone: "hi", crease: "lo" }));
    out.push(c.L(k.ring(node.cx, node.cy, 6, 22.4, c.P, 32), { tone: "lo" }));
    out.push(c.led(`${node.id}:0`, [node.cx, node.cy, 22.4], 1.3));
    return out.join("");
  },
  external(node, c) {
    const { plan } = node;
    const out = [`<g class="tp-ext">${c.S(k.slabOf(plan, 0, 14, c.P, 3, 0.6), { tone: "mid" })}</g>`];
    out.push(c.L(k.planOutline(k.insetPlan(plan, 4), 14, c.P, 3), { tone: "faint", dashed: true }));
    out.push(c.dots([0, 1, 2].map((i) => [node.cx - 5 + i * 5, node.cy, 14]), { size: 0.9, tone: "mid" }));
    out.push(c.led(`${node.id}:0`, [plan.x + 6, plan.y + plan.d, 9]));
    return out.join("");
  },
  scheduler(node, c) {
    const { plan } = node;
    const out = [c.S(k.slabOf(plan, 0, 6, c.P, 3, 0.6), { tone: "mid" })];
    const r = Math.min(plan.w, plan.d) / 2 - 4;
    out.push(c.S(k.cylinder(node.cx, node.cy, r, 6, 2, c.P, 48, 0.5), { tone: "hi", crease: "lo" }));
    const ticks = k.radialTicks(node.cx, node.cy, r - 1.5, 12, 3, 8, [1.2, 2.4], c.P);
    out.push(c.L(ticks.minor, { tone: "lo" }), c.L(ticks.major, { tone: "mid" }));
    out.push(c.L(k.lineOnTop([node.cx, node.cy], [node.cx, node.cy - r * 0.62], 8, c.P) + k.lineOnTop([node.cx, node.cy], [node.cx + r * 0.42, node.cy + r * 0.2], 8, c.P), { tone: "hi", free: "end" }));
    out.push(c.dots([[node.cx, node.cy, 8]], { size: 0.8, tone: "hi" }));
    out.push(c.led(`${node.id}:0`, [plan.x + 5, plan.y + plan.d, 3]));
    return out.join("");
  },
  flags(node, c) {
    const { plan } = node;
    const out = [c.S(k.slabOf(plan, 0, 6, c.P, 3, 0.6), { tone: "mid" })];
    flagRows(node).forEach(({ name, slot, knob }) => {
      out.push(c.S(k.slabOf(slot, 6, 0.6, c.P, 2), { tone: "lo", crease: "none" }));
      out.push(`<g class="tp-knob" data-flag="${escape(name)}">${c.S(k.slabOf(knob, 6.6, 2.2, c.P, 2), { tone: "hi", lit: true })}</g>`);
      out.push(k.faceTextSvg(k.topMatrix([plan.x + 4, slot.y + slot.d - 0.6], 6, c.P, "x"), name.slice(0, 7), { size: 3.4, tone: "lo" }));
    });
    out.push(c.led(`${node.id}:0`, [plan.x + plan.w - 5, plan.y + plan.d, 3]));
    return out.join("");
  },
  queue(node, c) {
    return ISO.kafka(node, c);
  },
};

// Rows of switches on a flags panel: a slot and a knob that slides with the rollout.
export function flagRows(node) {
  const names = node.flagNames || [];
  const { plan } = node;
  return names.slice(0, 4).map((name, i) => {
    const y = plan.y + 4 + i * ((plan.d - 8) / Math.max(1, Math.min(4, names.length)));
    const slot = { x: plan.x + plan.w - 26, y, w: 22, d: 5, r: 1 };
    return { name, slot, knob: { x: slot.x + 0.5, y: y + 0.5, w: 8, d: 4, r: 0.8 }, travel: slot.w - 9 };
  });
}

export function laneOf(node, p) {
  const top = node.plan.y + 7;
  return { x: node.plan.x + node.plan.w - 8 - SLOTS * PITCH, y: top + p * LANE, w: SLOTS * PITCH, d: LANE - 3, r: 1 };
}

// Where every label goes, in one view: node labels first (iso: in front of the node, else
// along its right side, behind it or along its left; 2D: below, above, right or left), then
// edge labels (along any leg, either side of the line). Each takes the first spot that no node,
// earlier label or line is in the way of (kit/labels.mjs); an edge label with no clear spot is
// `crowded` and only shows while its edge is in focus. Shared with build.mjs --check.
export const NODE_TEXT = 8;
export const EDGE_TEXT = 6.2;

export function labelPlanOf(model, view, P, W, H) {
  const g = view === "iso" ? 1 : 1 / k.cameraOf(P).k; // 2D text is sized in screen units
  const spot = (lines, size, along, anchor, want, extra) => {
    const local = localBox(lines, size, anchor);
    const at = anchorFor(along, local, want);
    return { at, along, anchor, size, lines, box: planBox(at, along, local), ...extra };
  };
  const items = [];
  for (const node of model.nodes) {
    const { plan, labelLines: lines } = node;
    const size = NODE_TEXT * g;
    let candidates;
    if (view === "iso") {
      const front = spot(lines, size, "x", "middle", { x: node.cx, top: plan.y + plan.d + 4 }, { name: "front" });
      const side = spot(lines, size, "y", "middle", { left: plan.x + plan.w + 3, y: node.cy }, { name: "side" });
      candidates = node.labelAt === "side" ? [side] : node.labelAt === "front" ? [front]
        : [front, side, spot(lines, size, "x", "middle", { x: node.cx, bottom: plan.y - 4 }, { name: "back" }), spot(lines, size, "y", "middle", { right: plan.x - 3, y: node.cy }, { name: "left" })];
    } else candidates = [
      spot(lines, size, "x", "middle", { x: node.cx, top: plan.y + plan.d + 4 * g }, { name: "below" }),
      spot(lines, size, "x", "middle", { x: node.cx, bottom: plan.y - 3 * g }, { name: "above" }),
      spot(lines, size, "x", "start", { left: plan.x + plan.w + 5 * g, y: node.cy }, { name: "right" }),
      spot(lines, size, "x", "end", { right: plan.x - 5 * g, y: node.cy }, { name: "left" }),
    ];
    // 2D labels have a halo (TOPO_CSS), so a line through one costs less than moving it.
    const near = { x0: plan.x, x1: plan.x + plan.w, y0: plan.y, y1: plan.y + plan.d };
    items.push({ key: `n:${node.id}`, node, candidates, own: { node: node.id }, near, slack: 6 * g, lineCost: view === "iso" ? undefined : 3 });
  }
  const labelled = model.edges.filter((edge) => model.features?.labels !== false && edge.kind !== "config" && (edge.label || model.labels === "rate" || edge.flag || edge.unless));
  for (const edge of [...labelled.filter((edge) => edge.label), ...labelled.filter((edge) => !edge.label)]) {
    // Room for the longest text the live page may write here (topo-live.js drawStatus).
    const flagName = edge.flag || edge.unless;
    const reserve = [edge.label || (model.labels === "rate" ? "99.9k/s" : ""), flagName ? `${edge.unless ? "¬" : ""}${flagName} 100%` : ""].filter(Boolean).join(" · ") || " ";
    const size = EDGE_TEXT * g;
    const legs = edge.corners.slice(1).map((b, i) => [edge.corners[i], b]).map((leg, i) => ({ leg, i, len: Math.hypot(leg[1][0] - leg[0][0], leg[1][1] - leg[0][1]) }))
      .sort((a, b) => b.len - a.len || a.i - b.i);
    const candidates = [];
    for (const { leg: [a, b] } of legs) for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const horizontal = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
      if (view === "iso") candidates.push(...(horizontal
        ? [spot([reserve], size, "x", "middle", { x: m[0], bottom: m[1] - 4.45 }), spot([reserve], size, "x", "middle", { x: m[0], top: m[1] + 4.45 })]
        : [spot([reserve], size, "y", "middle", { left: m[0] + 1.35, y: m[1] }), spot([reserve], size, "y", "middle", { right: m[0] - 1.35, y: m[1] })]));
      else candidates.push(...(horizontal
        ? [spot([reserve], size, "x", "middle", { x: m[0], bottom: m[1] - 1.95 * g }), spot([reserve], size, "x", "middle", { x: m[0], top: m[1] + 1.95 * g })]
        : [spot([reserve], size, "x", "start", { left: m[0] + 4 * g, top: m[1] - 2.65 * g }), spot([reserve], size, "x", "end", { right: m[0] - 4 * g, top: m[1] - 2.65 * g })]));
    }
    items.push({ key: `e:${edge.index}`, edge, candidates, own: { edge: edge.index }, crowdable: true });
  }
  // Group labels are fixed (along the plate's left edge); they are in everyone's way.
  const labels = model.groups.map((group) => {
    const size = (view === "iso" ? (group.region ? 7 : 6) : group.region ? 8 : 7) * g;
    const text = String(group.label).toUpperCase();
    const at = view === "iso" ? [group.box.x + 6.5, group.box.y + group.box.d - 8] : [group.box.x + 8 * g, group.box.y + group.box.d - 7 * g];
    return { id: `g:${group.id}`, box: planBox(at, view === "iso" ? "y" : "x", localBox([text], size, "start")) };
  });
  const nodes = model.nodes.map((node) => ({ id: node.id, box: { x0: node.plan.x, x1: node.plan.x + node.plan.w, y0: node.plan.y, y1: node.plan.y + node.plan.d } }));
  const lines = model.edges.flatMap((edge) => edge.points.slice(1).map((b, i) => ({ edge: edge.index, a: edge.points[i], b })));
  const marks = ({ box, along }) => (along === "y"
    ? [[(box.x0 + box.x1) / 2, box.y0], [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2], [(box.x0 + box.x1) / 2, box.y1]]
    : [[box.x0, (box.y0 + box.y1) / 2], [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2], [box.x1, (box.y0 + box.y1) / 2]]);
  // Nodes are painted after labels, so in iso a label is hidden where a nearer node stands over
  // it, or where its own node's body does (a label behind a tall node).
  const ownHull = new Map(model.nodes.map((node) => [node.id, k.convexHull(k.pointsAt(k.boxCorners(node.plan, 0, heightOf(node)), P))]));
  const coveredByOwn = (node, candidate) => node && marks(candidate).some((m) => inside(ownHull.get(node.id), k.iso([m[0], m[1], 0], P)));
  const hidden = view === "iso" ? (candidate, item) => coveredByOwn(item.node, candidate) || hiddenBy(model, item.node || null, { marks: marks(candidate) }, P).length > 0 : () => false;
  const outside = (box) => [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]]
    .map((p) => k.iso([p[0], p[1], 0], P)).some(([x, y]) => x < 1 || y < 1 || x > W - 1 || y > H - 1);
  const placed = placeLabels(items, { nodes, labels, lines, hidden, outside });
  const plan = { nodes: new Map(), edges: new Map(), items };
  for (const item of items) {
    const spot = placed.get(item.key);
    const result = { ...spot, hiddenBy: view === "iso" ? [...(coveredByOwn(item.node, spot) ? [item.node.id] : []), ...hiddenBy(model, item.node || null, { marks: marks(spot) }, P)] : [] };
    if (item.node) plan.nodes.set(item.node.id, result);
    else plan.edges.set(item.edge.index, result);
  }
  return plan;
}

function isoLabel(node, P, plan) {
  const spot = plan.nodes.get(node.id);
  node.labelSpot = spot;
  return spot.lines.map((line, i) => k.faceTextSvg(k.topMatrix(lineAt(spot.at, spot.along, spot.size, i), 0, P, spot.along), line, { size: spot.size, tone: "hi", anchor: spot.anchor })).join("");
}

function flatLabel(node, P, plan) {
  const spot = plan.nodes.get(node.id);
  return spot.lines.map((line, i) => {
    const [x, y] = k.iso([...lineAt(spot.at, "x", spot.size, i), 0], P);
    return `<text class="tp-ft" x="${r1(x)}" y="${r1(y)}" font-size="${NODE_TEXT}" text-anchor="${spot.anchor}">${escape(line)}</text>`;
  }).join("");
}

export function hiddenBy(model, node, spot, P) {
  const marks = spot.marks.map((m) => ({ s: k.iso([m[0], m[1], 0], P), depth: k.depthOf([m[0], m[1], 0], P) }));
  const blockers = [];
  for (const other of model.nodes) {
    if (other === node) continue;
    const hull = k.convexHull(k.pointsAt(k.boxCorners(other.plan, 0, heightOf(other)), P));
    const front = k.depthOf([other.cx, other.cy, 0], P);
    if (marks.some((m) => front > m.depth - 20 && inside(hull, m.s))) blockers.push(other.id);
  }
  return blockers;
}

function inside(hull, [x, y]) {
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i];
    const [bx, by] = hull[(i + 1) % hull.length];
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
  }
  return hull.length > 2;
}


// ---------------------------------------------------------------------------------------------
// Flat renderers: 2D glyphs that fill each footprint, in screen space.

function flatKit(P) {
  const at = (p) => k.iso([p[0], p[1], 0], P);
  const box = (plan) => {
    const [x0, y0] = at([plan.x, plan.y]);
    const [x1, y1] = at([plan.x + plan.w, plan.y + plan.d]);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const rect = (b, cls = "tp-f", rx = 3, extra = "") => `<rect class="${cls}" x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}" rx="${rx}"${extra}/>`;
  const line = (pts, tone = "lo") => k.lineSvg(k.pathOf(pts), { tone });
  const text = (x, y, s, size = 8, cls = "tp-ft") => `<text class="${cls}" x="${r1(x)}" y="${r1(y)}" font-size="${size}" text-anchor="middle">${escape(s)}</text>`;
  const led = (id, x, y, r = 1.6) => `<circle class="tp-led" data-led="${escape(id)}" cx="${r1(x)}" cy="${r1(y)}" r="${r}"/>`;
  return { at, box, rect, line, text, led, P, scale: k.cameraOf(P).k };
}

const FLAT = {
  service(node, f) {
    const b = f.box(node.plan);
    const out = [];
    const stack = Math.min(node.replicas - 1, 3);
    for (let r = stack; r > 0; r--) out.push(f.rect({ ...b, x: b.x + r * 2.5, y: b.y - r * 2.5 }, "tp-f tp-f-back", 4));
    out.push(f.rect(b, "tp-f", 4));
    out.push(f.line([[b.x, b.y + 11], [b.x + b.w, b.y + 11]], "faint"));
    for (let r = 0; r < node.replicas; r++) out.push(f.led(`${node.id}:${r}`, b.x + 6 + r * 6, b.y + 5.5, 1.7));
    if (node.kind === "worker") out.push(`<circle class="tp-f-mark" cx="${r1(b.x + b.w - 7)}" cy="${r1(b.y + 5.5)}" r="2.6"/>`);
    return out.join("");
  },
  worker(node, f) {
    return FLAT.service(node, f);
  },
  cache(node, f) {
    const b = f.box(node.plan);
    const out = [f.rect(b, "tp-f", 4)];
    for (let i = 0; i < 4; i++) out.push(f.rect({ x: b.x + 7 + i * ((b.w - 14) / 4), y: b.y + 6, w: (b.w - 14) / 4 - 3, h: 7 }, "tp-f tp-f-chip", 1));
    out.push(f.led(`${node.id}:0`, b.x + b.w - 6, b.y + b.h - 10, 1.6));
    return out.join("");
  },
  db(node, f) {
    const b = f.box(node.plan);
    const rx = b.w / 2 - 2;
    const ry = Math.min(5, b.h / 6);
    const cx = b.x + b.w / 2;
    const top = b.y + ry + 1;
    const bot = b.y + b.h - ry - 1;
    const out = [`<path class="tp-f" d="M${r1(cx - rx)} ${r1(top)}V${r1(bot)}A${r1(rx)} ${r1(ry)} 0 0 0 ${r1(cx + rx)} ${r1(bot)}V${r1(top)}A${r1(rx)} ${r1(ry)} 0 0 0 ${r1(cx - rx)} ${r1(top)}Z"/>`];
    out.push(`<ellipse class="tp-f tp-f-top" cx="${r1(cx)}" cy="${r1(top)}" rx="${r1(rx)}" ry="${r1(ry)}"/>`);
    out.push(`<path class="k-line" data-tone="faint" d="M${r1(cx - rx)} ${r1(top + 9)}A${r1(rx)} ${r1(ry)} 0 0 0 ${r1(cx + rx)} ${r1(top + 9)}"/>`);
    out.push(f.led(`${node.id}:0`, cx + rx - 5, top + 14, 1.6));
    if (node.role) out.push(f.text(cx, top + 2.6, node.role.toUpperCase(), 5.5, "tp-ft tp-ft-dim"));
    if (node.tables || node.hasTables) out.push(`<g class="tp-rows-badge" data-rows="${escape(node.id)}">${f.text(cx, top + 22, "0 rows", 6, "tp-ft tp-ft-dim")}</g>`);
    return out.join("");
  },
  storage(node, f) {
    const b = f.box(node.plan);
    const cx = b.x + b.w / 2;
    const out = [`<path class="tp-f" d="M${r1(b.x + 2)} ${r1(b.y + 6)}L${r1(b.x + 7)} ${r1(b.y + b.h - 2)}H${r1(b.x + b.w - 7)}L${r1(b.x + b.w - 2)} ${r1(b.y + 6)}Z"/>`];
    out.push(`<ellipse class="tp-f tp-f-top" cx="${r1(cx)}" cy="${r1(b.y + 6)}" rx="${r1(b.w / 2 - 2)}" ry="4"/>`);
    out.push(f.led(`${node.id}:0`, cx, b.y + 16, 1.6));
    return out.join("");
  },
  lb(node, f) {
    const b = f.box(node.plan);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const r = Math.min(b.w, b.h) / 2;
    const oct = Array.from({ length: 8 }, (_, i) => {
      const a = ((i + 0.5) / 8) * Math.PI * 2;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
    const out = [`<path class="tp-f" d="${k.pathOf(oct, true)}"/>`];
    for (const a of [-0.6, 0, 0.6]) out.push(k.lineSvg(k.pathOf([[cx - r * 0.45, cy - 3], [cx + r * 0.5 * Math.cos(a), cy - 3 + r * 0.5 * Math.sin(a)]]), { tone: "mid", free: "end" }));
    out.push(f.led(`${node.id}:0`, cx - r * 0.45, cy - 3, 1.8));
    return out.join("");
  },
  gateway(node, f) {
    const b = f.box(node.plan);
    const out = [f.rect(b, "tp-f", 4)];
    out.push(`<path class="k-line" data-tone="lo" d="M${r1(b.x + 8)} ${r1(b.y + b.h)}V${r1(b.y + 12)}Q${r1(b.x + b.w / 2)} ${r1(b.y + 2)} ${r1(b.x + b.w - 8)} ${r1(b.y + 12)}V${r1(b.y + b.h)}"/>`);
    out.push(f.led(`${node.id}:0`, b.x + b.w / 2, b.y + 9, 1.6));
    return out.join("");
  },
  client(node, f) {
    const b = f.box(node.plan);
    const out = [f.rect({ x: b.x, y: b.y, w: b.w, h: b.h - 7 }, "tp-f", 3)];
    out.push(f.rect({ x: b.x + 3, y: b.y + 3, w: b.w - 6, h: b.h - 13 }, "tp-screen", 1));
    out.push(f.line([[b.x + b.w / 2, b.y + b.h - 7], [b.x + b.w / 2, b.y + b.h - 1]], "lo"));
    out.push(f.rect({ x: b.x + b.w / 2 - 8, y: b.y + b.h - 2, w: 16, h: 2 }, "tp-f", 1));
    out.push(f.led(`${node.id}:0`, b.x + b.w - 7, b.y + b.h - 10.5, 1.4));
    return out.join("");
  },
  box(node, f) {
    const b = f.box(node.plan);
    return [f.rect(b, "tp-f", 4), f.led(`${node.id}:0`, b.x + 6, b.y + 6, 1.6)].join("");
  },
  kafka(node, f) {
    const b = f.box(node.plan);
    const out = [f.rect(b, "tp-f", 4)];
    const s = f.scale;
    for (let p = 0; p < node.partitions; p++) {
      const lb = f.box(laneOf(node, p));
      out.push(`<g class="tp-lane" data-lane="${escape(node.id)}:${p}">`);
      for (let i = 0; i < SLOTS; i++) out.push(`<rect class="tp-cell tp-fcell" data-cell="${escape(node.id)}:${p}:${i}" x="${r1(lb.x + i * PITCH * s + 0.8)}" y="${r1(lb.y + 0.8)}" width="${r1(PITCH * s - 1.6)}" height="${r1(lb.h - 1.6)}" rx="1"/>`);
      (node.groups || ["default"]).slice(0, 3).forEach((_, g) => {
        out.push(`<path class="tp-cursor tp-fcursor" data-cursor="${escape(node.id)}:${g}:${p}" data-g="${g}" d="M${r1(lb.x)} ${r1(lb.y - 2 - g)}V${r1(lb.y + lb.h + 2 + g)}"/>`);
      });
      out.push(`</g>`);
    }
    if (node.brokers) {
      const n = node.brokers;
      const span = (b.h - 8) / n;
      for (let i = 0; i < n; i++) {
        const unit = { x: b.x + 5 * s, y: b.y + 4 * s + i * span + 0.6, w: 12 * s, h: span - 1.2 };
        out.push(`<g class="tp-broker" data-part="broker:${i}">${f.rect(unit, "tp-f tp-f-chip", 1)}${f.led(`${node.id}:b${i}`, unit.x + unit.w - 3, unit.y + unit.h / 2, 1.2)}</g>`);
      }
    } else for (let b2 = 0; b2 < 3; b2++) out.push(f.led(`${node.id}:b${b2}`, b.x + b.w - 4, b.y + 6 + b2 * 4, 1.1));
    return out.join("");
  },
  cdn(node, f) {
    const b = f.box(node.plan);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const r = Math.min(b.w, b.h) / 2 - 4;
    return [f.rect(b, "tp-f", 4), `<circle class="tp-f tp-f-top" cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}"/>`, `<ellipse class="tp-f-mark" cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(r * 0.45)}" ry="${r1(r)}"/>`, k.lineSvg(`M${r1(cx - r)} ${r1(cy)}H${r1(cx + r)}`, { tone: "faint" }), f.led(`${node.id}:0`, b.x + 5, b.y + b.h - 5, 1.5)].join("");
  },
  dns(node, f) {
    const b = f.box(node.plan);
    const cx = b.x + b.w / 2;
    return [`<path class="tp-f" d="M${r1(cx - 9)} ${r1(b.y + b.h - 1)}L${r1(cx - 2)} ${r1(b.y + 8)}H${r1(cx + 2)}L${r1(cx + 9)} ${r1(b.y + b.h - 1)}Z"/>`, `<circle class="tp-f tp-f-top" cx="${r1(cx)}" cy="${r1(b.y + 7)}" r="5"/>`, f.led(`${node.id}:0`, cx, b.y + 7, 1.6)].join("");
  },
  external(node, f) {
    const b = f.box(node.plan);
    return [f.rect(b, "tp-f tp-f-ext", 4), ...[0, 1, 2].map((i) => `<circle class="tp-f-dot" cx="${r1(b.x + b.w / 2 - 6 + i * 6)}" cy="${r1(b.y + b.h / 2)}" r="1.3"/>`), f.led(`${node.id}:0`, b.x + 6, b.y + 6, 1.5)].join("");
  },
  scheduler(node, f) {
    const b = f.box(node.plan);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const r = Math.min(b.w, b.h) / 2 - 3;
    return [f.rect(b, "tp-f", 4), `<circle class="tp-f tp-f-top" cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}"/>`, k.lineSvg(`M${r1(cx)} ${r1(cy)}V${r1(cy - r * 0.65)}M${r1(cx)} ${r1(cy)}L${r1(cx + r * 0.45)} ${r1(cy + r * 0.2)}`, { tone: "hi", free: "end" }), f.led(`${node.id}:0`, b.x + 5, b.y + b.h - 5, 1.5)].join("");
  },
  flags(node, f) {
    const b = f.box(node.plan);
    const out = [f.rect(b, "tp-f", 4)];
    flagRows(node).forEach(({ name, slot, knob }) => {
      out.push(f.rect(f.box(slot), "tp-f tp-f-chip", 2));
      out.push(`<g class="tp-knob" data-flag="${escape(name)}">${f.rect(f.box(knob), "tp-f-knob", 1.5)}</g>`);
      const sb = f.box(slot);
      out.push(`<text class="tp-ft tp-ft-dim" x="${r1(b.x + 4)}" y="${r1(sb.y + sb.h - 0.5)}" font-size="5.5" text-anchor="start">${escape(name.slice(0, 6))}</text>`);
    });
    out.push(f.led(`${node.id}:0`, b.x + b.w - 5, b.y + b.h - 4, 1.4));
    return out.join("");
  },
  queue(node, f) {
    return FLAT.kafka(node, f);
  },
};

// ---------------------------------------------------------------------------------------------
// One view: markup plus what the live page needs to move things in it.

// `camera` ({ azimuth, elevation }) overrides the iso camera: the page uses it to morph between views.
export function renderView(model, view, width = 640, camera, options) {
  const { P, width: W, height: H } = projectionOf(model, view, width, camera, options);
  const features = model.features || {};
  const out = [];
  const iso = view === "iso" ? isoKit(P) : null;
  const flat = view === "flat" ? flatKit(P) : null;
  // Morph frames (fastLabels) keep the spots chosen for the resting view.
  const plan = (model.fastLabels && model.labelPlans?.[view]) || labelPlanOf(model, view, P, W, H);
  (model.labelPlans ||= {})[view] = plan;

  // Zones and regions: floor plates (iso) or dashed regions (flat). A region is heavier.
  for (const group of model.groups) {
    if (iso) {
      const z0 = -(group.depth + 1);
      const h = group.region ? 1.6 : 1;
      out.push(`<path class="k-halo" d="${k.haloOf(group.box, z0, h, P)}" style="opacity:calc(var(--tp-halo-opacity) * .5)"/>`);
      out.push(`<g class="tp-zone" data-depth="${group.depth}"${group.region ? ' data-region=""' : ""}>${iso.S(k.slabOf(group.box, z0, h, P, 6, 0.6), { tone: group.region ? "mid" : "lo", crease: "faint" })}`);
      out.push(iso.L(k.planOutline(k.insetPlan(group.box, 4), z0 + h, P, 5), { tone: "faint", dashed: !group.region }));
      // Along the plate's left edge, where node labels never sit.
      out.push(k.faceTextSvg(k.topMatrix([group.box.x + 6.5, group.box.y + group.box.d - 8], z0 + h, P, "y"), String(group.label).toUpperCase(), { size: group.region ? 7 : 6, tone: group.region ? "hi" : "mid" }));
      out.push(`</g>`);
    } else {
      const b = flat.box(group.box);
      out.push(`<g class="tp-zone" data-depth="${group.depth}"${group.region ? ' data-region=""' : ""}>${flat.rect(b, "tp-fzone", 8)}<text class="tp-ft tp-ft-dim" x="${r1(b.x + 8)}" y="${r1(b.y + b.h - 7)}" font-size="${group.region ? 8 : 7}" text-anchor="start">${escape(String(group.label).toUpperCase())}</text></g>`);
    }
  }

  // Edges on the floor, with a chevron where they arrive and a port ring (or a breaker) at the caller.
  const labels = [];
  for (const edge of model.edges) {
    const line = k.onTop(edge.points, 0, P);
    const start = k.iso([edge.points[0][0], edge.points[0][1], 0], P);
    const dashed = edge.kind === "async" || edge.kind === "replication" || edge.kind === "config";
    const [a, b] = [edge.points[edge.points.length - 2], edge.points[edge.points.length - 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const v = [-u[1], u[0]];
    const tip = [b[0] - u[0] * 1.5, b[1] - u[1] * 1.5];
    const head = [
      [tip[0] - u[0] * 5 + v[0] * 3, tip[1] - u[1] * 5 + v[1] * 3],
      tip,
      [tip[0] - u[0] * 5 - v[0] * 3, tip[1] - u[1] * 5 - v[1] * 3],
    ];
    const tone = edge.kind === "config" ? "lo" : "mid";
    const port = edge.breaker
      ? `<circle class="tp-breaker" data-breaker="${edge.index}" cx="${r1(start[0])}" cy="${r1(start[1])}" r="2.4"/>`
      : edge.sync ? `<circle class="tp-port" cx="${r1(start[0])}" cy="${r1(start[1])}" r="1.4"/>` : "";
    out.push(`<g class="tp-edge" data-edge="${edge.index}" data-kind="${edge.kind}">${edge.detail ? `<title>${escape(edge.detail)}</title>` : ""}<path class="tp-edge-bed" d="${line}"/>${k.lineSvg(line, { tone, dashed })}${k.lineSvg(k.onTop(head, 0, P), { tone, free: true })}${port}</g>`);
    const spot = plan.edges.get(edge.index);
    if (spot) labels.push(edgeLabel(edge, P, view, spot));
  }
  for (const node of model.nodes) {
    const title = node.labelShortened ? `<title>${escape(node.label)}</title>` : "";
    out.push(`<g class="tp-label" data-label="${escape(node.id)}">${title}${iso ? isoLabel(node, P, plan) : flatLabel(node, P, plan)}</g>`);
  }
  out.push(...labels);
  out.push(`<g class="tp-packets" data-packets=""></g>`);

  // Nodes, back to front.
  const order = [...model.nodes].sort((a, b) => k.depthOf([a.cx, a.cy, 0], P) - k.depthOf([b.cx, b.cy, 0], P));
  for (const node of order) {
    const halo = iso ? `<path class="k-halo" d="${k.haloOf(k.insetPlan(node.plan, 2), 0, Math.min(heightOf(node), 10), P)}"/>` : "";
    const component = COMPONENTS[node.kind];
    const body = component
      ? (iso ? isoComponent(node, iso, k) : flatComponent(node, flat, k))
      : (iso ? (ISO[node.kind] || ISO.box)(node, iso) : (FLAT[node.kind] || FLAT.box)(node, flat));
    const extra = (node.sidecar ? sidecarOf(node, iso, flat) : "") + (node.queue ? queueCellsOf(node, iso, flat) : "");
    out.push(`<g class="tp-node" data-node="${escape(node.id)}" data-kind="${node.kind}">${halo}${body}${extra}</g>`);
  }

  const svg = k.figureSvg({ width: W, height: H, label: describe(model), body: out, className: `tp-svg tp-${view}` });
  const lift = iso ? 1.5 : 0;
  const toScreen = (p, z = 0) => k.iso([p[0], p[1], z], P);
  const vec = (dx, dy) => {
    const a = toScreen([0, 0]);
    const b = toScreen([dx, dy]);
    return [b[0] - a[0], b[1] - a[1]];
  };
  const flagNode = model.nodes.find((node) => node.kind === "flags");
  const data = {
    P,
    edges: model.edges.map((edge) => edge.points.map((p) => toScreen(p, lift)).map(([x, y]) => [r1(x), r1(y)])),
    step: vec(PITCH, 0),
    flagStep: flagNode ? vec(flagRows(flagNode)[0]?.travel || 0, 0) : [0, 0],
    packet: iso ? isoPacket(P) : null,
  };
  return { svg, data, P, width: W, height: H };
}

// A live label on an edge, at the spot labelPlanOf chose; a crowded one waits for focus.
function edgeLabel(edge, P, view, spot) {
  const text = edge.label || "";
  const attrs = `class="tp-elabel" data-elabel="${edge.index}"${spot.crowded ? " data-crowded" : ""}`;
  if (view === "iso") return `<g ${attrs}>${k.faceTextSvg(k.topMatrix(spot.at, 0, P, spot.along), text, { size: EDGE_TEXT, tone: "mid", anchor: spot.anchor })}</g>`;
  const [x, y] = k.iso([spot.at[0], spot.at[1], 0], P);
  return `<g ${attrs}><text class="tp-ft tp-elabel-text" x="${r1(x)}" y="${r1(y)}" font-size="${EDGE_TEXT}" text-anchor="${spot.anchor}">${escape(text)}</text></g>`;
}

// A sidecar proxy: a small box on the service's right-hand side.
function sidecarOf(node, iso, flat) {
  const { plan } = node;
  const box = { x: plan.x + plan.w + 1.5, y: plan.y + plan.d - 14, w: 9, d: 12, r: 1 };
  if (iso) return `<g class="tp-sidecar">${iso.S(k.slabOf(box, 0, Math.max(6, heightOf(node) * 0.6), iso.P, 2, 0.4), { tone: "mid" })}${iso.led(`${node.id}:s`, [box.x + box.w / 2, box.y + box.d, 3], 0.9)}</g>`;
  return `<g class="tp-sidecar">${flat.rect(flat.box(box), "tp-f tp-f-chip", 1.5)}</g>`;
}

// A node's buffer: up to 8 cells along its top, lit by how full the queue is.
function queueCellsOf(node, iso, flat) {
  const n = Math.min(8, node.queue);
  const out = [];
  if (iso) {
    const z = heightOf(node);
    for (let i = 0; i < n; i++) {
      const cell = { x: node.cx - n * 2.2 + i * 4.4, y: node.cy + 2, w: 3.4, d: 3.4, r: 0.5 };
      out.push(`<g class="tp-cell tp-qcell" data-qcell="${escape(node.id)}:${i}">${iso.S(k.slabOf(cell, z, 1.4, iso.P, 2), { tone: "lo", crease: "none" })}</g>`);
    }
  } else {
    const b = flat.box(node.plan);
    const size = Math.min(4, (b.w - 8) / n - 1);
    for (let i = 0; i < n; i++) out.push(`<rect class="tp-cell tp-fcell tp-qcell" data-qcell="${escape(node.id)}:${i}" x="${r1(b.x + 4 + i * (size + 1))}" y="${r1(b.y + b.h - size - 3)}" width="${r1(size)}" height="${r1(size)}" rx=".6"/>`);
  }
  return out.join("");
}

// A packet is a tiny cube drawn once around the screen origin; the page translates it.
function isoPacket(P) {
  const P0 = { ...P, origin: [0, 0] };
  const s = 2.2;
  const paths = k.slabOf({ x: -s, y: -s, w: s * 2, d: s * 2, r: 0 }, 0, s * 1.6, P0, 1);
  return { top: paths.top, sides: paths.shades.filter(Boolean).join(""), outline: paths.outline };
}

function describe(model) {
  const kinds = model.nodes.map((node) => `${node.label} (${node.kind})`).join(", ");
  const links = model.edges.map((edge) => `${model.byId.get(edge.from).label} to ${model.byId.get(edge.to).label}`).join("; ");
  return `${model.title}: ${kinds}. Connections: ${links}.`;
}

// The one way a model is built, in Node and in the page: resolve the tool's features, lay
// out and route the spec, then add hops if they're on.
export function modelOf(spec, featureLayers = []) {
  const features = resolveFeatures(spec.features, ...featureLayers);
  validateSpec(spec, features, KINDS);
  const model = prepare(stripFeatures(spec, features));
  model.features = features;
  if (features.hops) applyHops(model);
  return model;
}

const GEOMETRY = new Set(["plan", "cx", "cy", "w", "d", "h", "auto", "at", "labelSpot", "labelLines", "labelShortened", "groups", "index", "points", "lens", "corners", "ends", "ports", "channel", "axisOf", "via", "bend", "axis"]);
const strip = (object) => Object.fromEntries(Object.entries(object).filter(([key, value]) => !GEOMETRY.has(key) && value !== undefined));

// What the sim needs: everything in the spec except geometry, plus each edge's length.
export function simSpec(model) {
  return {
    nodes: model.nodes.map(node => ({ ...strip(node), ...(COMPONENTS[node.kind] ? { kind: baseKind(node.kind), component: node.kind } : {}) })),
    edges: model.edges.map((edge) => ({ ...strip(edge), len: edge.len })),
    sim: model.sim,
    scenario: model.scenario,
    flags: model.flags,
    records: model.records,
    ...(model.traffic ? { traffic: model.traffic } : {}),
    ...(model.policies ? { policies: model.policies } : {}),
    features: model.features,
  };
}

export const TOPO_CSS = `
.tp-stage{position:relative;outline:none;touch-action:manipulation}
.tp-stage:focus-visible{outline:1px dashed var(--tp-faint);outline-offset:6px}
.tp-svg[hidden]{display:none}
.tp-morph{pointer-events:none}
.tp-morph svg{display:block}
.tp-node{cursor:pointer;transition:opacity .25s var(--tp-ease)}
.tp-edge .k-line{transition:stroke .2s}
.tp-edge-bed{fill:none;stroke:var(--tp-card);stroke-width:3.4px;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.tp-iso .tp-edge-bed{stroke:none}
.tp-port{fill:var(--tp-card);stroke:var(--tp-mid);stroke-width:var(--tp-weight);vector-effect:non-scaling-stroke}
.tp-stage[data-focus] .tp-node:not([data-near]){opacity:.38}
.tp-stage[data-focus] .tp-edge:not([data-near]) .k-line{stroke:var(--tp-faint)}
.tp-stage[data-focus] .tp-edge[data-near] .k-line{stroke:var(--tp-hi)}
.tp-stage[data-focus] .tp-label:not([data-near]) text{fill:var(--tp-lo)}
.tp-label .tp-ft{fill:var(--tp-text);paint-order:stroke;stroke:var(--tp-card);stroke-width:2.5px;stroke-linejoin:round}
.tp-node[data-sel] .k-solid>.k-edge{stroke:var(--tp-lit)}
.tp-node[data-sel] .tp-f{stroke:var(--tp-lit)}
.tp-led{fill:var(--tp-lo);stroke:none;transition:fill .5s}
.tp-led[data-on]{fill:var(--tp-green);transition:none}
.tp-node[data-down] .tp-led{fill:var(--tp-red)}
.tp-node[data-down]>*:not(.tp-led){opacity:.4}
.tp-node[data-down] .k-edge,.tp-node[data-down] .tp-f{stroke-dasharray:2 2}
.tp-screen{fill:var(--tp-shade-0);stroke:var(--tp-lo);stroke-width:var(--tp-weight);vector-effect:non-scaling-stroke}
.tp-cell[data-on] .k-top{fill:var(--tp-hi)}
.tp-cell[data-on] .k-shade{fill:var(--tp-mid)}
.tp-cell[data-on] .k-edge{stroke:var(--tp-hi)}
.tp-fcell{fill:var(--tp-card);stroke:var(--tp-lo);stroke-width:var(--tp-weight);vector-effect:non-scaling-stroke}
.tp-fcell[data-on]{fill:var(--tp-hi);stroke:var(--tp-hi)}
.tp-fcursor{fill:none;stroke:var(--tp-lit);stroke-width:1.4px;vector-effect:non-scaling-stroke;stroke-linecap:round}
.tp-cursor[data-g="1"]{--tp-cur:var(--tp-blue)}
.tp-fcursor[data-g="1"]{stroke:var(--tp-blue)}
.tp-fcursor[data-g="2"]{stroke:var(--tp-green)}
.tp-cursor[data-g="1"] .k-edge{stroke:var(--tp-blue)}
.tp-cursor[data-g="2"] .k-edge{stroke:var(--tp-green)}
.tp-f{fill:var(--tp-card);stroke:var(--tp-mid);stroke-width:var(--tp-weight);vector-effect:non-scaling-stroke}
.tp-f-back{stroke:var(--tp-lo)}
.tp-f-top{fill:var(--tp-face)}
.tp-f-chip{fill:var(--tp-face);stroke:var(--tp-lo)}
.tp-f-mark{fill:none;stroke:var(--tp-lo);stroke-width:var(--tp-weight);vector-effect:non-scaling-stroke}
.tp-fzone{fill:var(--tp-shade-1);stroke:var(--tp-lo);stroke-width:var(--tp-weight);stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
.tp-ft{fill:var(--tp-hi);font-family:var(--tp-mono);letter-spacing:.02em}
.tp-ft-dim{fill:var(--tp-muted)}
.tp-zone .k-text{letter-spacing:.14em}
.tp-pk{pointer-events:none}
.tp-pk[data-kind="request"]{--pk:var(--tp-lit)}
.tp-pk[data-kind="response"]{--pk:var(--tp-mid)}
.tp-pk[data-kind="record"]{--pk:var(--tp-blue)}
.tp-pk[data-kind="replication"]{--pk:var(--tp-green)}
.tp-pk[data-kind="drop"]{--pk:var(--tp-red)}
.tp-pk[data-kind="error"]{--pk:var(--tp-red)}
.tp-pk[data-kind="retry"]{--pk:var(--tp-amber)}
.tp-pk[data-kind="late"]{--pk:var(--tp-lo)}
.k-swatch[data-mark="amber"] path{stroke:var(--tp-amber)}
.tp-ext .k-edge,.tp-f-ext{stroke-dasharray:2.5 2}
.tp-f-dot{fill:var(--tp-mid)}
.tp-f-knob{fill:var(--tp-lit);stroke:none}
.tp-breaker{fill:var(--tp-card);stroke:var(--tp-mid);stroke-width:1px;vector-effect:non-scaling-stroke}
.tp-breaker[data-state="open"]{fill:var(--tp-red);stroke:var(--tp-red)}
.tp-breaker[data-state="half"]{fill:var(--tp-amber);stroke:var(--tp-amber)}
.tp-edge[data-breaker="open"] .k-line{stroke:var(--tp-red);stroke-dasharray:1.5 2.5}
.tp-edge[data-kind="config"] .k-line{stroke-dasharray:1 3}
.tp-elabel .k-text,.tp-elabel-text{fill:var(--tp-muted);font-variant-numeric:tabular-nums}
.tp-elabel-text{paint-order:stroke;stroke:var(--tp-card);stroke-width:2.5px;stroke-linejoin:round}
.tp-elabel[data-bad] .k-text,.tp-elabel[data-bad] .tp-elabel-text{fill:var(--tp-red)}
.tp-elabel[data-crowded]{display:none}
.tp-stage[data-focus] .tp-elabel[data-crowded][data-near]{display:inline}
.tp-lane{transition:opacity .3s}
.tp-lane[data-paused]{opacity:.3}
.tp-broker{cursor:pointer}
.tp-broker[data-down] .tp-led{fill:var(--tp-red)}
.tp-broker[data-down]>*:not(.tp-led){opacity:.4}
.tp-qcell[data-on] .k-top{fill:var(--tp-amber)}
.tp-fcell.tp-qcell[data-on]{fill:var(--tp-amber);stroke:var(--tp-amber)}
.tp-inspect{margin:16px 0 -6px;padding:10px 12px 12px;background:var(--tp-page);box-shadow:0 0 0 1px var(--tp-lo);font:11px/1.5 var(--tp-mono);color:var(--tp-text)}
.tp-inspect[hidden],.tp-tip[hidden]{display:none}
.tp-inspect header{display:flex;align-items:center;gap:10px;min-width:0}
.tp-ins-kind{color:var(--tp-muted);text-transform:uppercase;letter-spacing:.1em;font-size:9.5px}
.tp-ins-name{color:var(--tp-strong);font-weight:600}
.tp-ins-detail{margin:6px 0 0;color:var(--tp-text);white-space:pre-wrap;overflow-wrap:anywhere}
.tp-ins-stat{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tp-muted)}
.tp-inspect header button{all:unset;cursor:pointer}
button.tp-route{border:0;margin:0;background:none;color:inherit;font:inherit;cursor:pointer;width:100%;box-sizing:border-box}
.tp-ins-fail{padding:2px 8px;box-shadow:0 0 0 1px var(--tp-lo);color:var(--tp-text)}
.tp-ins-fail:hover{color:var(--tp-red);box-shadow:0 0 0 1px var(--tp-red)}
.tp-inspect[data-down] .tp-ins-fail{color:var(--tp-green);box-shadow:0 0 0 1px var(--tp-green)}
.tp-ins-close{padding:0 4px;font-size:15px;line-height:1;color:var(--tp-muted)}
.tp-inspect button:focus-visible{outline:1px solid var(--tp-lit)}
.tp-ins-body:not(:empty){margin-top:10px}
.tp-routes{display:grid;gap:1px}
.tp-route{display:grid;grid-template-columns:minmax(0,1fr) 64px 52px 52px 60px;gap:8px;align-items:baseline;padding:3px 4px;text-align:right;font-variant-numeric:tabular-nums}
.tp-route>span:first-child{text-align:left}
.tp-route-head{color:var(--tp-muted);font-size:9.5px;text-transform:uppercase;letter-spacing:.08em}
button.tp-route:hover{background:var(--tp-shade-2)}
button.tp-route[data-on]{background:var(--tp-shade-3);box-shadow:inset 2px 0 0 var(--tp-lit)}
.tp-route-name{color:var(--tp-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-route-name small{display:block;color:var(--tp-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis}
.tp-route [data-bad]{color:var(--tp-red)}
.tp-table{margin-top:10px}
.tp-table+.tp-table{margin-top:14px}
.tp-table-head{color:var(--tp-muted)}
.tp-table-head b{color:var(--tp-strong);font-weight:600}
.tp-table-head i,.tp-wal-note i{color:var(--tp-red);font-style:normal}
.tp-table-head em{color:var(--tp-amber);font-style:normal}
.tp-rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:3px;margin-top:6px}
.tp-row{display:flex;gap:8px;padding:2px 6px;background:var(--tp-shade-1);box-shadow:inset 2px 0 0 var(--tp-lo);font-variant-numeric:tabular-nums;transition:background .6s,box-shadow .6s}
button.tp-row{border:0;margin:0;width:100%;min-width:0;text-align:left;color:inherit;font:inherit;cursor:pointer}
button.tp-row:hover{outline:1px solid var(--tp-muted)}
.tp-record{margin-top:12px;padding:10px;border:1px solid var(--tp-lo)}
.tp-record header{flex-wrap:wrap}
.tp-record-query{padding:8px;background:var(--tp-shade-1);white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:var(--tp-strong)}
.tp-record dl{display:grid;grid-template-columns:minmax(70px,1fr) minmax(0,2fr);gap:3px 12px;margin:10px 0}
.tp-record dt{color:var(--tp-muted);overflow-wrap:anywhere}
.tp-record dd{margin:0;color:var(--tp-strong);overflow-wrap:anywhere;white-space:pre-wrap}
.tp-inspect .tp-record header button{border:1px solid var(--tp-lo);padding:3px 7px;color:var(--tp-text);background:var(--tp-page);font:inherit;cursor:pointer}
.tp-record-copies{display:grid;gap:5px;margin-top:10px}
.tp-record-copy{padding:5px 7px;background:var(--tp-shade-1);overflow-wrap:anywhere}
.tp-record-copy[data-behind]{border-left:2px solid var(--tp-amber)}
.tp-record-copy small{display:block;color:var(--tp-muted)}
.tp-row b,.tp-row span:first-of-type{flex-shrink:0}
.tp-row span:last-of-type{min-width:0;flex:1}
.tp-row b{color:var(--tp-strong);font-weight:500}
.tp-row span{color:var(--tp-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-row[data-fresh]{background:var(--tp-shade-3);box-shadow:inset 2px 0 0 var(--tp-green);transition:none}
.tp-row[data-behind]{box-shadow:inset 2px 0 0 var(--tp-amber)}
.tp-row[data-behind] span:first-of-type{color:var(--tp-amber)}
.tp-wal{display:flex;align-items:center;gap:2px;margin-top:8px}
.tp-wal>span{margin-right:6px;color:var(--tp-muted);font-size:9.5px;letter-spacing:.08em}
.tp-wal i{width:9px;height:9px;background:var(--tp-mid);box-shadow:inset 0 0 0 1px var(--tp-lo)}
.tp-wal i[data-pending]{background:var(--tp-amber)}
.tp-wal-note{margin:4px 0 0;color:var(--tp-muted);font-size:10px}
.tp-ins-note{margin:6px 4px 0;color:var(--tp-muted);font-size:10px}
.tp-tip{position:absolute;z-index:3;width:220px;transform:translateY(-100%);padding:6px 8px;background:var(--tp-card);box-shadow:0 0 0 1px var(--tp-mid);font:10px/1.5 var(--tp-mono);color:var(--tp-text);pointer-events:none}
.tp-tip b{color:var(--tp-strong);font-weight:500}
.tp-tip i{color:var(--tp-red);font-style:normal}
.k-corner[data-corner="hint"]{max-width:50%;overflow:hidden;text-overflow:ellipsis}
.k-corner[data-corner="readout"]{max-width:50%;overflow:hidden;text-overflow:ellipsis}
@media (max-width:560px){.tp-route{grid-template-columns:minmax(0,1fr) 54px 46px 46px}.tp-route>span:last-child{display:none}.tp-tip{display:none}}
.tp-trace{margin:16px 0 -6px;padding:10px 12px 12px;background:var(--tp-page);box-shadow:0 0 0 1px var(--tp-lit);font:11px/1.5 var(--tp-mono);color:var(--tp-text)}
.tp-trace[hidden]{display:none}
.tp-trace header{display:flex;align-items:center;gap:10px;min-width:0}
.tp-trace header button{all:unset;cursor:pointer}
.tp-tr-name{color:var(--tp-strong);font-weight:600}
.tp-tr-stat{flex:1;color:var(--tp-muted)}
.tp-tr-again,.tp-ins-follow{padding:2px 8px;box-shadow:0 0 0 1px var(--tp-lo);color:var(--tp-text)}
.tp-ins-follow[hidden]{display:none}
.tp-tr-body{display:grid;gap:2px;margin-top:10px}
.tp-span{display:grid;grid-template-columns:minmax(0,1.3fr) 56px minmax(0,1fr);gap:10px;align-items:center}
.tp-span-name{color:var(--tp-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-span-name small{color:var(--tp-muted);font-size:10px}
.tp-span-ms{text-align:right;font-variant-numeric:tabular-nums}
.tp-span-bar{position:relative;height:8px;background:var(--tp-shade-1)}
.tp-span-bar i{position:absolute;top:0;bottom:0;background:var(--tp-mid)}
.tp-span[data-open] .tp-span-bar i{background:var(--tp-amber)}
.tp-span[data-bad] .tp-span-bar i{background:var(--tp-red)}
.tp-stage[data-tracing] .tp-node:not([data-traced]){opacity:.3}
.tp-stage[data-tracing] .tp-edge:not([data-traced]) .k-line{stroke:var(--tp-faint)}
.tp-stage[data-tracing] .tp-edge[data-traced] .k-line{stroke:var(--tp-hi)}
@media (max-width:560px){.tp-span{grid-template-columns:minmax(0,1fr) 50px}.tp-span-bar{display:none}}
.tp-story{margin:18px 0 -10px}
.tp-timeline{display:flex;align-items:center;gap:10px;font-family:var(--tp-mono);font-size:10.5px;color:var(--tp-muted)}
.tp-play{all:unset;flex:none;cursor:pointer;width:24px;height:22px;text-align:center;line-height:22px;font-size:9px;color:var(--tp-strong);box-shadow:0 0 0 1px var(--tp-lo)}
.tp-play:focus-visible,.tp-track:focus-visible{outline:1px solid var(--tp-lit);outline-offset:2px}
.tp-track{position:relative;flex:1;height:28px;cursor:pointer;touch-action:none}
.tp-track::before{content:"";position:absolute;left:0;right:0;top:20px;height:1px;background:var(--tp-lo)}
.tp-phase{all:unset;position:absolute;top:0;bottom:0;box-sizing:border-box;border-left:1px solid var(--tp-lo);cursor:pointer}
.tp-phase span{position:absolute;left:5px;top:2px;max-width:calc(100% - 8px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--tp-muted)}
.tp-phase:hover span,.tp-phase[data-now] span{color:var(--tp-strong)}
.tp-phase[data-now]{background:color-mix(in srgb,var(--tp-hi) 5%,transparent)}
.tp-tick{position:absolute;top:16px;width:1px;height:9px;background:var(--tp-mid);pointer-events:none}
.tp-head{position:absolute;top:12px;height:17px;width:2px;margin-left:-1px;background:var(--tp-lit);pointer-events:none}
.tp-time{flex:none;min-width:40px;text-align:right;font-variant-numeric:tabular-nums}
.tp-say{margin:8px 0 0 34px;min-height:3em;font-size:12.5px;line-height:1.5;color:var(--tp-text)}
.tp-story[data-mode="free"] .tp-track{opacity:.4}
@media (max-width:560px){.tp-say{margin-left:0}}
.tp-pk .pk-top{fill:var(--pk)}
.tp-pk .pk-side{fill:color-mix(in srgb,var(--pk) 55%,var(--tp-card))}
.tp-pk .pk-edge{fill:none;stroke:color-mix(in srgb,var(--pk) 70%,var(--tp-card));stroke-width:.4px;vector-effect:non-scaling-stroke}
.tp-pk circle{fill:var(--pk)}
.tp-pk .pk-trail{fill:none;stroke:var(--pk);stroke-width:1.6px;stroke-linecap:round;opacity:.28;vector-effect:non-scaling-stroke}
.tp-spark{width:52px;height:10px;margin-right:9px;vertical-align:-1px;overflow:visible}
.tp-spark polyline{fill:none;stroke:var(--tp-mid);stroke-width:1px;stroke-linejoin:round;vector-effect:non-scaling-stroke}
@media (max-width:560px){.tp-spark{display:none}}
.tp-views{position:absolute;top:13px;left:50%;transform:translateX(-50%);display:flex;gap:0;z-index:2;font-family:var(--tp-mono);font-size:10px;letter-spacing:.08em}
.tp-views button{all:unset;cursor:pointer;padding:3px 9px;color:var(--tp-muted);box-shadow:0 0 0 1px var(--tp-lo)}
.tp-views button[aria-pressed="true"]{color:var(--tp-strong);box-shadow:0 0 0 1px var(--tp-mid);background:var(--tp-shade-2)}
.tp-views button:focus-visible{outline:1px solid var(--tp-lit)}
@media (max-width:560px){.k-card:has(.tp-views){padding-top:72px}.tp-views{top:40px}}
`;
