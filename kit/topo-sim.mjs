// The model behind every figure: a small, seeded, tick-based simulation of messages moving
// through a system. The page inlines this file (exports stripped) and draws `sim.packets`;
// `scripts/build.mjs --check` runs the same code in Node and prints what the readout will say.
// Every number a figure shows comes from here.

export const SIM_DEFAULTS = { speed: 150, latency: 0.03, per: 1, rebalance: 0.9, window: 2, seed: 7 };

export function rngOf(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export const isLog = (node) => node.kind === "kafka" || node.kind === "queue";
export const routeOf = (node) => node.route || (node.kind === "lb" || node.kind === "gateway" ? "roundrobin" : "all");

// spec: the normalised spec from topo.mjs (nodes with ids, edges with `len` world units).
export function createSim(spec) {
  const cfg = { ...SIM_DEFAULTS, ...(spec.sim || {}) };
  const rand = rngOf(cfg.seed);
  const nodes = new Map();
  const edges = spec.edges.map((edge, index) => ({ ...edge, index, sent: 0, dropped: 0 }));
  for (const node of spec.nodes) {
    nodes.set(node.id, {
      ...node,
      up: node.up !== false,
      out: [],
      into: [],
      rr: 0,
      tokens: 0,
      bucket: node.capacity ? node.capacity : 0,
      handled: 0,
      dropped: 0,
      errors: 0,
      clock: rand() / Math.max(node.emit || 1, 0.001),
      busy: [],
      flow: 0,
      dropRate: 0,
      recent: [],
      recentDrops: [],
      replica: 0,
    });
  }
  for (const edge of edges) {
    nodes.get(edge.from).out.push(edge);
    nodes.get(edge.to).into.push(edge);
  }

  // Logs: kafka topics (partitions, consumer groups with exclusive assignment) and queues
  // (one lane, competing consumers).
  const logs = new Map();
  for (const node of nodes.values()) {
    if (!isLog(node)) continue;
    const partitions = node.kind === "queue" ? 1 : node.partitions || 3;
    const groups = new Map();
    for (const edge of node.out) {
      const name = node.kind === "queue" ? "queue" : edge.group || "default";
      if (!groups.has(name)) groups.set(name, { name, members: [], committed: Array(partitions).fill(0), assign: new Map(), pause: 0, generation: 0 });
      groups.get(name).members.push(edge);
    }
    logs.set(node.id, { node, partitions, end: Array(partitions).fill(0), rr: 0, groups: [...groups.values()], appended: 0 });
  }

  const sim = { cfg, nodes, edges, logs, packets: [], time: 0, events: [], rand };

  function rebalance(log, group, now) {
    const live = group.members.filter((edge) => nodes.get(edge.to).up);
    group.assign = new Map();
    if (log.node.kind === "queue") {
      for (const edge of live) group.assign.set(edge.index, [0]);
    } else {
      live.forEach((edge) => group.assign.set(edge.index, []));
      for (let p = 0; p < log.partitions; p++) if (live.length) group.assign.get(live[p % live.length].index).push(p);
      group.generation++;
      if (now > 0) group.pause = cfg.rebalance;
    }
    sim.events.push({ type: "rebalance", log: log.node.id, group: group.name, at: now });
  }
  for (const log of logs.values()) for (const group of log.groups) rebalance(log, group, 0);

  const launch = (edge, kind, extra = {}) => {
    edge.sent++;
    sim.packets.push({ edge: edge.index, t: 0, dir: kind === "response" ? -1 : 1, kind, duration: Math.max(edge.len / cfg.speed, 0.08), ...extra });
  };

  function forward(node) {
    if (isLog(node)) return;
    const data = node.out.filter((edge) => edge.kind !== "replication");
    const repl = node.out.filter((edge) => edge.kind === "replication");
    for (const edge of repl) launch(edge, "replication");
    if (!data.length) return;
    const mode = routeOf(node);
    if (mode === "roundrobin") {
      // Skip targets that are down when health checks are on (the default).
      for (let tries = 0; tries < data.length; tries++) {
        const edge = data[node.rr++ % data.length];
        if (nodes.get(edge.to).up || node.health === false) return launch(edge, "request");
      }
      node.errors++;
      return;
    }
    if (mode === "random") {
      const total = data.reduce((sum, edge) => sum + (edge.p ?? 1), 0);
      let pick = rand() * total;
      for (const edge of data) if ((pick -= edge.p ?? 1) <= 0) return launch(edge, "request");
      return launch(data[data.length - 1], "request");
    }
    for (const edge of data) if (rand() < (edge.p ?? 1)) launch(edge, "request");
  }

  function admit(node) {
    if (!node.capacity) return true;
    if (node.bucket >= 1) {
      node.bucket -= 1;
      return true;
    }
    return false;
  }

  function arrive(packet) {
    const edge = edges[packet.edge];
    if (packet.kind === "response") return;
    const node = nodes.get(edge.to);
    if (!node.up || !admit(node)) {
      node.dropped++;
      node.recentDrops.push(sim.time);
      edges[packet.edge].dropped++;
      sim.packets.push({ ...packet, t: 1, kind: "drop", age: 0 });
      return;
    }
    node.handled++;
    node.recent.push(sim.time);
    node.replica = (node.replica + 1) % Math.max(1, node.replicas || 1);
    sim.events.push({ type: "handle", node: node.id, replica: node.replica, at: sim.time, kind: packet.kind });
    if (isLog(node)) {
      const log = logs.get(node.id);
      const p = packet.partition ?? (edge.key != null ? hashOf(String(edge.key)) % log.partitions : log.rr++ % log.partitions);
      log.end[p]++;
      log.appended++;
      return;
    }
    node.busy.push({ at: sim.time + (node.latency ?? cfg.latency), edge: packet.edge, sync: edge.sync && packet.kind === "request" });
  }

  function step(dt) {
    sim.time += dt;
    const now = sim.time;
    // Sources emit with a little jitter so packets don't march in lockstep.
    for (const node of nodes.values()) {
      if (node.capacity) node.bucket = Math.min(node.capacity * (node.burst ?? 0.25) + 1, node.bucket + node.capacity * dt);
      if (!node.emit || !node.up) continue;
      node.clock -= dt;
      while (node.clock <= 0) {
        node.clock += (0.6 + rand() * 0.8) / node.emit;
        node.handled++;
        node.recent.push(now);
        sim.events.push({ type: "handle", node: node.id, replica: 0, at: now, kind: "emit" });
        forward(node);
      }
    }
    // Finished work forwards downstream, and a sync call answers back.
    for (const node of nodes.values()) {
      if (!node.busy.length) continue;
      const done = node.busy.filter((job) => job.at <= now);
      node.busy = node.busy.filter((job) => job.at > now);
      for (const job of done) {
        if (job.sync) launch(edges[job.edge], "response");
        if (node.up) forward(node);
      }
    }
    // Consumers pull from logs at their own rate.
    for (const log of logs.values()) {
      for (const group of log.groups) {
        if (group.pause > 0) {
          group.pause = Math.max(0, group.pause - dt);
          continue;
        }
        for (const edge of group.members) {
          const consumer = nodes.get(edge.to);
          if (!consumer.up) continue;
          const parts = group.assign.get(edge.index) || [];
          const rate = edge.rate ?? consumer.rate ?? 40;
          consumer.tokens = Math.min(consumer.tokens + rate * dt, 3);
          while (consumer.tokens >= 1) {
            let best = -1;
            let most = 0;
            for (const p of parts) {
              const lag = log.end[p] - group.committed[p];
              if (lag > most) {
                most = lag;
                best = p;
              }
            }
            if (best < 0) {
              consumer.tokens = Math.min(consumer.tokens, 1);
              break;
            }
            consumer.tokens -= 1;
            group.committed[best]++;
            launch(edge, "record", { partition: best, group: group.name });
          }
        }
      }
    }
    // Move packets; a packet arriving hands off to the next node.
    const live = [];
    const moving = sim.packets;
    sim.packets = [];
    for (const packet of moving) {
      if (packet.kind === "drop") {
        packet.age += dt;
        if (packet.age < 0.6) live.push(packet);
        continue;
      }
      packet.t += dt / packet.duration;
      if (packet.t >= 1) arrive(packet);
      else live.push(packet);
    }
    sim.packets = live.concat(sim.packets);
    for (const node of nodes.values()) {
      while (node.recent.length && node.recent[0] < now - cfg.window) node.recent.shift();
      while (node.recentDrops.length && node.recentDrops[0] < now - cfg.window) node.recentDrops.shift();
      node.flow = node.recent.length / Math.min(cfg.window, Math.max(now, 0.25));
      node.dropRate = node.recentDrops.length / Math.min(cfg.window, Math.max(now, 0.25));
    }
    if (sim.events.length > 256) sim.events.splice(0, sim.events.length - 256);
  }

  function setUp(id, up) {
    const node = nodes.get(id);
    if (!node || node.up === up) return;
    node.up = up;
    if (!up) node.busy = [];
    sim.events.push({ type: up ? "recover" : "fail", node: id, at: sim.time });
    for (const log of logs.values()) for (const group of log.groups) if (group.members.some((edge) => edge.to === id)) rebalance(log, group, sim.time);
  }

  sim.step = (dt) => {
    // Sub-step so a long frame doesn't teleport packets past their arrival.
    const n = Math.max(1, Math.ceil(dt / (1 / 60)));
    for (let i = 0; i < n; i++) step(dt / n);
  };
  sim.setUp = setUp;
  sim.lagOf = (id, groupName) => {
    const log = logs.get(id);
    if (!log) return 0;
    const group = groupName ? log.groups.find((g) => g.name === groupName) : log.groups[0];
    if (!group) return log.end.reduce((a, b) => a + b, 0);
    return log.end.reduce((sum, end, p) => sum + end - group.committed[p], 0);
  };
  sim.statsOf = (id) => statsOf(sim, id);
  sim.summary = () => summaryOf(sim);
  return sim;
}

export function hashOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(0) : n.toFixed(1));
export const formatRate = (n, per = 1) => `${fmt(n * per)}/s`;
export const formatCount = (n, per = 1) => fmt(n * per).replace(/\.0$/, "");

export function statsOf(sim, id) {
  const node = sim.nodes.get(id);
  if (!node) return "";
  const per = sim.cfg.per;
  const name = node.label || node.id;
  if (!node.up) return `${name} · down${node.dropRate ? ` · ${formatRate(node.dropRate, per)} lost` : ""}`;
  const log = sim.logs.get(id);
  if (log) {
    const parts = log.groups.map((group) => {
      const lag = log.end.reduce((sum, end, p) => sum + end - group.committed[p], 0);
      const live = [...group.assign.values()].filter((list) => list.length).length;
      return `${log.groups.length > 1 ? group.name + " " : ""}lag ${formatCount(lag, per)}${group.pause > 0 ? " · rebalancing" : node.kind === "kafka" ? ` · ${live}/${group.members.length} consumers` : ""}`;
    });
    return `${name} · in ${formatRate(node.flow, per)} · ${parts.join(" · ")}`;
  }
  const bits = [`${name} · ${formatRate(node.flow, per)}`];
  if (node.capacity) bits.push(`cap ${formatRate(node.capacity, per)}`);
  if (node.dropRate) bits.push(`${formatRate(node.dropRate, per)} rejected`);
  return bits.join(" · ");
}

export function summaryOf(sim) {
  const per = sim.cfg.per;
  let sources = 0;
  let drops = 0;
  let lag = 0;
  for (const node of sim.nodes.values()) {
    if (node.emit && node.up) sources += node.flow;
    drops += node.dropRate;
  }
  for (const id of sim.logs.keys()) lag += sim.lagOf(id);
  const bits = [`${formatRate(sources, per)} in`];
  if (sim.logs.size) bits.push(`lag ${formatCount(lag, per)}`);
  const down = [...sim.nodes.values()].filter((node) => !node.up).length;
  bits.push(drops ? `${formatRate(drops, per)} lost` : down ? `${down} down` : "healthy");
  return bits.join(" · ");
}
