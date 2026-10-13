// The model behind every figure: a small, seeded, tick-based simulation of requests moving
// through a system. The page inlines this file (exports stripped) and draws `sim.packets`;
// `scripts/build.mjs --check` runs the same code in Node and prints what the readout will say.
// Every number a figure shows comes from here.
//
// Time. Sim time is real time for everything the model decides (service time, queue waits,
// timeouts, backoff, breaker windows, rates), except packet travel, which is slowed down so
// people can watch it. Latency is therefore built up in model time rather than measured off
// the clock: a job costs its queue wait plus its service time plus its slowest sync call, and a
// call costs its network round trip (`ms` on the edge, default `sim.net`) plus the callee's job,
// plus any earlier failed attempts and their backoff.

export const SIM_DEFAULTS = { speed: 150, per: 1, rebalance: 0.9, window: 2, seed: 7, refuse: 0.02, net: 0.5, length: 0, loop: true };
export const SERVICE_MS = { client: 0, lb: 0.3, gateway: 1, service: 8, worker: 15, cache: 0.4, db: 4, storage: 20, kafka: 2, queue: 1, cdn: 0.5, dns: 1, external: 120, flags: 1, scheduler: 0, box: 5 };
export const DETECT = { lb: 0.6, gateway: 0.6, dns: 3 };

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
export const routeOf = (node) => node.route || (node.kind === "lb" || node.kind === "gateway" || node.kind === "dns" ? "roundrobin" : "all");

export function hashOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Scenario steps may name a phase instead of a time: { phase: "incident", after: 1.5 }.
export function normalizeScenario(scenario) {
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

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

// spec: { nodes, edges (with `len` in world units), sim, scenario, flags, features }.
export function createSim(spec) {
  const features = spec.features || {};
  const on = (name) => features[name] !== false;
  const cfg = { ...SIM_DEFAULTS, ...(spec.sim || {}) };
  const scenario = on("scenario") ? normalizeScenario(spec.scenario) : null;
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
    breaker: on("breakers") && edge.breaker ? { errors: 0.5, min: 8, window: 2, open: 3, ...(edge.breaker === true ? {} : edge.breaker), state: "closed", outcomes: [], until: 0, trial: false } : null,
  }));
  for (const node of spec.nodes) {
    nodes.set(node.id, {
      ...node,
      up: node.up !== false,
      downSince: node.up === false ? 0 : null,
      ms: node.ms ?? SERVICE_MS[node.kind] ?? 5,
      queueMax: on("queues") ? node.queue || 0 : 0,
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
    });
  }
  for (const edge of edges) {
    nodes.get(edge.from).out.push(edge);
    nodes.get(edge.to).into.push(edge);
  }

  // Feature flags in the modelled system. A service evaluates flags locally from the last
  // config it got; while the flag service is down, changes don't reach anyone.
  const flags = new Map();
  if (on("flags")) for (const [name, flag] of Object.entries(spec.flags || {})) flags.set(name, { name, rollout: flag.rollout ?? 0, sticky: !!flag.sticky, effective: flag.rollout ?? 0 });
  const flagNode = on("flags") ? [...nodes.values()].find((node) => node.kind === "flags") : null;

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
    const log = { node, partitions, end: Array(partitions).fill(0), rr: 0, groups: [...groups.values()], appended: 0 };
    // Brokers: each partition has `rf` replicas, led round-robin. Losing a leader pauses its
    // partitions for `election` seconds; with acks "all", a partition whose in-sync replicas
    // fall below `minIsr` refuses writes.
    if (node.kind === "kafka" && node.brokers) {
      const n = node.brokers;
      log.brokers = Array(n).fill(true);
      log.rf = Math.min(node.rf ?? 3, n);
      log.minIsr = Math.min(node.minIsr ?? 2, log.rf);
      log.acks = node.acks ?? 1;
      log.election = node.election ?? 2;
      log.parts = Array.from({ length: partitions }, (_, p) => ({ replicas: Array.from({ length: log.rf }, (_, i) => (p + i) % n), leader: p % n, electUntil: 0 }));
    }
    logs.set(node.id, log);
  }

  const durationOf = (edge) => Math.max(edge.len / cfg.speed, 0.08);
  // Timeouts are judged in model time when the reply arrives. For a reply that never comes,
  // a backstop deadline in sim time: the call's animation round trip, the slowest sync call
  // its target makes in turn, the timeout and a second's grace.
  const allowance = new Map();
  const allowanceOf = (edge, seen = new Set()) => {
    if (allowance.has(edge.index)) return allowance.get(edge.index);
    if (seen.has(edge.index)) return 0;
    seen.add(edge.index);
    const target = nodes.get(edge.to);
    const below = target.out.filter((e) => e.sync && e.kind !== "replication").map((e) => allowanceOf(e, seen));
    const value = 2 * durationOf(edge) + Math.max(0, ...below);
    allowance.set(edge.index, value);
    return value;
  };
  edges.forEach((edge) => allowanceOf(edge));

  const sim = { cfg, nodes, edges, logs, flags, scenario, features, packets: [], time: 0, events: [], rand, calls: new Set(), timers: [], stepIndex: 0, histClock: 0, hist: [] };
  let ids = 0;
  const newMsg = (source) => ({ id: ++ids, source, born: sim.time, draws: null });

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

  function launch(edge, kind, extra = {}) {
    const packet = { edge: edge.index, t: 0, dir: kind === "response" || kind === "error" ? -1 : 1, kind, duration: durationOf(edge), launched: sim.time, ...extra };
    if (packet.dir > 0) {
      edge.sent++;
      edge.recent.push(sim.time);
    }
    sim.packets.push(packet);
    return packet;
  }

  const burst = (edge, at = 1) => sim.packets.push({ edge: edge.index, t: at, dir: 1, kind: "drop", age: 0, duration: 1 });

  // --- jobs -----------------------------------------------------------------------------------

  function startJob(node, msg, call, extra = {}) {
    const job = { node, msg, call, waiting: 0, forwarded: false, failed: false, dead: false, done: false, arrived: sim.time, cost: 0, ...extra };
    node.jobs.add(job);
    node.handled++;
    node.recent.push(sim.time);
    node.replica = (node.replica + 1) % Math.max(1, node.replicas || 1);
    sim.events.push({ type: "handle", node: node.id, replica: node.replica, at: sim.time });
    if (!node.capacity) return begin(job);
    if (node.bucket >= 1) {
      node.bucket -= 1;
      return begin(job);
    }
    if (node.waiting.length < node.queueMax) return node.waiting.push(job);
    reject(job);
  }

  function begin(job) {
    const node = job.node;
    // Service time varies: ±40% around `ms`, and one request in 30 takes 2-5x as long.
    const base = node.ms + (node.sidecar ? node.sidecarMs ?? 1.5 : 0);
    const spread = cfg.jitter === false ? 1 : (0.6 + 0.8 * rand()) * (rand() < 1 / 30 ? 2 + 3 * rand() : 1);
    job.readyAt = sim.time + (base * spread) / 1000;
    node.working.push(job);
  }

  // Over capacity with a full buffer: answer 503 at once.
  function reject(job) {
    const node = job.node;
    node.recentDrops.push(sim.time);
    if (job.call) {
      job.call.edge.dropped++;
      burst(job.call.edge);
    } else if (job.via) burst(job.via);
    respond(job, false);
  }

  function respond(job, ok) {
    if (job.dead || job.done) return;
    job.done = true;
    const node = job.node;
    node.jobs.delete(job);
    if (!ok) node.recentErrors.push(sim.time);
    const own = job.readyAt != null ? (job.readyAt - job.arrived) * 1000 : 0;
    const ms = own + job.cost;
    node.service.push({ at: sim.time, ms });
    if (job.call) launch(job.call.edge, ok ? "response" : "error", { call: job.call, ms });
    if (job.root) node.roots.push({ at: sim.time, ms, ok });
  }

  function ready(job) {
    if (job.dead || job.done) return;
    const node = job.node;
    if (!node.up) return;
    if (isLog(node)) return respond(job, true);
    if (node.errorRate && rand() < node.errorRate) return respond(job, false);
    forward(job);
    job.forwarded = true;
    if (job.waiting === 0) respond(job, !job.failed);
  }

  const decide = (msg, name) => {
    const flag = flags.get(name);
    if (!flag) return false;
    if (flag.sticky) return (hashOf(`${msg.source}:${name}`) % 10000) / 10000 < flag.effective;
    msg.draws ??= {};
    if (msg.draws[name] === undefined) msg.draws[name] = rand() < flag.effective;
    return msg.draws[name];
  };
  const healthy = (node, router) => node.up || sim.time - node.downSince < (router.detect ?? router.ttl ?? DETECT[router.kind] ?? 0);

  function forward(job) {
    const node = job.node;
    const usable = node.out.filter((edge) => edge.kind !== "config").filter((edge) => (edge.flag && on("flags") ? decide(job.msg, edge.flag) : edge.unless && on("flags") ? !decide(job.msg, edge.unless) : true));
    for (const edge of usable) if (edge.kind === "replication") {
      launch(edge, "replication", { msg: job.msg });
    }
    const data = usable.filter((edge) => edge.kind !== "replication");
    if (!data.length) return;
    const mode = routeOf(node);
    const chosen = [];
    if (mode === "roundrobin") {
      // Health checks notice a dead target only after `detect` seconds (`ttl` for DNS).
      for (let tries = 0; tries < data.length; tries++) {
        const edge = data[node.rr++ % data.length];
        if (node.health === false || healthy(nodes.get(edge.to), node)) {
          chosen.push(edge);
          break;
        }
      }
      if (!chosen.length) job.failed = true;
    } else if (mode === "random") {
      const total = data.reduce((sum, edge) => sum + (edge.p ?? 1), 0);
      let pick = rand() * total;
      chosen.push(data.find((edge) => (pick -= edge.p ?? 1) <= 0) || data[data.length - 1]);
    } else {
      // A CDN or cache with `hit` sends only its misses on.
      for (const edge of data) if (rand() < (edge.p ?? (node.hit != null ? 1 - node.hit : 1))) chosen.push(edge);
    }
    for (const edge of chosen) {
      if (edge.sync) {
        job.waiting++;
        callOut(job, edge, 0);
      } else launch(edge, "request", { msg: job.msg });
    }
  }

  // --- calls: one attempt of a sync request ---------------------------------------------------

  const netOf = (edge) => (edge.ms ?? cfg.net) * 2;

  function callOut(job, edge, attempt, prior = 0) {
    const br = edge.breaker;
    let trial = false;
    if (br) {
      if (br.state === "open" && sim.time >= br.until) setBreaker(edge, "half");
      if (br.state === "open" || (br.state === "half" && br.trial)) {
        edge.fast++;
        return finish(job, false, prior);
      }
      if (br.state === "half") {
        br.trial = true;
        trial = true;
      }
    }
    const call = { job, edge, attempt, trial, prior, sent: sim.time, deadline: edge.timeout ? sim.time + allowance.get(edge.index) + edge.timeout + 1 : Infinity, done: false, packets: [] };
    sim.calls.add(call);
    call.packets.push(launch(edge, attempt ? "retry" : "request", { call, msg: job.msg }));
  }

  function setBreaker(edge, state) {
    const br = edge.breaker;
    br.state = state;
    br.trial = false;
    if (state === "open") br.until = sim.time + br.open;
    if (state === "closed") br.outcomes = [];
    sim.events.push({ type: "breaker", edge: edge.index, state, at: sim.time });
  }

  function settle(call, ok, ms) {
    if (call.done) return;
    const spent = call.prior + ms;
    call.done = true;
    sim.calls.delete(call);
    const { edge, job } = call;
    if (!ok) {
      edge.failed++;
      edge.recentErrors.push(sim.time);
    }
    const br = edge.breaker;
    if (br) {
      if (call.trial) setBreaker(edge, ok ? "closed" : "open");
      else if (br.state === "closed") {
        br.outcomes.push({ at: sim.time, ok });
        while (br.outcomes.length && br.outcomes[0].at < sim.time - br.window) br.outcomes.shift();
        const bad = br.outcomes.filter((o) => !o.ok).length;
        if (br.outcomes.length >= br.min && bad / br.outcomes.length >= br.errors) setBreaker(edge, "open");
      }
    }
    if (!ok && call.attempt < (edge.retries || 0) && !job.dead && !job.done) {
      const wait = (edge.backoff ?? 0.05) * 2 ** call.attempt * (0.5 + rand());
      sim.timers.push({ at: sim.time + wait, run: () => !job.dead && !job.done && callOut(job, edge, call.attempt + 1, spent + wait * 1000) });
      return;
    }
    finish(job, ok, spent);
  }

  function finish(job, ok, ms) {
    job.waiting--;
    job.cost = Math.max(job.cost, ms);
    if (!ok) job.failed = true;
    if (job.waiting === 0 && job.forwarded) respond(job, !job.failed);
  }

  // --- arrivals -------------------------------------------------------------------------------

  function arrive(packet) {
    const edge = edges[packet.edge];
    if (packet.dir < 0) {
      const call = packet.call;
      if (!call || call.done) return;
      const ms = netOf(edge) + (packet.ms || 0);
      // The caller gave up at `timeout` in model time: this reply is late and ignored.
      if (edge.timeout && ms > edge.timeout * 1000) {
        call.timedOut = true;
        return settle(call, false, edge.timeout * 1000);
      }
      return settle(call, packet.kind === "response", ms);
    }
    const node = nodes.get(edge.to);
    if (!node.up) {
      node.recentDrops.push(sim.time);
      edge.dropped++;
      burst(edge);
      // Connection refused: the caller hears about it straight away.
      if (packet.call) {
        const call = packet.call;
        sim.timers.push({ at: sim.time + cfg.refuse, run: () => !call.done && call.packets.push(launch(edge, "error", { call, ms: 0 })) });
      }
      return;
    }
    if (isLog(node)) {
      const log = logs.get(node.id);
      const p = chooseP(log, edge, packet);
      if (!writable(log, p)) {
        node.recentDrops.push(sim.time);
        edge.dropped++;
        burst(edge);
        if (packet.call) launch(edge, "error", { call: packet.call, ms: netOf(edge) });
        return;
      }
      log.end[p]++;
      log.appended++;
    }
    startJob(node, packet.msg || newMsg(edge.from), packet.call || null, { via: edge });
  }

  const isrOf = (log, part) => part.replicas.filter((b) => log.brokers[b]).length;
  const readable = (log, p) => !log.parts || (sim.time >= log.parts[p].electUntil && log.brokers[log.parts[p].leader]);
  const writable = (log, p) => readable(log, p) && (!log.parts || log.acks !== "all" || isrOf(log, log.parts[p]) >= log.minIsr);

  function setBroker(id, b, up) {
    const log = logs.get(id);
    if (!log?.brokers || b < 0 || b >= log.brokers.length || log.brokers[b] === up) return;
    log.brokers[b] = up;
    sim.events.push({ type: up ? "broker-up" : "broker-down", node: id, broker: b, at: sim.time });
    for (const part of log.parts) {
      if (!up && part.leader === b) {
        const next = part.replicas.find((r) => log.brokers[r]);
        if (next != null) {
          part.leader = next;
          part.electUntil = sim.time + log.election;
        }
      } else if (up && !log.brokers[part.leader] && part.replicas.includes(b)) {
        part.leader = b;
        part.electUntil = sim.time + log.election;
      }
    }
  }

  function chooseP(log, edge, packet) {
    if (packet.partition != null) return packet.partition;
    if (edge.key != null) return hashOf(String(edge.key)) % log.partitions;
    const skew = log.node.skew;
    if (skew) {
      const total = skew.reduce((a, b) => a + b, 0);
      let pick = rand() * total;
      for (let p = 0; p < log.partitions; p++) if ((pick -= skew[p] ?? 0) <= 0) return p;
      return log.partitions - 1;
    }
    return log.rr++ % log.partitions;
  }

  // --- sources --------------------------------------------------------------------------------

  const emitAt = (node, t) => {
    const emit = node.emit;
    if (typeof emit === "number") return emit;
    if (Array.isArray(emit)) {
      const span = cfg.length || emit[emit.length - 1][0] || 1;
      const x = cfg.loop && cfg.length ? t % span : t;
      if (x <= emit[0][0]) return emit[0][1];
      for (let i = 1; i < emit.length; i++) {
        const [t1, r1] = emit[i];
        const [t0, r0] = emit[i - 1];
        if (x <= t1) return r0 + ((r1 - r0) * (x - t0)) / Math.max(t1 - t0, 1e-6);
      }
      return emit[emit.length - 1][1];
    }
    return 0;
  };

  function emitOne(node) {
    const msg = newMsg(node.id);
    const job = { node, msg, call: null, waiting: 0, forwarded: false, failed: false, dead: false, done: false, arrived: sim.time, cost: 0, root: true };
    node.jobs.add(job);
    node.handled++;
    node.recent.push(sim.time);
    sim.events.push({ type: "handle", node: node.id, replica: 0, at: sim.time });
    forward(job);
    job.forwarded = true;
    if (job.waiting === 0) {
      job.done = true;
      node.jobs.delete(job);
      if (node.out.some((edge) => edge.sync)) node.roots.push({ at: sim.time, ms: 0, ok: !job.failed });
    }
  }

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
      const due = sim.timers.filter((timer) => timer.at <= now);
      if (due.length) {
        sim.timers = sim.timers.filter((timer) => timer.at > now);
        due.forEach((timer) => timer.run());
      }
    }
    for (const node of nodes.values()) {
      if (node.capacity) node.bucket = Math.min(node.capacity * (node.burst ?? 0.25) + 1, node.bucket + node.capacity * dt);
      if (!node.up) continue;
      if (node.emit && typeof node.emit === "object" && !Array.isArray(node.emit)) {
        // A scheduler: `burst` messages every `every` seconds, spread over a third of a second.
        if (now >= node.nextBurst) {
          node.nextBurst = now + node.emit.every;
          for (let i = 0; i < node.emit.burst; i++) sim.timers.push({ at: now + (i / node.emit.burst) * 0.33, run: () => node.up && emitOne(node) });
        }
      } else if (node.emit) {
        const rate = emitAt(node, now);
        if (rate > 0) {
          node.clock -= dt;
          while (node.clock <= 0) {
            node.clock += (0.6 + rand() * 0.8) / rate;
            emitOne(node);
          }
        }
      }
      while (node.waiting.length && node.bucket >= 1) {
        node.bucket -= 1;
        begin(node.waiting.shift());
      }
      if (node.working.length) {
        const due = node.working.filter((job) => job.readyAt <= now);
        if (due.length) {
          node.working = node.working.filter((job) => job.readyAt > now);
          due.forEach(ready);
        }
      }
    }
    // Timeouts: the caller gives up; a reply still on its way arrives late and is ignored.
    if (sim.calls.size) {
      for (const call of [...sim.calls]) if (now >= call.deadline) {
        for (const packet of call.packets) if (packet.dir < 0) packet.kind = "late";
        call.timedOut = true;
        settle(call, false, call.edge.timeout * 1000);
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
              if (!readable(log, p)) continue;
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
            launch(edge, "record", { partition: best, group: group.name, msg: newMsg(log.node.id) });
          }
        }
      }
    }
    // Move packets; an arriving packet hands off.
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
      if (packet.t >= 1) {
        if (packet.kind !== "late") arrive(packet);
      } else live.push(packet);
    }
    sim.packets = live.concat(sim.packets);
    const window = Math.min(cfg.window, Math.max(now, 0.25));
    const trim = (list, keep = cfg.window) => {
      while (list.length && (list[0].at ?? list[0]) < now - keep) list.shift();
    };
    for (const node of nodes.values()) {
      trim(node.recent);
      trim(node.recentDrops);
      trim(node.recentErrors);
      trim(node.service, 3);
      trim(node.roots, 3);
      node.flow = node.recent.length / window;
      node.dropRate = node.recentDrops.length / window;
      node.errorRateSeen = node.recentErrors.length / window;
    }
    for (const edge of edges) {
      trim(edge.recent);
      trim(edge.recentErrors);
      edge.flow = edge.recent.length / window;
      edge.errorRate = edge.recentErrors.length / window;
    }
    sim.histClock += dt;
    if (sim.histClock >= 0.25) {
      sim.histClock = 0;
      for (const node of nodes.values()) {
        node.hist.push(node.flow);
        if (node.hist.length > 120) node.hist.shift();
      }
      sim.hist.push(totalIn());
      if (sim.hist.length > 120) sim.hist.shift();
    }
    if (sim.events.length > 512) sim.events.splice(0, sim.events.length - 512);
  }

  const totalIn = () => [...nodes.values()].reduce((sum, node) => sum + (node.emit && node.up ? node.flow : 0), 0);

  function setUp(id, up) {
    const broker = /^(.*):b(\d+)$/.exec(id);
    if (broker && !nodes.has(id)) return setBroker(broker[1], +broker[2], up);
    const node = nodes.get(id);
    if (!node || node.up === up) return;
    node.up = up;
    node.downSince = up ? null : sim.time;
    if (!up) {
      // In-flight work is lost; callers waiting on it get a reset.
      for (const job of node.jobs) {
        if (job.call && !job.done && !job.call.done) job.call.packets.push(launch(job.call.edge, "error", { call: job.call, ms: 0 }));
        job.dead = true;
      }
      node.jobs.clear();
      node.working = [];
      node.waiting = [];
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

  // "from>to" in a scenario's `set` changes that edge: retries, timeout, backoff, p, breaker.
  const EDGE_SETTABLE = new Set(["retries", "timeout", "backoff", "p", "breaker", "rate"]);
  function setEdge(key, props) {
    const [from, to] = key.split(">");
    const list = edges.filter((edge) => edge.from === from && edge.to === to);
    if (!list.length) throw new Error(`scenario: no edge "${key}"`);
    for (const edge of list) for (const [name, value] of Object.entries(props)) {
      if (!EDGE_SETTABLE.has(name)) throw new Error(`scenario: can't set "${name}" on an edge (settable: ${[...EDGE_SETTABLE].join(", ")})`);
      if (name === "breaker") {
        edge.breaker = value && on("breakers") ? { errors: 0.5, min: 8, window: 2, open: 3, ...(value === true ? {} : value), state: "closed", outcomes: [], until: 0, trial: false } : null;
        sim.events.push({ type: "breaker", edge: edge.index, state: edge.breaker ? "closed" : "none", at: sim.time });
      } else edge[name] = value;
      if (name === "timeout") allowanceOf(edge);
    }
  }

  const SETTABLE = new Set(["emit", "rate", "capacity", "burst", "errorRate", "ms", "queue", "detect", "ttl", "route", "health", "sidecarMs"]);
  function apply(step) {
    if (step.fail) [].concat(step.fail).forEach((id) => setUp(id, false));
    if (step.recover) [].concat(step.recover).forEach((id) => setUp(id, true));
    if (step.set) {
      for (const [id, props] of Object.entries(step.set)) {
        if (id.includes(">")) {
          setEdge(id, props);
          continue;
        }
        const node = nodes.get(id);
        if (!node) throw new Error(`scenario: unknown node "${id}"`);
        for (const [key, value] of Object.entries(props)) {
          if (!SETTABLE.has(key)) throw new Error(`scenario: can't set "${key}" (settable: ${[...SETTABLE].join(", ")})`);
          if (key === "queue") node.queueMax = on("queues") ? value : 0;
          else node[key] = value;
          if (key === "emit" && typeof value === "number") node.clock = Math.min(node.clock, 1 / Math.max(value, 0.001));
        }
      }
    }
    if (on("flags")) {
      if (step.flag) {
        const flag = flags.get(step.flag);
        if (!flag) throw new Error(`scenario: unknown flag "${step.flag}"`);
        flag.rollout = step.rollout ?? 1;
        syncFlag(flag);
      }
      if (step.kill) {
        const flag = flags.get(step.kill);
        if (!flag) throw new Error(`scenario: unknown flag "${step.kill}"`);
        flag.rollout = 0;
        syncFlag(flag);
      }
    }
  }

  sim.step = (dt) => {
    // Sub-step so a long frame doesn't teleport packets past their arrival.
    const n = Math.max(1, Math.ceil(dt / (1 / 60)));
    for (let i = 0; i < n; i++) step(dt / n);
  };
  sim.setUp = setUp;
  sim.setBroker = setBroker;
  sim.readable = readable;
  sim.isrOf = isrOf;
  sim.apply = apply;
  sim.totalIn = totalIn;
  sim.lagOf = (id, groupName) => {
    const log = logs.get(id);
    if (!log) return 0;
    const group = groupName ? log.groups.find((g) => g.name === groupName) : log.groups[0];
    if (!group) return 0;
    return log.end.reduce((sum, end, p) => sum + end - group.committed[p], 0);
  };
  sim.latencyOf = (id) => latencyOf(id ? [nodes.get(id)] : [...nodes.values()]);
  sim.statsOf = (id) => statsOf(sim, id);
  sim.summary = () => summaryOf(sim);
  return sim;
}

// p50 / p99 of completed requests started at these sources, over the last 3 s of model time.
function latencyOf(sources) {
  const samples = [];
  let failed = 0;
  for (const node of sources) for (const root of node?.roots || []) {
    if (root.ok) samples.push(root.ms);
    else failed++;
  }
  samples.sort((a, b) => a - b);
  return { p50: quantile(samples, 0.5), p99: quantile(samples, 0.99), count: samples.length, failed };
}

const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n >= 10 ? n.toFixed(0) : n.toFixed(1));
export const formatRate = (n, per = 1) => `${fmt(n * per)}/s`;
export const formatCount = (n, per = 1) => fmt(n * per).replace(/\.0$/, "");
export const formatMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : ms >= 10 ? `${ms.toFixed(0)}ms` : `${ms.toFixed(1)}ms`);

export function statsOf(sim, id) {
  const node = sim.nodes.get(id);
  if (!node) return "";
  const per = sim.cfg.per;
  const name = node.label || node.id;
  if (!node.up) return `${name} · down${node.dropRate ? ` · ${formatRate(node.dropRate, per)} refused` : ""}`;
  const log = sim.logs.get(id);
  if (log) {
    const parts = log.groups.map((group) => {
      const lag = log.end.reduce((sum, end, p) => sum + end - group.committed[p], 0);
      const live = [...group.assign.values()].filter((list) => list.length).length;
      return `${log.groups.length > 1 ? group.name + " " : ""}lag ${formatCount(lag, per)}${group.pause > 0 ? " · rebalancing" : node.kind === "kafka" ? ` · ${live}/${group.members.length} consumers` : ""}`;
    });
    if (log.brokers) {
      const live = log.brokers.filter(Boolean).length;
      const electing = log.parts.filter((part) => sim.time < part.electUntil).length;
      const offline = log.parts.filter((part) => !log.brokers[part.leader]).length;
      const under = log.parts.filter((part) => sim.isrOf(log, part) < log.minIsr).length;
      parts.push(`brokers ${live}/${log.brokers.length}`);
      if (electing) parts.push(`${electing} electing`);
      if (offline) parts.push(`${offline} offline`);
      if (under) parts.push(`${under} under min ISR${log.acks === "all" ? " (writes refused)" : ""}`);
    }
    return `${name} · in ${formatRate(node.flow, per)} · ${parts.join(" · ")}`;
  }
  if (node.kind === "flags") {
    const list = [...sim.flags.values()].map((flag) => `${flag.name} ${Math.round(flag.effective * 100)}%${flag.effective !== flag.rollout ? ` (→${Math.round(flag.rollout * 100)}%)` : ""}`);
    return `${name} · ${list.join(" · ") || "no flags"}`;
  }
  const bits = [`${name} · ${formatRate(node.flow, per)}`];
  if (node.roots.length) {
    const lat = latencyOf([node]);
    if (lat.count) bits.push(`p50 ${formatMs(lat.p50)} · p99 ${formatMs(lat.p99)}`);
  } else if (node.service.length) {
    const sorted = node.service.map((s) => s.ms).sort((a, b) => a - b);
    bits.push(`${formatMs(quantile(sorted, 0.5))} p50`);
  }
  if (node.capacity) bits.push(`cap ${formatRate(node.capacity, per)}`);
  if (node.queueMax) bits.push(`queue ${node.waiting.length}/${node.queueMax}`);
  if (node.dropRate) bits.push(`${formatRate(node.dropRate, per)} rejected`);
  if (node.errorRateSeen) bits.push(`${formatRate(node.errorRateSeen, per)} errors`);
  for (const edge of node.out) if (edge.breaker && edge.breaker.state !== "closed") bits.push(`breaker → ${sim.nodes.get(edge.to).label || edge.to} ${edge.breaker.state}`);
  return bits.join(" · ");
}

export function summaryOf(sim) {
  const per = sim.cfg.per;
  let lag = 0;
  let drops = 0;
  for (const node of sim.nodes.values()) drops += node.dropRate;
  for (const id of sim.logs.keys()) lag += sim.lagOf(id);
  const bits = [`${formatRate(sim.totalIn(), per)} in`];
  const lat = sim.latencyOf();
  if (lat.count) bits.push(`p50 ${formatMs(lat.p50)} · p99 ${formatMs(lat.p99)}`);
  if (sim.logs.size) bits.push(`lag ${formatCount(lag, per)}`);
  const failing = lat.failed / 3;
  const down = [...sim.nodes.values()].filter((node) => !node.up).length;
  bits.push(failing > 0.05 ? `${formatRate(failing, per)} failing` : drops ? `${formatRate(drops, per)} lost` : down ? `${down} down` : "healthy");
  return bits.join(" · ");
}
