// Public schema checks for opt-in request context and routing.
export function validateRouting(spec) {
  const fail = (path, text) => { throw new Error(`spec ${path}: ${text}`); };
  const object = (x, path) => { if (!x || typeof x !== "object" || Array.isArray(x)) fail(path, "expected an object"); };
  const exact = (x, keys, path) => { object(x, path); for (const key of Object.keys(x)) if (!keys.includes(key)) fail(path, `unknown field ${key}`); };
  const text = (x, path) => { if (typeof x !== "string" || !x.length) fail(path, "expected a nonempty string"); };
  const scalar = x => x === null || typeof x === "string" || typeof x === "boolean" || Number.isFinite(x);
  function json(x, path, seen = new Set()) {
    if (scalar(x)) return;
    if (!x || typeof x !== "object" || seen.has(x) || (!Array.isArray(x) && ![Object.prototype, null].includes(Object.getPrototypeOf(x)))) fail(path, "expected acyclic JSON data");
    seen.add(x); for (const child of Object.values(x)) json(child, path, seen); seen.delete(x);
  }
  const palette = ["cyan", "blue", "violet", "magenta", "teal", "lime"];
  object(spec.traffic || {}, "traffic");
  for (const [id, def] of Object.entries(spec.traffic || {})) {
    text(id, "traffic"); exact(def, ["label", "color", "context"], `traffic.${id}`);
    if (def.label != null) text(def.label, `traffic.${id}.label`);
    if (def.color != null && !palette.includes(def.color)) fail(`traffic.${id}.color`, `expected ${palette.join(", ")}`);
    if (def.context != null) { object(def.context, `traffic.${id}.context`); json(def.context, `traffic.${id}.context`); }
  }
  if (spec.colorBy != null && !["activity", "traffic", "none"].includes(spec.colorBy)) fail("colorBy", "expected activity, traffic or none");
  const policies = spec.policies || {};
  object(policies, "policies");
  function condition(c, path, stack = []) {
    object(c, path);
    if (Object.hasOwn(c, "policy")) {
      exact(c, ["policy"], path); text(c.policy, path);
      if (!Object.hasOwn(policies, c.policy)) fail(path, `unknown policy ${c.policy}`);
      if (stack.includes(c.policy)) fail(path, "cyclic policy reference");
      return condition(policies[c.policy], path, [...stack, c.policy]);
    }
    for (const group of ["all", "any", "not"]) if (Object.hasOwn(c, group)) {
      exact(c, [group], path);
      if (group === "not") return condition(c.not, path, stack);
      if (!Array.isArray(c[group]) || !c[group].length) fail(path, "expected nonempty condition list");
      return c[group].forEach(child => condition(child, path, stack));
    }
    const ops = Object.keys(c).filter(k => k !== "field");
    if (ops.length !== 1 || !["eq", "in", "exists", "gt", "gte", "lt", "lte"].includes(ops[0])) fail(path, "expected one supported comparison");
    const parts = Array.isArray(c.field) ? c.field : typeof c.field === "string" ? c.field.split(".") : [];
    if (parts.length < 2 || parts.some(p => typeof p !== "string" || !p.length || ["__proto__", "prototype", "constructor"].includes(p)) || !["context", "request"].includes(parts[0])) fail(path, "invalid field path");
    if (parts[0] === "request" && (parts.length !== 2 || !["endpoint", "source", "traffic"].includes(parts[1]))) fail(path, "unknown request field");
    const op = ops[0], value = c[op];
    if (op === "exists" ? typeof value !== "boolean" : op === "in" ? !Array.isArray(value) || !value.length || !value.every(scalar) : op === "eq" ? !scalar(value) : !Number.isFinite(value)) fail(path, `invalid ${op} operand`);
  }
  for (const [id, c] of Object.entries(policies)) condition(c, `policies.${id}`, [id]);
  const edges = (spec.edges || []).map(e => Array.isArray(e) ? {from: e[0], to: e[1]} : e);
  function routing(r, node, path) {
    exact(r, ["rules", "fallback"], path);
    if (!Array.isArray(r.rules)) fail(path, "expected rules array");
    const ids = new Set();
    function action(a) {
      object(a, path);
      let targets;
      if (a.type === "reject") { exact(a, ["type"], path); return; }
      if (a.type === "send") { exact(a, ["type", "to"], path); targets = [a.to]; }
      else if (a.type === "weighted") {
        exact(a, ["type", "targets"], path);
        if (!Array.isArray(a.targets) || !a.targets.length) fail(path, "expected weighted targets");
        for (const t of a.targets) { exact(t, ["to", "weight"], path); if (!Number.isFinite(t.weight) || t.weight <= 0) fail(path, "weight must be positive and finite"); }
        if (!Number.isFinite(a.targets.reduce((s, t) => s + t.weight, 0))) fail(path, "weight total must be finite");
        targets = a.targets.map(t => t.to);
      } else fail(path, "unknown action type");
      if (new Set(targets).size !== targets.length) fail(path, "duplicate destination");
      for (const to of targets) {
        text(to, path);
        const links = edges.filter(e => e.from === node.id && e.to === to && !["config", "replication"].includes(e.kind));
        if (links.length !== 1) fail(path, `expected one data edge ${node.id} → ${to}`);
      }
    }
    for (const rule of r.rules) {
      exact(rule, ["id", "when", "action"], path); text(rule.id, path);
      if (rule.id === "fallback" || ids.has(rule.id)) fail(path, "rule id must be unique and not fallback");
      ids.add(rule.id); condition(rule.when, path); action(rule.action);
    }
    action(r.fallback);
  }
  for (const node of spec.nodes || []) {
    if (node.workload != null) {
      if (node.emit != null) fail(node.id, "workload and emit are mutually exclusive");
      if (!Array.isArray(node.workload) || !node.workload.length) fail(node.id, "expected nonempty workload");
      for (const w of node.workload) {
        exact(w, ["traffic", "endpoint", "rate", "context"], node.id + ".workload");
        if (w.traffic != null && !Object.hasOwn(spec.traffic || {}, w.traffic)) fail(node.id, `unknown traffic class ${w.traffic}`);
        if (w.endpoint != null) text(w.endpoint, node.id);
        if (w.context != null) { object(w.context, node.id); json(w.context, node.id); }
        if (!Array.isArray(w.rate) && (!Number.isFinite(w.rate) || w.rate < 0)) fail(node.id, "invalid workload rate");
        if (Array.isArray(w.rate)) {
          let last = -1;
          if (!w.rate.length) fail(node.id, "empty rate curve");
          for (const pair of w.rate) {
            if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite) || pair[0] <= last || pair[0] < 0 || pair[1] < 0) fail(node.id, "invalid workload curve");
            last = pair[0];
          }
        }
      }
    }
    if (Object.hasOwn(node, "routing")) {
      if (["kafka", "queue"].includes(node.kind)) fail(node.id, "consumer assignment controls log routing; put rules on the consumer");
      routing(node.routing, node, node.id + ".routing");
    }
    for (const [name, endpoint] of Object.entries(node.endpoints || {})) {
      object(endpoint, name);
      if (endpoint.calls != null && !Array.isArray(endpoint.calls)) fail(name, "calls must be an array");
      for (const call of endpoint.calls || []) {
      object(call, name + ".call");
      if (Object.hasOwn(call, "when")) condition(call.when, name + ".when");
      if (Object.hasOwn(call, "routing")) {
        if (call.to != null) fail(name, "call cannot contain both to and routing");
        routing(call.routing, node, name + ".routing");
      }
      }
    }
  }
}
