// Validate the public authoring contract before layout, browser packaging or simulation.
const OPERATIONS = new Set(["select", "insert", "upsert", "update", "delete", "rmw"]);
const fail = (path, message) => { throw new Error(`spec ${path}: ${message}`); };
const object = (value, path) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
};
const name = (value, path) => {
  if (typeof value !== "string" || !value.length) fail(path, "expected a nonempty string");
};
const number = (value, path, min = 0, max = Infinity, integer = false) => {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(path, `expected ${integer ? "an integer" : "a finite number"} in [${min}, ${max}]`);
};
function rate(value, path) {
  if (typeof value === "number") return number(value, path);
  if (!Array.isArray(value) || !value.length) fail(path, "expected a rate or nonempty time/rate curve");
  let last = -1;
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) fail(path, "expected [seconds, rate]");
    number(point[0], path); number(point[1], path);
    if (point[0] <= last) fail(path, "curve times must increase");
    last = point[0];
  }
}
function emit(value, path) {
  if (typeof value === "number" || Array.isArray(value)) return rate(value, path);
  object(value, path);
  if (Object.hasOwn(value, "every")) {
    number(value.every, path + ".every", Number.MIN_VALUE);
    number(value.burst, path + ".burst", 1, Infinity, true);
  } else for (const [route, mix] of Object.entries(value)) { name(route, path); rate(mix, path + "." + route); }
}
function jsonValue(value, path, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(path, "field samples must be finite"); return; }
  if (typeof value !== "object" || seen.has(value)) fail(path, "field samples must be acyclic JSON values");
  seen.add(value);
  for (const child of Object.values(value)) jsonValue(child, path, seen);
  seen.delete(value);
}

export function validateSpec(spec, features = {}, kinds) {
  object(spec, "");
  if (!Array.isArray(spec.nodes) || !spec.nodes.length) fail("nodes", "expected a nonempty array");
  const nodes = new Map();
  for (const node of spec.nodes) {
    object(node, "node"); name(node.id, "node.id");
    if (nodes.has(node.id)) fail(node.id, "duplicate node id");
    if (kinds && !Object.hasOwn(kinds, node.kind)) fail(node.id + ".kind", "unknown kind");
    nodes.set(node.id, node);
    for (const key of ["ms", "lag", "capacity", "queue", "rate", "detect", "ttl", "burst", "sidecarMs"])
      if (node[key] != null) number(node[key], node.id + "." + key);
    for (const key of ["partitions", "brokers", "replicas", "rf", "minIsr"])
      if (node[key] != null) number(node[key], node.id + "." + key, 1, Infinity, true);
    for (const key of ["hit", "errorRate"]) if (node[key] != null) number(node[key], node.id + "." + key, 0, 1);
    if (node.emit != null) emit(node.emit, node.id + ".emit");
    if (node.tables) {
      object(node.tables, node.id + ".tables");
      for (const [table, def] of Object.entries(node.tables)) {
        name(table, node.id + ".tables"); object(def, table);
        if (def.key != null) name(def.key, table + ".key");
        if (def.show != null) number(def.show, table + ".show", 1, 16, true);
      }
    }
  }
  if (spec.edges != null && !Array.isArray(spec.edges)) fail("edges", "expected an array");
  const edges = (spec.edges || []).map(e => Array.isArray(e) ? {from: e[0], to: e[1]} : e);
  for (const edge of edges) {
    object(edge, "edge");
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) fail("edge", `unknown endpoint ${edge.from} → ${edge.to}`);
    for (const key of ["ms", "timeout", "backoff", "rate"]) if (edge[key] != null) number(edge[key], "edge." + key);
    if (edge.p != null) number(edge.p, "edge.p"); // random routing accepts weights > 1
    if (edge.retries != null) number(edge.retries, "edge.retries", 0, Infinity, true);
  }
  const parents = new Map();
  for (const edge of edges.filter(e => e.kind === "replication" && ["db", "dynamodb"].includes(nodes.get(e.from).kind) && ["db", "dynamodb"].includes(nodes.get(e.to).kind))) {
    if (parents.has(edge.to)) fail(edge.to, "a table replica must have one primary");
    parents.set(edge.to, edge.from);
  }
  for (const [child, parent] of parents) {
    if (parents.has(parent)) fail(child, "cascading table replication is unsupported; use direct replicas");
    const declared = nodes.get(child).tables;
    if (declared && JSON.stringify(Object.keys(declared).sort()) !== JSON.stringify(Object.keys(nodes.get(parent).tables || {}).sort()))
      fail(child, "replicas must contain the same tables as their primary");
  }
  for (const [table, def] of Object.entries(spec.records || {})) {
    object(def, "records." + table);
    if (def.key != null) name(def.key, table + ".key");
    if (def.keys != null) number(def.keys, table + ".keys", 1, Infinity, true);
    if (def.start != null) number(def.start, table + ".start", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true);
    if (def.skew != null) number(def.skew, table + ".skew", 0, 1);
    object(def.fields || {}, table + ".fields");
    for (const [field, samples] of Object.entries(def.fields || {})) {
      if (!Array.isArray(samples) || !samples.length) fail(table + "." + field, "expected a nonempty array of field samples");
      if (field === (def.key || "id")) fail(table + "." + field, "key is generated separately; do not duplicate it in fields");
      jsonValue(samples, table + "." + field);
    }
  }
  for (const node of nodes.values()) for (const [route, endpoint] of Object.entries(features.endpoints === false ? {} : node.endpoints || {})) {
    object(endpoint, node.id + "." + route);
    if (endpoint.ms != null) number(endpoint.ms, route + ".ms");
    if (endpoint.calls == null) continue;
    if (!Array.isArray(endpoint.calls)) fail(route + ".calls", "expected an array");
    for (const call of endpoint.calls) {
      object(call, route + ".call");
      if (!edges.some(e => e.from === node.id && e.to === call.to && e.kind !== "config")) fail(route, `missing call edge ${node.id} → ${call.to}`);
      if (call.p != null) number(call.p, route + ".p", 0, 1);
      if (features.tables !== false && (call.op != null || call.table != null)) {
        if (!OPERATIONS.has(call.op)) fail(route + ".op", `unknown operation ${call.op}`);
        const target = nodes.get(call.to);
        const tables = target.tables || nodes.get(parents.get(target.id))?.tables;
        if (!tables || !Object.hasOwn(tables, call.table)) fail(route, `unknown table ${call.table} at ${call.to}`);
        if (parents.has(target.id) && call.op !== "select") fail(route, "write to the primary, not a replica");
      }
    }
  }
  for (const key of ["speed", "window", "length", "per"]) if (spec.sim?.[key] != null) number(spec.sim[key], "sim." + key, Number.MIN_VALUE);
  if (spec.scenario) {
    const phases = new Set((spec.scenario.phases || []).map(p => p.name));
    const targetExists = id => nodes.has(id) || edges.some(e => id === e.from + ">" + e.to) || (() => {
      const match = /^(.*):b(\d+)$/.exec(id);
      return match && +match[2] < (nodes.get(match[1])?.brokers || 0);
    })();
    for (const phase of spec.scenario.phases || []) number(phase.at, "phase.at");
    for (const step of spec.scenario.steps || []) {
      if (step.at == null && !phases.has(step.phase)) fail("step", "expected at or a known phase");
      for (const id of [...[].concat(step.fail || []), ...[].concat(step.recover || []), ...Object.keys(step.set || {})])
        if (!targetExists(id)) fail("scenario", `unknown target ${id}`);
      for (const flag of [step.flag, step.kill]) if (flag && !Object.hasOwn(spec.flags || {}, flag)) fail("scenario", `unknown flag ${flag}`);
      if (step.rollout != null) number(step.rollout, "step.rollout", 0, 1);
      for (const [id, values] of Object.entries(step.set || {})) {
        object(values, "step.set." + id);
        for (const [key, value] of Object.entries(values)) {
          if (key === "emit") emit(value, id + ".emit");
          if (["ms", "lag", "capacity", "burst", "rate", "queue", "detect", "ttl", "sidecarMs", "timeout", "backoff", "retries"].includes(key)) number(value, id + "." + key);
          if (key === "errorRate") number(value, id + "." + key, 0, 1);
        }
      }
      if (step.at != null) number(step.at, "step.at");
      if (step.after != null) number(step.after, "step.after");
    }
    if (spec.scenario.length != null) number(spec.scenario.length, "scenario.length", Number.MIN_VALUE);
  }
}
