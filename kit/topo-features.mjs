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
  endpoints: true, // routes on services, per-route stats and an endpoint mix on sources
  tables: true, // database tables, writes, the WAL and replica lag
  trace: true, // follow one request end to end
};

const known = (name) => {
  if (!(name in FEATURES)) throw new Error(`unknown feature "${name}" (known: ${Object.keys(FEATURES).join(", ")})`);
  return name;
};

// `list` is "a,-b,+c" or an array of the same; returns the changes it names.
export function parseFeatures(list) {
  const out = {};
  const items = Array.isArray(list) ? list : String(list || "").split(",");
  for (const raw of items) {
    const item = String(raw).trim();
    if (!item) continue;
    const off = item.startsWith("-") || item.startsWith("no-");
    out[known(item.replace(/^[-+]/, "").replace(/^no-/, ""))] = !off;
  }
  return out;
}

export function resolveFeatures(...layers) {
  const out = { ...FEATURES };
  for (const layer of layers) {
    if (!layer) continue;
    const changes = typeof layer === "string" || Array.isArray(layer) ? parseFeatures(layer) : layer;
    for (const [name, value] of Object.entries(changes)) out[known(name)] = value !== false;
  }
  return out;
}

export const describeFeatures = (set) =>
  Object.entries(set)
    .map(([name, on]) => (on ? name : `-${name}`))
    .join(" ");

// The model features own: a disabled feature's fields are removed from the spec once, before
// anything is laid out or simulated, so neither the sim nor the renderer checks features.
export function stripFeatures(spec, set) {
  const out = { ...spec, nodes: spec.nodes.map((node) => ({ ...node })), edges: (spec.edges || []).map((edge) => (Array.isArray(edge) ? edge : { ...edge })) };
  const objects = (list) => list.filter((item) => !Array.isArray(item));
  if (!set.scenario) delete out.scenario;
  if (!set.endpoints) {
    for (const node of objects(out.nodes)) {
      delete node.endpoints;
      // An endpoint mix becomes one total rate (curves keep only their first rate).
      if (node.emit && typeof node.emit === "object" && !Array.isArray(node.emit) && !("every" in node.emit))
        node.emit = Object.values(node.emit).reduce((sum, e) => sum + (typeof e === "number" ? e : Array.isArray(e) ? e[0][1] : 0), 0);
    }
    delete out.records;
  }
  if (!set.tables) objects(out.nodes).forEach((node) => delete node.tables);
  if (!set.queues) objects(out.nodes).forEach((node) => delete node.queue);
  if (!set.breakers) objects(out.edges).forEach((edge) => delete edge.breaker);
  if (!set.flags) {
    delete out.flags;
    objects(out.edges).forEach((edge) => {
      delete edge.flag;
      delete edge.unless;
    });
  }
  if (out.scenario && (!set.queues || !set.breakers || !set.flags)) {
    out.scenario = {
      ...out.scenario,
      steps: (out.scenario.steps || []).map((step) => {
        const next = { ...step };
        if (!set.flags) for (const key of ["flag", "rollout", "kill"]) delete next[key];
        if (next.set) next.set = Object.fromEntries(Object.entries(next.set).map(([id, props]) => [id, Object.fromEntries(Object.entries(props).filter(([key]) => !(key === "queue" && !set.queues) && !(key === "breaker" && !set.breakers)))]));
        return next;
      }),
    };
  }
  return out;
}
