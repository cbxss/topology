import { SIM_DEFAULTS, SERVICE_MS, rngOf, split } from "./common.mjs";
import { createTables } from "./tables.mjs";
import { createLogs } from "./logs.mjs";
import { createScenario, normalizeScenario } from "./scenario.mjs";
import { createTransport, breakerOf } from "./transport.mjs";
import { attachReporting, reportTick } from "./reporting.mjs";

// The model behind every figure: a small, seeded, tick-based simulation of requests moving
// through a system. The page embeds the same modules and draws `sim.packets`;
// `scripts/build.mjs --check` runs the same code in Node and prints what the readout will say.
// Every number a figure shows comes from here.
//
// Time. Sim time is real time for everything the model decides (service time, queue waits,
// timeouts, backoff, breaker windows, rates), except packet travel, which is slowed down so
// people can watch it. Latency is therefore built up in model time rather than measured off
// the clock: a job costs its queue wait plus its service time plus its slowest sync call, and a
// call costs its network round trip (`ms` on the edge, default `sim.net`) plus the callee's job,
// plus any earlier failed attempts and their backoff.

function createSim(spec) {
  // Disabled tool features have already been stripped from the spec (stripFeatures).
  const features = spec.features || {};
  const cfg = { ...SIM_DEFAULTS, ...(spec.sim || {}) };
  const scenario = normalizeScenario(spec.scenario);
  if (scenario) cfg.length = scenario.length;
  const rand = rngOf(cfg.seed);
  const nodes = new Map();
  const edges = spec.edges.map((edge, index) => ({
    ...edge,
    index,
    sent: 0,
    dropped: 0,
    failed: 0,
    fast: 0,
    recent: [],
    recentErrors: [],
    flow: 0,
    errorRate: 0,
    breaker: breakerOf(edge.breaker),
  }));
  for (const node of spec.nodes) {
    nodes.set(node.id, {
      ...node,
      up: node.up !== false,
      downSince: node.up === false ? 0 : null,
      ms: node.ms ?? SERVICE_MS[node.kind] ?? 5,
      queueMax: node.queue || 0,
      out: [],
      into: [],
      rr: 0,
      tokens: 0,
      bucket: node.capacity ? node.capacity * (node.burst ?? 0.25) + 1 : 0,
      handled: 0,
      jobs: new Set(),
      working: [],
      waiting: [],
      clock: rand() / Math.max(typeof node.emit === "number" ? node.emit : 1, 0.001),
      nextBurst: 0,
      flow: 0,
      dropRate: 0,
      errorRate: 0,
      recent: [],
      recentDrops: [],
      recentErrors: [],
      service: [],
      roots: [],
      hist: [],
      replica: 0,
      routes: new Map(),
    });
  }
  for (const edge of edges) {
    nodes.get(edge.from).out.push(edge);
    nodes.get(edge.to).into.push(edge);
  }
  // What each node forwards along, worked out once: data edges, replication edges, and
  // whether any edge is gated by a flag.
  for (const node of nodes.values()) {
    const live = node.out.filter((edge) => edge.kind !== "config");
    node.data = live.filter((edge) => edge.kind !== "replication");
    node.repl = live.filter((edge) => edge.kind === "replication");
    node.gated = live.some((edge) => edge.flag || edge.unless);
    node.answers = node.data.some((edge) => edge.sync);
  }

  // Feature flags in the modelled system. A service evaluates flags locally from the last
  // config it got; while the flag service is down, changes don't reach anyone.
  const flags = new Map();
  const logs = new Map();

  const sim = { cfg, nodes, edges, logs, flags, scenario, features, packets: [], time: 0, events: [], rand, calls: new Set(), timed: new Set(), timers: [], stepIndex: 0, histClock: 0, hist: [] };
  // Factories only initialize state. Callbacks run after transport has been wired.
  let transport;
  const tables = createTables(sim, spec.records || {}, {
    launch: (...args) => transport.launch(...args),
    respond: (...args) => transport.respond(...args),
    begin: (job) => transport.begin(job),
  });
  const logModel = createLogs(sim, {
    launch: (...args) => transport.launch(...args),
    newMsg: (...args) => transport.newMsg(...args),
  });
  const { setBroker, readable, isrOf } = logModel;
  const { apply, setUp, decide } = createScenario(sim, spec.flags || {}, {
    resetNode: (node) => transport.resetNode(node),
    setEdge: (...args) => transport.setEdge(...args),
    setBroker,
    rebalance: logModel.rebalance,
  });
  transport = createTransport(sim, { tables, logModel, decide });

  // --- the tick -------------------------------------------------------------------------------

  function step(dt) {
    sim.time += dt;
    const now = sim.time;
    if (scenario) {
      while (sim.stepIndex < scenario.steps.length && scenario.steps[sim.stepIndex].at <= now) {
        const s = scenario.steps[sim.stepIndex++];
        apply(s);
        sim.events.push({ type: "step", index: s.index, at: now });
      }
    }
    if (sim.timers.length) {
      const [due, later] = split(sim.timers, (timer) => timer.at <= now);
      if (due.length) {
        sim.timers = later;
        due.forEach((timer) => timer.run());
      }
    }
    tables.retryReplication();
    transport.tickNodes(dt);
    transport.tickTimeouts();
    logModel.pull(dt);
    transport.tickPackets(dt);
    reportTick(sim, dt);
    if (sim.events.length > 512) sim.events.splice(0, sim.events.length - 512);
  }

  const totalIn = () => [...nodes.values()].reduce((sum, node) => sum + (node.emit && node.up ? node.flow : 0), 0);

  sim.step = (dt) => {
    // Sub-step so a long frame doesn't teleport packets past their arrival.
    const n = Math.max(1, Math.ceil(dt / (1 / 60)));
    for (let i = 0; i < n; i++) step(dt / n);
  };
  // Follow one request: the next one started on `endpoint` (any, if omitted). Its spans fill
  // sim.tracing.spans as it moves; sim.tracing.done once its root answers.
  sim.follow = (endpoint) => (sim.tracing = { endpoint: endpoint || null, msgId: null, spans: [], done: false, started: null });
  sim.unfollow = () => (sim.tracing = null);
  sim.tracedId = (packet) => (packet.msg || packet.call?.job.msg)?.id;
  sim.setUp = setUp;
  sim.setBroker = setBroker;
  sim.readable = readable;
  sim.isrOf = isrOf;
  sim.apply = apply;
  sim.totalIn = totalIn;
  sim.lagOf = logModel.lagOf;
  attachReporting(sim);
  return sim;
}

export { createSim };
