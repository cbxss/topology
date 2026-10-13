// Feature toggles for the tool itself. A disabled feature emits no markup and no inlined
// code, and the sim ignores the spec fields it owns, so turning one off gives the figure
// as it was before that feature existed.
//
// Resolution, last wins: defaults < spec.features < CLI (--features a,-b / --no-a) < URL (?features=-a).

export const FEATURES = {
  scenario: true, // the timeline, narration and named phases
  labels: true, // live rate labels on edges
  trails: true, // short tails behind packets when traffic is dense
  morph: true, // animated camera move between iso and 2D
  sparkline: true, // flow history beside the readout
  hops: true, // little bridges where edges cross
  breakers: true, // circuit breakers on edges
  queues: true, // buffered arrivals at capacity (off: arrivals over capacity drop)
  flags: true, // feature flags and rollouts as part of the modelled system
  edit: true, // drag-to-arrange in serve mode
};

// `list` is "a,-b,+c" or an array of the same; returns the changes it names.
export function parseFeatures(list) {
  const out = {};
  const items = Array.isArray(list) ? list : String(list || "").split(",");
  for (const raw of items) {
    const item = String(raw).trim();
    if (!item) continue;
    const off = item.startsWith("-") || item.startsWith("no-");
    const name = item.replace(/^[-+]/, "").replace(/^no-/, "");
    if (!(name in FEATURES)) throw new Error(`unknown feature "${name}" (known: ${Object.keys(FEATURES).join(", ")})`);
    out[name] = !off;
  }
  return out;
}

export function resolveFeatures(...layers) {
  const out = { ...FEATURES };
  for (const layer of layers) {
    if (!layer) continue;
    const changes = typeof layer === "string" || Array.isArray(layer) ? parseFeatures(layer) : layer;
    for (const [name, value] of Object.entries(changes)) {
      if (!(name in FEATURES)) throw new Error(`unknown feature "${name}" (known: ${Object.keys(FEATURES).join(", ")})`);
      out[name] = value !== false;
    }
  }
  return out;
}

export const describeFeatures = (set) =>
  Object.entries(set)
    .map(([name, on]) => (on ? name : `-${name}`))
    .join(" ");
