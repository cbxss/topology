import { hashOf } from "./common.mjs";

// The grammar of scenario targets: "a>b" is an edge, "topic:b0" a Kafka broker, else a node.
function targetOf(id, nodeIds) {
  if (id.includes(">")) {
    const [from, to] = id.split(">");
    return { type: "edge", from, to };
  }
  const broker = /^(.*):b(\d+)$/.exec(id);
  if (broker && !(nodeIds && nodeIds.has(id))) return { type: "broker", node: broker[1], broker: +broker[2] };
  return { type: "node", id };
}

// Scenario steps may name a phase instead of a time: { phase: "incident", after: 1.5 }.
function normalizeScenario(scenario) {
  if (!scenario) return null;
  const phases = (scenario.phases || []).map((phase) => ({ ...phase })).sort((a, b) => a.at - b.at);
  const byName = new Map(phases.map((phase) => [phase.name, phase]));
  const steps = (scenario.steps || []).map((step, index) => {
    let at = step.at;
    if (at == null && step.phase != null) {
      const phase = byName.get(step.phase);
      if (!phase) throw new Error(`scenario step ${index}: unknown phase "${step.phase}"`);
      at = phase.at + (step.after || 0);
    }
    if (at == null) throw new Error(`scenario step ${index}: needs \`at\` or \`phase\``);
    return { ...step, at, index };
  });
  steps.sort((a, b) => a.at - b.at || a.index - b.index);
  const last = Math.max(0, ...steps.map((step) => step.at), ...phases.map((phase) => phase.at));
  const length = scenario.length || Math.ceil(last + 8);
  phases.forEach((phase, index) => (phase.end = phases[index + 1]?.at ?? length));
  return { length, loop: scenario.loop !== false, steps, phases };
}

// Scripted controls and feature-flag decisions. Transport owns cancellation/edge state;
// logs own assignments and broker state. These callbacks keep that ownership explicit.
function createScenario(sim, definitions, { resetNode, setEdge, setBroker, rebalance }) {
  const { nodes, logs, flags, rand } = sim;
  for (const [name, flag] of Object.entries(definitions || {})) flags.set(name, { name, rollout: flag.rollout ?? 0, sticky: !!flag.sticky, effective: flag.rollout ?? 0 });
  const flagNode = [...nodes.values()].find((node) => node.kind === "flags");

  const decide = (msg, name) => {
    if (sim.entityState && Object.hasOwn(msg.entityFlags || {}, name)) return msg.entityFlags[name].value;
    const flag = flags.get(name);
    if (!flag) return false;
    if (sim.entityState) {
      msg.entityFlags ??= {};
      const value = flag.sticky ? (hashOf(`${msg.origin ?? msg.source}:${name}`) % 10000) / 10000 < flag.effective : msg.draws?.[name] ?? rand() < flag.effective;
      msg.entityFlags[name] = {value, effective:flag.effective, at:sim.time};
      return value;
    }
    if (flag.sticky) return (hashOf(`${msg.source}:${name}`) % 10000) / 10000 < flag.effective;
    msg.draws ??= {};
    if (msg.draws[name] === undefined) msg.draws[name] = rand() < flag.effective;
    return msg.draws[name];
  };
  function setUp(id, up) {
    const target = targetOf(id, nodes);
    if (target.type === "broker") return setBroker(target.node, target.broker, up);
    const node = nodes.get(id);
    if (!node || node.up === up) return;
    node.up = up;
    node.downSince = up ? null : sim.time;
    if (!up) {
      resetNode(node);
    }
    if (up && node === flagNode) for (const flag of flags.values()) syncFlag(flag);
    sim.events.push({ type: up ? "recover" : "fail", node: id, at: sim.time });
    for (const log of logs.values()) for (const group of log.groups) if (group.members.some((edge) => edge.to === id)) rebalance(log, group, sim.time);
  }

  function syncFlag(flag) {
    if (flagNode && !flagNode.up) return;
    if (flag.effective === flag.rollout) return;
    flag.effective = flag.rollout;
    sim.events.push({ type: "flag", flag: flag.name, rollout: flag.effective, at: sim.time });
  }

  const SETTABLE = new Set(["emit", "rate", "capacity", "burst", "errorRate", "ms", "queue", "detect", "ttl", "route", "health", "sidecarMs", "lag", "locks"]);
  function apply(step) {
    if (step.fail) [].concat(step.fail).forEach((id) => setUp(id, false));
    if (step.recover) [].concat(step.recover).forEach((id) => setUp(id, true));
    if (step.set) {
      for (const [id, props] of Object.entries(step.set)) {
        if (targetOf(id).type === "edge") {
          setEdge(id, props);
          continue;
        }
        const node = nodes.get(id);
        if (!node) throw new Error(`scenario: unknown node "${id}"`);
        for (const [key, value] of Object.entries(props)) {
          if (!SETTABLE.has(key)) throw new Error(`scenario: can't set "${key}" (settable: ${[...SETTABLE].join(", ")})`);
          if (key === "queue") node.queueMax = value;
          else node[key] = value;
          if (key === "emit" && typeof value === "number") node.clock = Math.min(node.clock, 1 / Math.max(value, 0.001));
        }
      }
    }
    for (const [name, rollout] of [[step.flag, step.rollout ?? 1], [step.kill, 0]]) {
      if (!name) continue;
      const flag = flags.get(name);
      if (!flag) throw new Error(`scenario: unknown flag "${name}"`);
      flag.rollout = rollout;
      syncFlag(flag);
    }
  }

  return { apply, setUp, decide };
}

export { targetOf, normalizeScenario, createScenario };
