// Pure conditions and destination selection. Transport owns all delivery semantics.
function fieldOf(msg, field) {
  const path = Array.isArray(field) ? field : field.split(".");
  let value = path[0] === "context" ? msg.context : { endpoint: msg.endpoint, source: msg.origin ?? msg.source, traffic: msg.traffic };
  for (const key of path.slice(1)) {
    if (value == null || typeof value !== "object" || !Object.hasOwn(value, key)) return { exists: false };
    value = value[key];
  }
  return { exists: value !== undefined, value };
}
function matches(condition, msg, policies = {}, observations = []) {
  if (condition.policy) return matches(policies[condition.policy], msg, policies, observations);
  if (condition.all) return condition.all.every(c => matches(c, msg, policies, observations));
  if (condition.any) return condition.any.some(c => matches(c, msg, policies, observations));
  if (condition.not) return !matches(condition.not, msg, policies, observations);
  const { exists, value } = fieldOf(msg, condition.field);
  const op = Object.keys(condition).find(k => k !== "field");
  const expected = condition[op];
  let result = false;
  if (op === "exists") result = exists === expected;
  else if (exists) {
    if (op === "eq") result = value === expected;
    else if (op === "in") result = expected.includes(value);
    else if (Number.isFinite(value)) {
      if (op === "gt") result = value > expected;
      if (op === "gte") result = value >= expected;
      if (op === "lt") result = value < expected;
      if (op === "lte") result = value <= expected;
    }
  }
  observations.push({ field: condition.field, op, expected, exists, value, result });
  return result;
}
function selectRoute(routing, msg, policies, rand) {
  const observations = [];
  const rule = routing.rules.find(rule => matches(rule.when, msg, policies, observations));
  const action = rule ? rule.action : routing.fallback;
  const decision = { rule: rule?.id ?? "fallback", observations, to: null, outcome: "rejected" };
  if (action.type === "send") decision.to = action.to;
  if (action.type === "weighted") {
    let pick = rand() * action.targets.reduce((sum, target) => sum + target.weight, 0);
    decision.to = (action.targets.find(target => (pick -= target.weight) < 0) || action.targets.at(-1)).to;
  }
  if (decision.to) decision.outcome = "selected";
  return decision;
}
export { matches, selectRoute };
