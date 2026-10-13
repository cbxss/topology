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

import { fileURLToPath } from "node:url";
import { modelOf } from "./topo.mjs";

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
export function cacheAside(service, { id = `${service}-cache`, db, hit = 0.8, label = "cache", kind = "cache", at } = {}) {
  if (!["cache", "redis", "elasticache"].includes(kind)) throw new Error("cacheAside: kind must be cache, redis or elasticache");
  if (!db) throw new Error("cacheAside: needs `db`, the id of the database behind the cache");
  return { nodes: [{ id, kind, label, ...place(at, 0, 0) }], edges: [{ from: service, to: id }, { from: service, to: db, p: Math.round((1 - hit) * 1000) / 1000 }], in: service, out: [db] };
}

// A database primary with streaming replicas.
export function replicatedDb(id, { label = id, replicas = 1, at } = {}) {
  const extra = Array.from({ length: replicas }, (_, i) => ({ id: `${id}-replica${replicas > 1 ? `-${i + 1}` : ""}`, kind: "db", role: "replica", label: `${label}-replica${replicas > 1 ? `-${i + 1}` : ""}`, ...place(at, 0, 1.05 * (i + 1)) }));
  return { nodes: [{ id, kind: "db", role: "primary", label, ...place(at, 0, 0) }, ...extra], edges: extra.map((node) => ({ from: id, to: node.id, kind: "replication" })), in: id, out: [id] };
}

// A service over one table: POST upserts, GET selects (from `replica` when given, which is
// the classic read-your-writes trap), DELETE deletes. Pass `routes` to pick or rename.
export function crudService(id, { label = id, table, key = "id", db, replica, routes = ["POST", "GET", "DELETE"], path = `/${table}`, ms = 6, replicas = 2, at } = {}) {
  if (!table || !db) throw new Error("crudService: needs `table` and `db`");
  const endpoints = {};
  if (routes.includes("POST")) endpoints[`POST ${path}`] = { ms, calls: [{ to: db, op: "upsert", table }] };
  if (routes.includes("GET")) endpoints[`GET ${path}/:${key}`] = { ms: Math.max(1, ms / 3), calls: [{ to: replica || db, op: "select", table }] };
  if (routes.includes("DELETE")) endpoints[`DELETE ${path}/:${key}`] = { ms, calls: [{ to: db, op: "delete", table }] };
  const edges = [{ from: id, to: db }];
  if (replica && routes.includes("GET")) edges.push({ from: id, to: replica });
  return { nodes: [{ id, kind: "service", label, replicas, endpoints, ...place(at, 0, 0) }], edges, in: id, out: [db, ...(replica ? [replica] : [])] };
}

// The transactional outbox / change data capture: a connector tails the database's WAL and
// publishes every committed change to a topic, so the write and the event can't disagree.
export function outbox(id, { db, topic, partitions = 3, label = `${id}-cdc`, topicLabel = topic, at } = {}) {
  if (!db || !topic) throw new Error("outbox: needs `db` and `topic`");
  return {
    nodes: [
      { id, kind: "worker", label, replicas: 1, ...place(at, 0, 0) },
      { id: topic, kind: "kafka", partitions, label: topicLabel, ...place(at, 1.2, 0) },
    ],
    edges: [{ from: db, to: id, kind: "replication" }, { from: id, to: topic }],
    in: db,
    out: topic,
  };
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

// A whole spec as a fragment: another figure's system, embedded in this one. Every node, edge,
// group and flag id becomes `<prefix>.<id>`; endpoint routes and table names stay as they are.
// The child's client sources (kind `client` with `emit`) are dropped so the parent drives it
// (`keepSources: true` keeps them), its scenario is dropped (the parent's story can still
// `fail: "<prefix>.<id>"`), and its sim and grid give way to the parent's. With `at`, the
// child keeps its own drawing (its `at`s, else its auto-layout) moved so its corner is there;
// without, everything is left to auto-layout. The system stands on a plate labelled with its
// title. `ports` in the child (`{ in: "api", events: "topic" }`) name what the parent may link
// to; the fragment's `in` is ports.in (default: what the dropped sources called), `out` is
// ports.out, and `id("x")` turns any child id into its embedded one.
//
//   import ledger from "../ledger/ledger.spec.mjs";   // or: await importSpec(new URL(…, import.meta.url))
//   const books = system("books", ledger, { at: [5, 0] });
//   compose(meta, books, link("orders", books.in), link(books.id("shard-3"), "audit"));
export function system(prefix, spec, { at, label = spec.title ?? prefix, keepSources = false, shared = [], plate = true, region = false } = {}) {
  if (!prefix || /[.>:]/.test(prefix)) throw new Error(`system: the prefix must be nonempty, without ".", ">" or ":" (got "${prefix}")`);
  if (!spec || !Array.isArray(spec.nodes)) throw new Error(`system ${prefix}: expected a spec with nodes`);
  const id = (local) => `${prefix}.${local}`;
  const edges = (spec.edges || []).map((edge) => (Array.isArray(edge) ? { from: edge[0], to: edge[1] } : edge));
  const dropped = new Set(keepSources ? [] : spec.nodes.filter((node) => node.kind === "client" && (node.emit != null || node.workload != null)).map((node) => node.id));
  const kept = spec.nodes.filter((node) => !dropped.has(node.id));
  if (!kept.length) throw new Error(`system ${prefix}: nothing is left once its sources are dropped`);

  // Freeze the child's own drawing: its placed nodes, and auto-layout for the rest.
  let spot = new Map();
  if (at) {
    for (const node of modelOf(spec).nodes) spot.set(node.id, node.at || node.auto);
    const keptSpots = kept.map((node) => spot.get(node.id));
    const [c0, r0] = [Math.min(...keptSpots.map((s) => s[0])), Math.min(...keptSpots.map((s) => s[1]))];
    spot = new Map(kept.map((node) => [node.id, [round(at[0] + spot.get(node.id)[0] - c0), round(at[1] + spot.get(node.id)[1] - r0)]]));
  }

  const flagOf = (name) => (name == null || shared.includes(name) ? name : id(name));
  const action = (a) => (a.type === "send" ? { ...a, to: id(a.to) } : a.type === "weighted" ? { ...a, targets: a.targets.map((t) => ({ ...t, to: id(t.to) })) } : a);
  const routing = (r) => ({ ...r, rules: r.rules.map((rule) => ({ ...rule, action: action(rule.action) })), fallback: action(r.fallback) });
  const nodes = kept.map(({ at: _, ...node }) => {
    const out = { ...node, id: id(node.id), label: node.label ?? node.id, ...(at ? { at: spot.get(node.id) } : {}) };
    if (node.routing) out.routing = routing(node.routing);
    if (node.endpoints)
      out.endpoints = Object.fromEntries(Object.entries(node.endpoints).map(([route, endpoint]) =>
        [route, endpoint.calls ? { ...endpoint, calls: endpoint.calls.map((call) => ({ ...call, ...(call.to != null ? { to: id(call.to) } : {}), ...(call.routing ? { routing: routing(call.routing) } : {}) })) } : endpoint]));
    return out;
  });
  const keptEdges = edges.filter((edge) => !dropped.has(edge.from) && !dropped.has(edge.to)).map(({ via: _, ...edge }) => {
    const out = { ...edge, from: id(edge.from), to: id(edge.to) };
    for (const key of ["flag", "unless"]) if (edge[key] != null) out[key] = flagOf(edge[key]);
    return out;
  });

  const groups = (spec.groups || []).filter((group) => group.nodes.some((member) => !dropped.has(member)))
    .map((group) => ({ ...group, id: id(group.id), label: group.label ?? group.id, nodes: group.nodes.filter((member) => !dropped.has(member)).map(id) }));
  if (plate) {
    const inner = new Set((spec.groups || []).flatMap((group) => group.nodes).map(id));
    const top = [...nodes, ...groups].map((member) => member.id).filter((member) => !inner.has(member));
    groups.push({ id: prefix, label, ...(region ? { region: true } : {}), nodes: top, ...(spec.refs ? { refs: spec.refs } : {}), ...(spec.notes ? { notes: spec.notes } : {}) });
  }

  // Source refs (kit/provenance.mjs) follow their sources into the namespace. `self` stays the
  // parent's repo unless the child names its own (importSpec does).
  const ownSources = new Set(Object.keys(spec.sources || {}));
  const moveRef = (ref) => {
    const text = typeof ref === "string" ? ref : ref.ref;
    const source = text.slice(0, text.indexOf(":"));
    if (!ownSources.has(source)) return ref;
    const moved = `${prefix}.${text}`;
    return typeof ref === "string" ? moved : { ...ref, ref: moved };
  };
  for (const item of [...nodes, ...keptEdges, ...groups]) if (item.refs) item.refs = item.refs.map(moveRef);

  const ports = {};
  for (const [name, local] of Object.entries(spec.ports || {})) {
    for (const target of [].concat(local)) if (dropped.has(target) || !spec.nodes.some((node) => node.id === target)) throw new Error(`system ${prefix}: port ${name} names ${target}, which isn't a kept node`);
    ports[name] = Array.isArray(local) ? local.map(id) : id(local);
  }
  const called = [...new Set(edges.filter((edge) => dropped.has(edge.from) && !dropped.has(edge.to)).map((edge) => id(edge.to)))];
  const entry = ports.in ?? (called.length === 1 ? called[0] : called.length ? called : undefined);

  return {
    nodes,
    edges: keptEdges,
    groups,
    flags: Object.fromEntries(Object.entries(spec.flags || {}).map(([name, flag]) => [flagOf(name), flag])),
    records: spec.records,
    sources: spec.sources && Object.fromEntries(Object.entries(spec.sources).map(([name, source]) => [`${prefix}.${name}`, source])),
    traffic: spec.traffic,
    policies: spec.policies,
    per: spec.sim?.per ?? 1,
    in: entry,
    out: ports.out,
    ports,
    id,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

// Load a spec file for system(), with the positions its serve editor saved (<name>.layout.json),
// the way build.mjs does. A plain `import` works too; it just skips the layout file.
// Relative `sources` repos are made absolute, and `self` is pinned to the child's own repo, so
// its source refs still resolve from the figure that embeds it.
export async function importSpec(file) {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  const [{ loadSpec }, { selfRoot }, { dirname, resolve }] = await Promise.all([import("../scripts/page.mjs"), import("../scripts/sources.mjs"), import("node:path")]);
  const spec = await loadSpec(path);
  const base = dirname(resolve(path));
  const relative = (repo) => typeof repo === "string" && /^\.{1,2}(\/|$)/.test(repo);
  const sources = Object.fromEntries(Object.entries(spec.sources || {}).map(([name, source]) => [name, relative(source.repo) ? { ...source, repo: resolve(base, source.repo) } : source]));
  sources.self ??= { repo: selfRoot(base) };
  return { ...spec, sources };
}

// Join fragments (and plain { nodes, edges } objects) into a spec. `meta` carries the rest
// of the spec: title, caption, sim, scenario… Node ids must be unique across fragments, and
// records, traffic classes, policies and sources with one name must agree.
export function compose(meta = {}, ...fragments) {
  const spec = { ...meta, nodes: [...(meta.nodes || [])], edges: [...(meta.edges || [])], groups: [...(meta.groups || [])], flags: { ...(meta.flags || {}) } };
  const MERGED = ["records", "traffic", "policies", "sources"];
  for (const key of MERGED) spec[key] = { ...(meta[key] || {}) };
  const per = meta.sim?.per ?? 1;
  for (const fragment of fragments.flat(Infinity)) {
    if (!fragment) continue;
    spec.nodes.push(...(fragment.nodes || []));
    spec.edges.push(...(fragment.edges || []));
    spec.groups.push(...(fragment.groups || []));
    Object.assign(spec.flags, fragment.flags || {});
    for (const key of MERGED) for (const [name, value] of Object.entries(fragment[key] || {})) {
      if (spec[key][name] && JSON.stringify(spec[key][name]) !== JSON.stringify(value)) throw new Error(`compose: two different ${key} entries are called "${name}"`);
      spec[key][name] = value;
    }
    if (fragment.per != null && fragment.per !== per)
      console.warn(`compose: an embedded system was drawn at sim.per ${fragment.per}, this spec runs at ${per}; its rates and capacities now count ${per} requests per packet`);
  }
  const seen = new Set();
  for (const node of spec.nodes) {
    if (seen.has(node.id)) throw new Error(`compose: two nodes are called "${node.id}"`);
    seen.add(node.id);
  }
  if (!spec.groups.length) delete spec.groups;
  if (!Object.keys(spec.flags).length) delete spec.flags;
  for (const key of MERGED) if (!Object.keys(spec[key]).length) delete spec[key];
  return spec;
}
