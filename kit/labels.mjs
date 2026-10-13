// Text that doesn't collide: measuring, wrapping, and choosing where each label goes. Pure
// geometry in plan (floor) coordinates, shared by the renderer and build.mjs --check, so what
// --check reports is what the figure draws. kit/topo.mjs supplies the candidates and obstacles.
//
// A label lies along the plan's x axis or its y axis (iso labels are painted on the floor; 2D
// labels are always along x, since the 2D view is the plan seen from above). Its box comes from
// its lines, size and anchor; the font is monospace, so width is characters × CHAR × size.

export const CHAR = 0.62;            // advance per character, in ems (mono, with letter-spacing)
export const LINE = 1.12;            // line pitch, in ems
const ASCENT = 0.75;
const DESCENT = 0.25;
const SEPARATORS = new Set(["-", "_", ".", "/", ":", " "]);

export const textWidth = (text, size) => [...String(text)].length * CHAR * size;

// At most two lines of at most `max` characters, broken after a separator (a space is dropped),
// choosing the most even break that fits; longer text is cut with "…" and `shortened` is set.
export function wrapLabel(text, max = 18) {
  const s = String(text);
  if (s.length <= max) return { lines: [s], shortened: false };
  const breaks = [];
  for (let i = 1; i < s.length - 1; i++) if (SEPARATORS.has(s[i])) breaks.push(s[i] === " " ? [s.slice(0, i), s.slice(i + 1)] : [s.slice(0, i + 1), s.slice(i + 1)]);
  const fitting = breaks.filter(([a, b]) => a.length <= max && b.length <= max);
  if (fitting.length) return { lines: fitting.reduce((best, pair) => (Math.max(...pair.map((p) => p.length)) < Math.max(...best.map((p) => p.length)) ? pair : best)), shortened: false };
  // Nothing fits on two lines: keep the longest first line that ends at a separator, else cut.
  const first = breaks.filter(([a]) => a.length <= max).at(-1) || [s.slice(0, max), s.slice(max)];
  const rest = first[1].length <= max ? first[1] : first[1].slice(0, max - 1).trimEnd() + "…";
  return { lines: [first[0], rest], shortened: rest !== first[1] };
}

// The label's box in its own frame: u along the text from the anchor, v down from line 1's baseline.
export function localBox(lines, size, anchor = "middle") {
  const w = Math.max(...lines.map((line) => textWidth(line, size)));
  const [u0, u1] = anchor === "start" ? [0, w] : anchor === "end" ? [-w, 0] : [-w / 2, w / 2];
  return { u0, u1, v0: -ASCENT * size, v1: (lines.length - 1) * LINE * size + DESCENT * size };
}

// The plan box of a label at `at`. Along y the text runs toward −y and its lines stack toward +x
// (kit/iso.mjs topMatrix).
export function planBox(at, along, local) {
  return along === "y"
    ? { x0: at[0] + local.v0, x1: at[0] + local.v1, y0: at[1] - local.u1, y1: at[1] - local.u0 }
    : { x0: at[0] + local.u0, x1: at[0] + local.u1, y0: at[1] + local.v0, y1: at[1] + local.v1 };
}

// Where to put the anchor so the box sits as asked: give one of left/right/x (x = centred) and
// one of top/bottom/y.
export function anchorFor(along, local, want) {
  const box = planBox([0, 0], along, local);
  const x = want.left != null ? want.left - box.x0 : want.right != null ? want.right - box.x1 : want.x - (box.x0 + box.x1) / 2;
  const y = want.top != null ? want.top - box.y0 : want.bottom != null ? want.bottom - box.y1 : want.y - (box.y0 + box.y1) / 2;
  return [x, y];
}

// Where line i's baseline is.
export const lineAt = (at, along, size, i) => (along === "y" ? [at[0] + i * LINE * size, at[1]] : [at[0], at[1] + i * LINE * size]);

export const overlap = (a, b, pad = 0) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

// Does segment a→b cross the box?
export function crosses(box, [ax, ay], [bx, by]) {
  if (Math.max(ax, bx) < box.x0 || Math.min(ax, bx) > box.x1 || Math.max(ay, by) < box.y0 || Math.min(ay, by) > box.y1) return false;
  let t0 = 0, t1 = 1;
  const [dx, dy] = [bx - ax, by - ay];
  for (const [p, q] of [[-dx, ax - box.x0], [dx, box.x1 - ax], [-dy, ay - box.y0], [dy, box.y1 - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

export const COST = { hidden: 1000, node: 100, label: 100, outside: 50, ambiguous: 30, line: 10, order: 1 };

// The gap between two boxes (0 when they touch or overlap).
export const gap = (a, b) => Math.max(0, a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);

// Greedy placement, in the order given. Each item: { key, candidates: [{ box, ... }], own: { node,
// edge }, crowdable, lineCost, near }. A node label (`near`: its node's box) also pays for sitting
// as close to another node as to its own, or tight against another label, where a reader could
// take it for the wrong node's. Obstacles: { nodes: [{ id, box }], labels: [{ id, box }], lines: [{ edge, a,
// b }] }. `hidden(candidate)` and `outside(box)` are view-specific. A crowdable item that can only
// land on a node or another label is left out (crowded); anything else takes its cheapest spot.
export function placeLabels(items, { nodes = [], labels = [], lines = [], hidden = () => false, outside = () => false } = {}) {
  const placed = [...labels];
  const results = new Map();
  for (const item of items) {
    let best = null;
    item.candidates.forEach((candidate, order) => {
      const { box } = candidate;
      const blockers = [];
      let cost = order * COST.order;
      if (hidden(candidate, item)) { cost += COST.hidden; blockers.push({ type: "hidden" }); }
      for (const node of nodes) if (node.id !== item.own?.node && overlap(box, node.box, 1)) { cost += COST.node; blockers.push({ type: "node", id: node.id }); }
      for (const label of placed) if (overlap(box, label.box, 1.5)) { cost += COST.label; blockers.push({ type: "label", id: label.id }); }
      for (const line of lines) if (line.edge !== item.own?.edge && crosses(box, line.a, line.b)) {
        cost += item.lineCost ?? COST.line;
        if (!blockers.some((b) => b.type === "line" && b.id === line.edge)) blockers.push({ type: "line", id: line.edge });
      }
      if (outside(box)) { cost += COST.outside; blockers.push({ type: "outside" }); }
      if (item.near) {
        const own = gap(box, item.near) + item.slack;
        const near = nodes.find((node) => node.id !== item.own?.node && gap(box, node.box) < own)
          // Two names stacked tight read as one ("redis pg-primary").
          || placed.find((label) => !label.id.startsWith("g:") && !overlap(box, label.box, 1.5) && gap(box, label.box) < item.slack);
        if (near) { cost += COST.ambiguous; blockers.push({ type: "ambiguous", id: near.id }); }
      }
      if (!best || cost < best.cost) best = { ...candidate, cost, blockers };
      if (best.cost === 0) return;
    });
    const crowded = item.crowdable && best.blockers.some((b) => b.type === "node" || b.type === "label" || b.type === "hidden");
    results.set(item.key, { ...best, crowded });
    if (!crowded) placed.push({ id: item.key, box: best.box });
  }
  return results;
}
