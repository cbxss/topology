// Product components share simulation behavior with the generic node vocabulary.
// Keep product identity in the drawing; do not duplicate cache/table engines.
export const COMPONENTS = {
  redis: { base: "cache", h: 11 },
  elasticache: { base: "cache", h: 15 },
  dynamodb: { base: "db", h: 27 },
};
export const baseKind = kind => COMPONENTS[kind]?.base || kind;

// Drawing adapters use the existing kits, so theme, camera, LEDs and morphing stay shared.
export function isoComponent(node, c, k) {
  const { plan } = node;
  const out = [];
  if (node.kind === "dynamodb") {
    out.push(c.S(k.slabOf(plan, 0, node.h, c.P, 2, 0.6), { tone: "mid" }));
    const front = plan.y + plan.d;
    for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
      const x = plan.x + 5 + col * (plan.w - 10) / 3;
      out.push(c.L(c.faceY(x, x + (plan.w - 10) / 3 - 2, front, 5 + row * 9, 11 + row * 9), { tone: "lo" }));
    }
    out.push(c.L(k.planOutline(k.insetPlan(plan, 4), node.h, c.P, 2), { tone: "lo" }));
    if (node.tables || node.hasTables) out.push(`<g class="tp-rows-badge" data-rows="${k.escape(node.id)}">${k.faceTextSvg(k.topMatrix([node.cx, node.cy + 3], node.h, c.P, "x"), "0 rows", { size: 5, tone: "mid", anchor: "middle" })}</g>`);
    out.push(c.led(`${node.id}:0`, [plan.x + plan.w - 4, front, node.h - 3], 1));
  } else {
    const managed = node.kind === "elasticache";
    if (managed) {
      out.push(c.S(k.slabOf(plan, 0, 4, c.P, 3, 0.6), { tone: "mid" }));
      out.push(c.L(k.planOutline(k.insetPlan(plan, 2), 4, c.P, 3), { tone: "lo" }));
    }
    const tile = managed ? k.insetPlan(plan, 6) : plan;
    const floor = managed ? 4 : 0;
    for (let level = 0; level < 3; level++) out.push(c.S(k.slabOf(tile, floor + level * 4, 3, c.P, 3, 0.5), { tone: "mid", crease: "lo" }));
    out.push(c.L(k.planOutline(k.insetPlan(tile, 4), floor + 11, c.P, 2), { tone: "lo" }));
    out.push(c.led(`${node.id}:0`, [plan.x + 5, plan.y + plan.d, managed ? 2 : 1.5], 1));
  }
  return out.join("");
}

export function flatComponent(node, f, k) {
  const b = f.box(node.plan);
  const out = [];
  if (node.kind === "dynamodb") {
    out.push(f.rect(b, "tp-f", 2));
    const gap = b.w * 0.08;
    const cellW = (b.w - gap * 4) / 3;
    const cellH = b.h * 0.19;
    for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++)
      out.push(f.rect({ x: b.x + gap + col * (cellW + gap), y: b.y + b.h * 0.12 + row * (cellH + b.h * 0.07), w: cellW, h: cellH }, "tp-f tp-f-chip", 1));
    if (node.tables || node.hasTables) out.push(`<g class="tp-rows-badge" data-rows="${k.escape(node.id)}">${f.text(b.x + b.w / 2, b.y + b.h * 0.81, "0 rows", 6, "tp-ft tp-ft-dim")}</g>`);
  } else {
    const managed = node.kind === "elasticache";
    if (managed) out.push(f.rect(b, "tp-f", 4));
    const pad = managed ? b.w * 0.12 : 0;
    const inner = { x: b.x + pad, y: b.y + pad, w: b.w - pad * 2, h: b.h - pad * 2 };
    for (let level = 2; level >= 0; level--) out.push(f.rect({ x: inner.x, y: inner.y + level * inner.h * 0.24, w: inner.w, h: inner.h * 0.52 }, "tp-f", 3));
  }
  out.push(f.led(`${node.id}:0`, b.x + b.w - 5, b.y + b.h - 4, 1.3));
  return out.join("");
}
