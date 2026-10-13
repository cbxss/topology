// Reusable pieces for specs. Each pattern returns a fragment, { nodes, edges, groups, flags,
// in, out }: `in` is the node to send traffic into, `out` the node(s) it hands on from.
// compose() joins fragments into a spec, and link() wires one fragment to another.
//
//   import { compose, link, region, kafkaTopic } from "../../kit/patterns.mjs";
//   const us = region("us", { label: "us-east-1", cache: { hit: 0.85 }, replica: true });
//   const orders = kafkaTopic("orders", { partitions: 6, groups: { billing: { consumers: 2, rate: 8 } } });
//   export default compose({ title: "Checkout" }, client, us, orders, link("users", us.in), link(us.out, orders.in));
//
// Positions: pass `at: [col, row]` to a pattern to place it (its nodes sit at fixed offsets
// from there); leave it out everywhere to let auto-layout place everything.

const place = (at, dc, dr) => (at ? { at: [at[0] + dc, at[1] + dr] } : {});
const spread = (count, gap = 0.8) => Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * gap);

// One edge, or a list of edges from one id to several (or several to one).
export function link(from, to, options = {}) {
  const edges = [];
  for (const a of [].concat(from)) for (const b of [].concat(to)) edges.push({ from: a, to: b, ...options });
  return { edges };
}

// A Kafka topic and its consumer groups: { group: { consumers, rate, label } }.
export function kafkaTopic(id, { label = id, partitions = 3, brokers, rf, minIsr, acks, skew, election, groups = { default: { consumers: 1, rate: 40 } }, at } = {}) {
  const topic = { id, kind: "kafka", label, partitions, ...place(at, 0, 0) };
  for (const [key, value] of Object.entries({ brokers, rf, minIsr, acks, skew, election })) if (value !== undefined) topic[key] = value;
  const consumers = [];
  for (const [group, { consumers: count = 1, rate = 40, label: name = group, kind = "worker" } = {}] of Object.entries(groups))
    for (let i = 0; i < count; i++) consumers.push({ group, node: { id: `${id}-${group}${count > 1 ? `-${i + 1}` : ""}`, kind, rate, label: count > 1 ? `${name}-${i + 1}` : name } });
  const rows = spread(consumers.length);
  consumers.forEach((c, i) => Object.assign(c.node, place(at, 1.15, rows[i])));
  return {
    nodes: [topic, ...consumers.map((c) => c.node)],
    edges: consumers.map((c) => ({ from: id, to: c.node.id, group: c.group })),
    in: id,
    out: consumers.map((c) => c.node.id),
  };
}

// A queue (competing consumers) and its workers.
export function queueWorkers(id, { label = id, workers = 2, rate = 20, worker = "worker", at } = {}) {
  const rows = spread(workers);
  const nodes = Array.from({ length: workers }, (_, i) => ({ id: `${id}-${worker}-${i + 1}`, kind: "worker", rate, label: `${worker}-${i + 1}`, ...place(at, 1.15, rows[i]) }));
  return { nodes: [{ id, kind: "queue", label, ...place(at, 0, 0) }, ...nodes], edges: nodes.map((node) => ({ from: id, to: node.id })), in: id, out: nodes.map((node) => node.id) };
}

// A service reading through a cache: every request checks the cache, misses (1 − hit) go to db.
export function cacheAside(service, { id = `${service}-cache`, db, hit = 0.8, label = "cache", at } = {}) {
  if (!db) throw new Error("cacheAside: needs `db`, the id of the database behind the cache");
  return { nodes: [{ id, kind: "cache", label, ...place(at, 0, 0) }], edges: [{ from: service, to: id }, { from: service, to: db, p: Math.round((1 - hit) * 1000) / 1000 }], in: service, out: [db] };
}

// A database primary with streaming replicas.
export function replicatedDb(id, { label = id, replicas = 1, at } = {}) {
  const extra = Array.from({ length: replicas }, (_, i) => ({ id: `${id}-replica${replicas > 1 ? `-${i + 1}` : ""}`, kind: "db", role: "replica", label: `${label}-replica${replicas > 1 ? `-${i + 1}` : ""}`, ...place(at, 0, 1.05 * (i + 1)) }));
  return { nodes: [{ id, kind: "db", role: "primary", label, ...place(at, 0, 0) }, ...extra], edges: extra.map((node) => ({ from: id, to: node.id, kind: "replication" })), in: id, out: [id] };
}

// A region: load balancer → API → database (optionally a cache in front and a replica
// behind), on a region plate. `in` is the load balancer, `out` the API.
export function region(id, { label = id, api = {}, db = {}, cache = false, replica = false, at } = {}) {
  const lb = { id: `${id}-lb`, kind: "lb", label: `${id}-lb`, ...place(at, 0, 0) };
  const service = { id: `${id}-api`, kind: "service", replicas: 2, label: `${id}-api`, ...api, ...place(at, 1, 0) };
  const primary = { id: `${id}-db`, kind: "db", role: "primary", label: `${id}-db`, ...db, ...place(at, 2.1, cache ? 0.55 : 0) };
  const nodes = [lb, service, primary];
  const edges = [{ from: lb.id, to: service.id }];
  if (cache) {
    const hit = cache.hit ?? 0.8;
    nodes.push({ id: `${id}-cache`, kind: "cache", label: cache.label ?? `${id}-cache`, ...place(at, 2.1, -0.55) });
    edges.push({ from: service.id, to: `${id}-cache` }, { from: service.id, to: primary.id, p: Math.round((1 - hit) * 1000) / 1000 });
  } else edges.push({ from: service.id, to: primary.id });
  if (replica) {
    nodes.push({ id: `${id}-replica`, kind: "db", role: "replica", label: (replica.label ?? `${id}-replica`), ...place(at, 2.1, cache ? 1.6 : 1.05) });
    edges.push({ from: primary.id, to: `${id}-replica`, kind: "replication", ...(replica.ms ? { ms: replica.ms } : {}) });
  }
  return { nodes, edges, groups: [{ id, label, region: true, nodes: nodes.map((node) => node.id) }], in: lb.id, out: service.id };
}

// A canary behind a feature flag: `router` sends the flag's share to v2 and the rest to v1,
// and a flag service pushes config to the router. `out` is [v1, v2].
export function canary(id, { router, flag = id, rollout = 0, v1 = {}, v2 = {}, flags = true, at } = {}) {
  if (!router) throw new Error("canary: needs `router`, the id of the node that splits traffic");
  const a = { id: `${id}-v1`, kind: "service", replicas: 2, label: `${id}-v1`, ...v1, ...place(at, 0, -0.5) };
  const b = { id: `${id}-v2`, kind: "service", replicas: 1, label: `${id}-v2`, ...v2, ...place(at, 0, 0.5) };
  const nodes = [a, b];
  const edges = [{ from: router, to: a.id, unless: flag }, { from: router, to: b.id, flag }];
  if (flags) {
    nodes.push({ id: `${id}-flags`, kind: "flags", label: "flags", ...place(at, -1, -1.2) });
    edges.push({ from: `${id}-flags`, to: router, kind: "config" });
  }
  return { nodes, edges, flags: { [flag]: { rollout } }, in: router, out: [a.id, b.id] };
}

// Join fragments (and plain { nodes, edges } objects) into a spec. `meta` carries the rest
// of the spec: title, caption, sim, scenario… Node ids must be unique across fragments.
export function compose(meta = {}, ...fragments) {
  const spec = { ...meta, nodes: [...(meta.nodes || [])], edges: [...(meta.edges || [])], groups: [...(meta.groups || [])], flags: { ...(meta.flags || {}) } };
  for (const fragment of fragments.flat(Infinity)) {
    if (!fragment) continue;
    spec.nodes.push(...(fragment.nodes || []));
    spec.edges.push(...(fragment.edges || []));
    spec.groups.push(...(fragment.groups || []));
    Object.assign(spec.flags, fragment.flags || {});
  }
  const seen = new Set();
  for (const node of spec.nodes) {
    if (seen.has(node.id)) throw new Error(`compose: two nodes are called "${node.id}"`);
    seen.add(node.id);
  }
  if (!spec.groups.length) delete spec.groups;
  if (!Object.keys(spec.flags).length) delete spec.flags;
  return spec;
}
