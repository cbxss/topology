// Topology: turn a declarative system spec into an interactive figure, drawn either
// isometric (solids on a floor, built with kit/iso.mjs) or flat (2D glyphs on the same layout).
// One world layout feeds both views, so edges, packets and ports line up in each.

import * as k from "./iso.mjs";
import { isLog } from "./topo-sim.mjs";

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
export const SLOTS = 12;
const PITCH = 7;
const LANE = 11;

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    return { ...raw, kind, index, w: raw.w ?? base.w, d, h: base.h, partitions, replicas, label: raw.label ?? raw.id };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = (spec.edges || []).map((raw, index) => {
    const [from, to] = raw.from ? [raw.from, raw.to] : raw;
    if (!byId.has(from) || !byId.has(to)) throw new Error(`edge ${index}: unknown node ${byId.has(from) ? to : from}`);
    const sync = raw.sync ?? (raw.kind ? false : !isLog(byId.get(to)) && !isLog(byId.get(from)));
    return { ...(Array.isArray(raw) ? {} : raw), from, to, index, kind: raw.kind || (isLog(byId.get(to)) || isLog(byId.get(from)) ? "async" : "sync"), sync };
  });
  layout(nodes, edges, spec);
  const groups = groupsOf(spec.groups || [], byId);
  route(nodes, edges, byId);
  for (const node of nodes) {
    if (!isLog(node)) continue;
    const names = [];
    for (const edge of edges) if (edge.from === node.id) {
      const name = node.kind === "queue" ? "queue" : edge.group || "default";
      if (!names.includes(name)) names.push(name);
    }
    node.groups = names.length ? names : ["default"];
  }
  return { title: spec.title || "System", fig: spec.fig || "Fig 1", caption: spec.caption, hint: spec.hint, nodes, edges, groups, byId, sim: spec.sim || {}, keys: spec.keys, scenario: spec.scenario, flags: spec.flags, features: spec.features };
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
  for (const edge of edges) {
    edge.ports = edge.ends.map(({ node, side, offset }) => {
      const sx = side === "+x" ? 1 : side === "-x" ? -1 : 0;
      const sy = side === "+y" ? 1 : side === "-y" ? -1 : 0;
      return [node.cx + (sx * node.w) / 2 + (sx ? 0 : offset), node.cy + (sy * node.d) / 2 + (sy ? 0 : offset)];
    });
  }
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
    const [p, q] = edge.ends.map(({ node, side, offset }) => {
      const sx = side === "+x" ? 1 : side === "-x" ? -1 : 0;
      const sy = side === "+y" ? 1 : side === "-y" ? -1 : 0;
      return [node.cx + (sx * node.w) / 2 + (sx ? 0 : offset), node.cy + (sy * node.d) / 2 + (sy ? 0 : offset)];
    });
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
    edge.lens = [0];
    for (let i = 1; i < edge.points.length; i++) edge.lens.push(edge.lens[i - 1] + Math.hypot(edge.points[i][0] - edge.points[i - 1][0], edge.points[i][1] - edge.points[i - 1][1]));
    edge.len = edge.lens[edge.lens.length - 1];
  }
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
  for (const node of model.nodes) pts.push([node.cx - node.label.length * 2.6, node.plan.y + node.plan.d + 14, 0], [node.cx + node.label.length * 2.6, node.plan.y + node.plan.d + 14, 0]);
  return pts;
}

export function heightOf(node) {
  if (node.kind === "service" || node.kind === "worker") return node.replicas * 8.8 + 1;
  if (node.kind === "kafka" || node.kind === "queue") return 10;
  return node.h;
}

export function projectionOf(model, view, width = 640) {
  const { azimuth, elevation } = VIEWS[view];
  const pts = extentOf(model, view);
  const unit = { origin: [0, 0], scale: 1, azimuth, elevation };
  const flat = pts.map((p) => k.iso(p, unit));
  const xs = flat.map(([x]) => x);
  const ys = flat.map(([, y]) => y);
  const aspect = (Math.max(...ys) - Math.min(...ys)) / (Math.max(...xs) - Math.min(...xs));
  const pad = 26;
  const height = Math.round(Math.min(760, Math.max(240, (width - pad * 2) * aspect + pad * 2)));
  return { P: k.fitProjection(pts, width, height, { pad, azimuth, elevation }), width, height };
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
    const r = Math.min(node.w, node.d) / 2 - 1;
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
    return out.join("");
  },
  storage(node, c) {
    const r = Math.min(node.w, node.d) / 2 - 1;
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
    const ring = k.circleRing(node.cx, node.cy, r, 8).map(([x, y]) => [x, y]);
    const rot = ring.map((_, i) => {
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
    for (let b = 0; b < 3; b++) out.push(c.led(`${node.id}:b${b}`, [plan.x + 6 + b * 5, fy, 3], 1.1));
    out.push(c.L(c.faceY(plan.x + 24, plan.x + plan.w - 6, fy, 2, 4), { tone: "faint" }));
    for (let p = 0; p < node.partitions; p++) {
      const lane = laneOf(node, p);
      out.push(c.S(k.slabOf({ ...lane, x: lane.x - 2, w: lane.w + 4, y: lane.y - 0.5, d: lane.d + 1, r: 1 }, 6, 0.6, c.P, 2), { tone: "lo", crease: "none" }));
      for (let i = 0; i < SLOTS; i++) {
        const cell = { x: lane.x + i * PITCH + 0.7, y: lane.y + 0.8, w: PITCH - 1.4, d: lane.d - 1.6, r: 0.6 };
        out.push(`<g class="tp-cell" data-cell="${escape(node.id)}:${p}:${i}">${c.S(k.slabOf(cell, 6.6, 2.2, c.P, 2), { tone: "lo", crease: "none" })}</g>`);
      }
      (node.groups || ["default"]).slice(0, 3).forEach((_, g) => {
        const x = lane.x;
        const post = { x: x - 0.8, y: lane.y - 1.4 + g * 0.0, w: 1.6, d: lane.d + 2.8, r: 0.4 };
        out.push(`<g class="tp-cursor" data-cursor="${escape(node.id)}:${g}:${p}" data-g="${g}">${c.S(k.slabOf(post, 6.6, 4.4 + g * 1.6, c.P, 1), { tone: "hi", lit: g === 0 })}</g>`);
      });
    }
    return out.join("");
  },
  queue(node, c) {
    return ISO.kafka(node, c);
  },
};

export function laneOf(node, p) {
  const top = node.plan.y + 7;
  return { x: node.plan.x + node.plan.w - 8 - SLOTS * PITCH, y: top + p * LANE, w: SLOTS * PITCH, d: LANE - 3, r: 1 };
}

// Where a node's label lies on the floor in iso: in front of it, else along its right side,
// whichever no nearer node hides. `labelSpots` is shared with `build.mjs --check`.
export function labelSpots(node) {
  const half = node.label.length * 2.4;
  const front = { at: [node.cx, node.plan.y + node.plan.d + 10], along: "x" };
  front.marks = [[node.cx - half, front.at[1]], front.at, [node.cx + half, front.at[1]]];
  const side = { at: [node.plan.x + node.plan.w + 9, node.cy], along: "y" };
  side.marks = [[side.at[0], node.cy - half], side.at, [side.at[0], node.cy + half]];
  return [front, side];
}

export function hiddenBy(model, node, spot, P) {
  const marks = spot.marks.map((m) => ({ s: k.iso([m[0], m[1], 0], P), depth: k.depthOf([m[0], m[1], 0], P) }));
  const blockers = [];
  for (const other of model.nodes) {
    if (other === node) continue;
    const hull = hullOf(k.boxCorners(other.plan, 0, heightOf(other)).map((c) => k.iso(c, P)));
    const front = k.depthOf([other.cx, other.cy, 0], P);
    const hidden = marks.filter((m) => front > m.depth - 20 && inside(hull, m.s)).length;
    if (hidden >= 1) blockers.push(other.id);
  }
    return blockers;
}

function hullOf(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function inside(hull, [x, y]) {
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i];
    const [bx, by] = hull[(i + 1) % hull.length];
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
  }
  return hull.length > 2;
}

function isoLabel(node, c, model) {
  const spots = labelSpots(node);
  const spot = (node.labelAt === "side" ? [spots[1]] : node.labelAt === "front" ? [spots[0]] : spots).find((s) => !hiddenBy(model, node, s, c.P).length) || spots[0];
  node.labelSpot = spot;
  return k.faceTextSvg(k.topMatrix(spot.at, 0, c.P, spot.along), node.label, { size: 8, tone: "hi", anchor: "middle" });
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
      for (let i = 0; i < SLOTS; i++) out.push(`<rect class="tp-cell tp-fcell" data-cell="${escape(node.id)}:${p}:${i}" x="${r1(lb.x + i * PITCH * s + 0.8)}" y="${r1(lb.y + 0.8)}" width="${r1(PITCH * s - 1.6)}" height="${r1(lb.h - 1.6)}" rx="1"/>`);
      (node.groups || ["default"]).slice(0, 3).forEach((_, g) => {
        out.push(`<path class="tp-cursor tp-fcursor" data-cursor="${escape(node.id)}:${g}:${p}" data-g="${g}" d="M${r1(lb.x)} ${r1(lb.y - 2 - g)}V${r1(lb.y + lb.h + 2 + g)}"/>`);
      });
    }
    for (let b2 = 0; b2 < 3; b2++) out.push(f.led(`${node.id}:b${b2}`, b.x + b.w - 4, b.y + 6 + b2 * 4, 1.1));
    return out.join("");
  },
  queue(node, f) {
    return FLAT.kafka(node, f);
  },
};

// ---------------------------------------------------------------------------------------------
// One view: markup plus what the live page needs to move things in it.

export function renderView(model, view, width = 640) {
  const { P, width: W, height: H } = projectionOf(model, view, width);
  const out = [];
  const deepest = Math.max(0, ...model.groups.map((group) => group.depth + 1));
  if (view === "iso") {
    const c = isoKit(P);
    for (const group of model.groups) {
      const z0 = -(group.depth + 1);
      out.push(`<path class="k-halo" d="${k.haloOf(group.box, z0, 1, P)}" style="opacity:calc(var(--tp-halo-opacity) * .5)"/>`);
      out.push(`<g class="tp-zone" data-depth="${group.depth}">${c.S(k.slabOf(group.box, z0, 1, P, 6, 0.6), { tone: "lo", crease: "faint" })}`);
      out.push(c.L(k.planOutline(k.insetPlan(group.box, 4), z0 + 1, P, 5), { tone: "faint", dashed: true }));
      out.push(k.faceTextSvg(k.topMatrix([group.box.x + 8, group.box.y + group.box.d - 6], z0 + 1, P, "x"), String(group.label).toUpperCase(), { size: 6, tone: "mid" }));
      out.push(`</g>`);
    }
  } else {
    const f = flatKit(P);
    for (const group of model.groups) {
      const b = f.box(group.box);
      out.push(`<g class="tp-zone" data-depth="${group.depth}">${f.rect(b, "tp-fzone", 8)}<text class="tp-ft tp-ft-dim" x="${r1(b.x + 8)}" y="${r1(b.y + b.h - 7)}" font-size="7" text-anchor="start">${escape(String(group.label).toUpperCase())}</text></g>`);
    }
  }
  void deepest;

  // Edges on the floor, with a chevron where they arrive.
  const lift = view === "iso" ? 1.5 : 0;
  const pts3 = (list) => list.map(([x, y]) => [x, y, 0]);
  for (const edge of model.edges) {
    const screen = edge.points.map((p) => k.iso([p[0], p[1], 0], P));
    const dashed = edge.kind === "async" || edge.kind === "replication";
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
    void pts3;
    out.push(`<g class="tp-edge" data-edge="${edge.index}" data-kind="${edge.kind}"><path class="tp-edge-bed" d="${k.pathOf(screen)}"/>${k.lineSvg(k.pathOf(screen), { tone: "mid", dashed })}${k.lineSvg(k.pathOf(head.map((p) => k.iso([p[0], p[1], 0], P))), { tone: "mid", free: true })}${edge.sync ? `<circle class="tp-port" cx="${r1(screen[0][0])}" cy="${r1(screen[0][1])}" r="1.4"/>` : ""}</g>`);
  }
  if (view === "iso") {
    const c = isoKit(P);
    for (const node of model.nodes) out.push(`<g class="tp-label" data-label="${escape(node.id)}">${isoLabel(node, c, model)}</g>`);
  } else {
    const f = flatKit(P);
    for (const node of model.nodes) {
      const b = f.box(node.plan);
      out.push(`<g class="tp-label" data-label="${escape(node.id)}">${f.text(b.x + b.w / 2, b.y + b.h + 10, node.label, 8)}</g>`);
    }
  }
  out.push(`<g class="tp-packets" data-packets=""></g>`);

  // Nodes, back to front.
  const order = [...model.nodes].sort((a, b) => k.depthOf([a.cx, a.cy, 0], P) - k.depthOf([b.cx, b.cy, 0], P));
  const iso = view === "iso" ? isoKit(P) : null;
  const flat = view === "flat" ? flatKit(P) : null;
  for (const node of order) {
    const halo = view === "iso" ? `<path class="k-halo" d="${k.haloOf(k.insetPlan(node.plan, 2), 0, Math.min(heightOf(node), 10), P)}"/>` : "";
    const body = view === "iso" ? (ISO[node.kind] || ISO.box)(node, iso) : (FLAT[node.kind] || FLAT.box)(node, flat);
    out.push(`<g class="tp-node" data-node="${escape(node.id)}" data-kind="${node.kind}">${halo}${body}</g>`);
  }

  const svg = k.figureSvg({ width: W, height: H, label: describe(model), body: out, className: `tp-svg tp-${view}` });
  const toScreen = (p, z = 0) => k.iso([p[0], p[1], z], P);
  const data = {
    P,
    edges: model.edges.map((edge) => edge.points.map((p) => toScreen(p, lift)).map(([x, y]) => [r1(x), r1(y)])),
    step: (() => {
      const a = toScreen([0, 0]);
      const b = toScreen([PITCH, 0]);
      return [b[0] - a[0], b[1] - a[1]];
    })(),
    packet: view === "iso" ? isoPacket(P) : null,
  };
  return { svg, data, P, width: W, height: H };
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

const GEOMETRY = new Set(["plan", "cx", "cy", "w", "d", "h", "auto", "at", "labelSpot", "groups", "index", "points", "lens", "corners", "ends", "ports", "channel", "axisOf", "via", "bend", "axis"]);
const strip = (object) => Object.fromEntries(Object.entries(object).filter(([key, value]) => !GEOMETRY.has(key) && value !== undefined));

// What the sim needs: everything in the spec except geometry, plus each edge's length.
export function simSpec(model, features) {
  return {
    nodes: model.nodes.map(strip),
    edges: model.edges.map((edge) => ({ ...strip(edge), len: edge.len })),
    sim: model.sim,
    scenario: model.scenario,
    flags: model.flags,
    features: features || model.features,
  };
}

export const TOPO_CSS = `
.tp-stage{position:relative;outline:none;touch-action:manipulation}
.tp-stage:focus-visible{outline:1px dashed var(--tp-faint);outline-offset:6px}
.tp-svg[hidden]{display:none}
.tp-node{cursor:pointer;transition:opacity .25s var(--tp-ease)}
.tp-edge .k-line{transition:stroke .2s}
.tp-edge-bed{fill:none;stroke:var(--tp-card);stroke-width:3.4px;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.tp-iso .tp-edge-bed{stroke:none}
.tp-port{fill:var(--tp-card);stroke:var(--tp-mid);stroke-width:var(--tp-weight);vector-effect:non-scaling-stroke}
.tp-stage[data-focus] .tp-node:not([data-near]){opacity:.38}
.tp-stage[data-focus] .tp-edge:not([data-near]) .k-line{stroke:var(--tp-faint)}
.tp-stage[data-focus] .tp-edge[data-near] .k-line{stroke:var(--tp-hi)}
.tp-stage[data-focus] .tp-label:not([data-near]) text{fill:var(--tp-lo)}
.tp-label .tp-ft{fill:var(--tp-text)}
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
.tp-pk .pk-top{fill:var(--pk)}
.tp-pk .pk-side{fill:color-mix(in srgb,var(--pk) 55%,var(--tp-card))}
.tp-pk .pk-edge{fill:none;stroke:color-mix(in srgb,var(--pk) 70%,var(--tp-card));stroke-width:.4px;vector-effect:non-scaling-stroke}
.tp-pk circle{fill:var(--pk)}
.tp-views{position:absolute;top:13px;left:50%;transform:translateX(-50%);display:flex;gap:0;z-index:2;font-family:var(--tp-mono);font-size:10px;letter-spacing:.08em}
.tp-views button{all:unset;cursor:pointer;padding:3px 9px;color:var(--tp-muted);box-shadow:0 0 0 1px var(--tp-lo)}
.tp-views button[aria-pressed="true"]{color:var(--tp-strong);box-shadow:0 0 0 1px var(--tp-mid);background:var(--tp-shade-2)}
.tp-views button:focus-visible{outline:1px solid var(--tp-lit)}
`;
