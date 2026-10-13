// Stable graph encoding preserves map/set/array order and shared/cyclic references.
// Functions are excluded: their effects are checked by subsequent steps and observations.
export function observeSim(sim) {
  const seen = new Map();
  function encode(value) {
    if (value === undefined) return ['undefined'];
    if (typeof value === 'number' && !Number.isFinite(value)) return [String(value)];
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return ['ref', seen.get(value)];
    const id = seen.size;
    seen.set(value, id);
    if (value instanceof Map) return ['map', id, [...value].map(([k, v]) => [encode(k), encode(v)])];
    if (value instanceof Set) return ['set', id, [...value].map(encode)];
    if (Array.isArray(value)) return ['array', id, value.map(encode)];
    return ['object', id, Object.keys(value).sort().filter(k => typeof value[k] !== 'function').map(k => [k, encode(value[k])])];
  }
  return { state: encode(sim), summary: sim.summary(), nodes: [...sim.nodes.keys()].map(id => ({ id, stats: sim.statsOf(id), tables: sim.tablesOf(id), routes: sim.routesOf(id), latency: sim.latencyOf(id) })) };
}

export function replayCase(createSim, item, checkpoint) {
  const sim = createSim(structuredClone(item.spec));
  let tick = 0;
  for (const target of item.checkpoints) {
    while (sim.time + 1e-9 < target) {
      if (tick === 90) sim.follow();
      if (tick === 600) sim.unfollow();
      if (tick === 720) sim.follow();
      sim.step(item.dt[tick++ % item.dt.length]);
    }
    checkpoint(sim, target);
  }
}
