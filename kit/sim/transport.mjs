import { attachContext } from "./context.mjs";
import { matches, selectRoute } from "./routing.mjs";
import { DETECT, isLog, routeOf, split } from "./common.mjs";
import { targetOf } from "./scenario.mjs";

// Request lifecycle: source emission, admission, endpoint stages, sync/async calls,
// retries, breakers, packet delivery and trace spans. Core fixes the tick ordering.
function breakerOf(value) {
  return value ? { errors: 0.5, min: 8, window: 2, open: 3, ...(value === true ? {} : value), state: "closed", outcomes: [], bad: 0, until: 0, trial: false } : null;
}

function createTransport(sim, { tables, logModel, decide }) {
  const { cfg, nodes, edges, logs, rand } = sim;
  const { recordOf, tableOp, acquireWrite, releaseWrite, commit, applyEntry } = tables;
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

  let ids = 0;
  const newMsg = (source, endpoint) => {
    const msg = { id: ++ids, source, born: sim.time, draws: null, endpoint };
    return sim.trafficState ? attachContext(msg, {}, null) : msg;
  };
  function decisionFor(job, routing) {
    const decision = selectRoute(routing, job.msg, sim.trafficState.policies, rand);
    const edge = decision.to && job.node.data.find(e => e.to === decision.to);
    if (edge && ((edge.flag && !decide(job.msg, edge.flag)) || (edge.unless && decide(job.msg, edge.unless)))) decision.outcome = "flag-blocked";
    if (edge && decision.outcome === "selected" && !nodes.get(edge.to).up) decision.outcome = "target-down";
    const event = { ...decision, node: job.node.id, at: sim.time, traffic: job.msg.traffic, msgId: job.msg.id };
    sim.trafficState.decisions.push(event);
    if (job.span) (job.span.decisions ??= []).push(event);
    if (!edge || decision.outcome === "flag-blocked") { job.failed = true; return null; }
    return edge;
  }
  // Per-route history at a node: rates, service times, end-to-end latency and errors.
  const routeStats = (node, name) => {
    if (!name) return null;
    if (!node.routes.has(name)) node.routes.set(name, { name, recent: [], service: [], roots: [], errors: [] });
    return node.routes.get(name);
  };
  // The endpoint a request is calling at this node, if the node declares it.
  const endpointAt = (node, msg) => (node.endpoints && msg.endpoint ? node.endpoints[msg.endpoint] : undefined);

  function launch(edge, kind, extra = {}) {
    const packet = { edge: edge.index, t: 0, dir: kind === "response" || kind === "error" ? -1 : 1, kind, duration: durationOf(edge), launched: sim.time, ...extra };
    packet.ep = (extra.msg || extra.call?.job.msg)?.endpoint;
    if (packet.dir > 0) {
      edge.sent++;
      edge.recent.push(sim.time);
    }
    if (sim.trafficState) {
      const msg = extra.msg || extra.call?.job.msg;
      if (msg && packet.dir > 0) sim.trafficState.paths.push({ at: sim.time, edge: edge.index, traffic: msg.traffic });
    }
    sim.packets.push(packet);
    return packet;
  }

  const burst = (edge, at = 1, msg) => sim.packets.push({ edge: edge.index, t: at, dir: 1, kind: "drop", age: 0, duration: 1, ...(sim.trafficState && msg ? { msg, ep: msg.endpoint } : {}) });

  // --- jobs -----------------------------------------------------------------------------------

  function startJob(node, msg, call, extra = {}) {
    const job = { node, msg, call, waiting: 0, forwarded: false, failed: false, dead: false, done: false, arrived: sim.time, cost: 0, ...extra };
    const t = sim.tracing;
    if (t && !t.msgId && job.root && (!t.endpoint || msg.endpoint === t.endpoint) && (!t.classes || t.classes.includes(msg.traffic))) {
      t.msgId = msg.id;
      t.endpoint = msg.endpoint;
      t.started = sim.time;
    }
    const traceId = msg.rootId ?? msg.id;
    if (t && t.msgId === traceId && !t.truncated) {
      if (sim.trafficState && t.spans.length >= 256) t.truncated = true;
    }
    if (t && t.msgId === traceId && !t.truncated) {
      // Where this span starts in model time: the parent's own time plus any stages it had
      // finished, plus the network on the way.
      const parent = call ? call.job : extra.parentJob;
      job.span = { id: t.spans.length, parent: parent?.span?.id ?? extra.traceParent ?? null, node: node.id, async: !call && !job.root, start: parent?.span ? parent.span.start + (parent.readyAt != null ? (parent.readyAt - parent.arrived) * 1000 : 0) + (parent.spent || 0) + (call ? (call.edge.ms ?? cfg.net) : 0) : 0, label: job.root ? msg.endpoint || "" : extra.entry ? `apply ${extra.entry.table}/${extra.entry.key} v${extra.entry.version}` : isLog(node) ? `append${extra.partition != null ? ` p${extra.partition}` : ""}` : "", done: false };
      if (sim.trafficState) {
        Object.assign(job.span, { msgId: msg.id, traffic: msg.traffic, context: msg.context });
        if (extra.traceParent != null && !parent?.span) job.span.start = Math.max(0, (sim.time - t.started) * 1000);
      }
      t.spans.push(job.span);
    }
    if (sim.trafficState) sim.trafficState.arrivals.push({ at: sim.time, node: node.id, traffic: msg.traffic });
    node.jobs.add(job);
    node.handled++;
    node.recent.push(sim.time);
    if (!extra.entry) routeStats(node, msg.endpoint)?.recent.push(sim.time);
    node.replica = (node.replica + 1) % Math.max(1, node.replicas || 1);
    if (!sim.quiet) sim.events.push({ type: "handle", node: node.id, replica: node.replica, at: sim.time });
    if (!node.capacity) { begin(job); return job; }
    if (node.bucket >= 1) {
      node.bucket -= 1;
      begin(job); return job;
    }
    if (node.waiting.length < node.queueMax) { node.waiting.push(job); return job; }
    reject(job);
    return job;
  }

  function begin(job) {
    const node = job.node;
    if (!acquireWrite(job)) return;
    // Service time varies: ±40% around `ms`, and one request in 30 takes 2-5x as long.
    const base = (endpointAt(node, job.msg)?.ms ?? node.ms) + (node.sidecar ? node.sidecarMs ?? 1.5 : 0);
    const spread = cfg.jitter === false ? 1 : (0.6 + 0.8 * rand()) * (rand() < 1 / 30 ? 2 + 3 * rand() : 1);
    job.readyAt = sim.time + (base * spread) / 1000;
    node.working.push(job);
  }

  // A request that never got in: counted at the node and on the edge, drawn as a red burst.
  function dropAt(edge, node, msg) {
    node.recentDrops.push(sim.time);
    if (!edge) return;
    edge.dropped++;
    burst(edge, 1, msg);
  }

  // Over capacity with a full buffer: answer 503 at once.
  function reject(job) {
    dropAt(job.call ? job.call.edge : job.via, job.node, job.msg);
    respond(job, false);
  }

  function respond(job, ok) {
    if (job.dead || job.done) return;
    job.done = true;
    const node = job.node;
    node.jobs.delete(job);
    if (!ok) node.recentErrors.push(sim.time);
    releaseWrite(job);
    const own = job.readyAt != null ? (job.readyAt - job.arrived) * 1000 : 0;
    const ms = own + (job.spent || 0) + job.cost;
    node.service.push({ at: sim.time, ms });
    const route = job.entry ? null : routeStats(node, job.msg.endpoint);
    if (route) {
      route.service.push({ at: sim.time, ms });
      if (!ok) route.errors.push(sim.time);
      if (job.root && node.answers) route.roots.push({ at: sim.time, ms, ok });
    }
    if (job.span) Object.assign(job.span, { done: true, ok, total: ms, own, end: sim.time });
    if (job.root && job.span && sim.tracing) sim.tracing.done = true;
    if (job.call) launch(job.call.edge, ok ? "response" : "error", { call: job.call, ms });
    if (job.root && node.answers) node.roots.push({ at: sim.time, ms, ok });
  }

  function ready(job) {
    if (job.dead || job.done) return;
    const node = job.node;
    if (!node.up) return;
    if (isLog(node)) return respond(job, true);
    if (node.errorRate && rand() < node.errorRate) return respond(job, false);
    // A database replica applies WAL entries; anything else (a CDC connector) passes them on.
    if (job.entry && node.store) return applyEntry(job);
    const op = tableOp(job);
    if (op) return respond(job, commit(job, op));
    forward(job);
    job.forwarded = true;
    if (job.waiting === 0) advance(job);
  }

  const healthy = (node, router) => node.up || sim.time - node.downSince < (router.detect ?? router.ttl ?? DETECT[router.kind] ?? 0);

  function forward(job) {
    const node = job.node;
    // A declared endpoint makes exactly its calls, each along the edge to its target.
    const endpoint = endpointAt(node, job.msg);
    if (endpoint && endpoint.calls) {
      // Calls run in parallel, in stages: a call with `then: true` starts a new stage that
      // waits for everything before it (write, then read your own write).
      job.stages = [];
      for (const call of endpoint.calls) {
        if (call.then || !job.stages.length) job.stages.push([]);
        job.stages[job.stages.length - 1].push(call);
      }
      job.stage = 0;
      issue(job, job.stages[0] || []);
      return;
    }
    if (node.routing) {
      const edge = decisionFor(job, node.routing);
      if (edge) {
        if (edge.sync) { job.waiting++; callOut(job, edge, 0); }
        else launch(edge, "request", { msg: job.msg, parentJob: job });
      }
      return;
    }
    const open = (edge) => (edge.flag ? decide(job.msg, edge.flag) : edge.unless ? !decide(job.msg, edge.unless) : true);
    // A database with tables replicates WAL entries as it commits them, not every request.
    if (!node.store) for (const edge of node.repl) if (!node.gated || open(edge)) launch(edge, "replication", { msg: job.msg });
    const data = node.gated ? node.data.filter(open) : node.data;
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
      } else launch(edge, "request", { msg: job.msg, parentJob: job });
    }
  }

  // --- calls: one attempt of a sync request ---------------------------------------------------

  const netOf = (edge) => (edge.ms ?? cfg.net) * 2;

  function callOut(job, edge, attempt, prior = 0, op) {
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
    const call = { job, edge, attempt, trial, prior, op, sent: sim.time, deadline: edge.timeout ? sim.time + allowance.get(edge.index) + edge.timeout + 1 : Infinity, done: false, packets: [] };
    sim.calls.add(call);
    if (edge.timeout) sim.timed.add(call);
    call.packets.push(launch(edge, attempt ? "retry" : "request", { call, msg: job.msg, op }));
  }

  function setBreaker(edge, state) {
    const br = edge.breaker;
    br.state = state;
    br.trial = false;
    if (state === "open") br.until = sim.time + br.open;
    if (state === "closed") {
      br.outcomes = [];
      br.bad = 0;
    }
    sim.events.push({ type: "breaker", edge: edge.index, state, at: sim.time });
  }

  function settle(call, ok, ms) {
    if (call.done) return;
    const spent = call.prior + ms;
    call.done = true;
    sim.calls.delete(call);
    sim.timed.delete(call);
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
        if (!ok) br.bad++;
        let old = 0;
        while (old < br.outcomes.length && br.outcomes[old].at < sim.time - br.window) if (!br.outcomes[old++].ok) br.bad--;
        if (old) br.outcomes.splice(0, old);
        if (br.outcomes.length >= br.min && br.bad / br.outcomes.length >= br.errors) setBreaker(edge, "open");
      }
    }
    if (!ok && call.attempt < (edge.retries || 0) && !job.dead && !job.done) {
      const wait = (edge.backoff ?? 0.05) * 2 ** call.attempt * (0.5 + rand());
      sim.timers.push({ at: sim.time + wait, run: () => !job.dead && !job.done && callOut(job, edge, call.attempt + 1, spent + wait * 1000, call.op) });
      return;
    }
    finish(job, ok, spent);
  }

  function finish(job, ok, ms) {
    job.waiting--;
    job.cost = Math.max(job.cost, ms);
    if (!ok) job.failed = true;
    if (job.waiting === 0 && job.forwarded) advance(job);
  }

  // One stage of an endpoint's calls; the next starts when this one has all answered.
  function issue(job, calls) {
    const node = job.node;
    for (const call of calls) {
      if (call.when && !matches(call.when, job.msg, sim.trafficState.policies)) continue;
      let edge;
      if (call.routing) {
        if (rand() >= (call.p ?? 1)) continue;
        edge = decisionFor(job, call.routing);
      } else {
        edge = node.out.find((e) => e.to === call.to && e.kind !== "config");
        if (!edge || rand() >= (call.p ?? 1)) continue;
      }
      if (!edge) continue;
      if (call.table) recordOf(job.msg, call.table);
      if (edge.kind === "replication") launch(edge, "replication", { msg: job.msg });
      else if (edge.sync) {
        job.waiting++;
        callOut(job, edge, 0, 0, call);
      } else launch(edge, "request", { msg: job.msg, op: call, parentJob: job });
    }
  }
  function advance(job) {
    while (job.stages && job.stage < job.stages.length - 1 && !job.failed && job.waiting === 0) {
      job.spent = (job.spent || 0) + job.cost;
      job.cost = 0;
      issue(job, job.stages[++job.stage]);
    }
    if (job.waiting === 0) respond(job, !job.failed);
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
      dropAt(edge, node, packet.msg || packet.call?.job.msg);
      // Connection refused: the caller hears about it straight away.
      if (packet.call) {
        const call = packet.call;
        sim.timers.push({ at: sim.time + cfg.refuse, run: () => !call.done && call.packets.push(launch(edge, "error", { call, ms: 0 })) });
      }
      return;
    }
    if (isLog(node)) {
      const log = logs.get(node.id);
      const p = logModel.append(log, edge, packet);
      if (p == null) {
        dropAt(edge, node, packet.msg || packet.call?.job.msg);
        if (packet.call) launch(edge, "error", { call: packet.call, ms: netOf(edge) });
        return;
      }
      const job = startJob(node, packet.msg || newMsg(edge.from), packet.call || null, { via: edge, parentJob: packet.parentJob, partition: p });
      logModel.remember(log, p, packet.msg || packet.call?.job.msg, job?.span?.id);
      return job;
    }
    startJob(node, packet.msg || newMsg(edge.from), packet.call || null, { via: edge, op: packet.op || packet.call?.op, entry: packet.entry, parentJob: packet.parentJob, ...(packet.traceParent != null ? { traceParent: packet.traceParent } : {}) });
  }

  // --- sources --------------------------------------------------------------------------------

  // `emit` is a rate, a curve, a schedule ({ every, burst }) or a mix of endpoints, each
  // with its own rate or curve: { "POST /orders": 3, "GET /orders/:id": [[0, 10], [20, 30]] }.
  const isSchedule = (emit) => emit && typeof emit === "object" && !Array.isArray(emit) && "every" in emit;
  const isMix = (emit) => emit && typeof emit === "object" && !Array.isArray(emit) && !("every" in emit);
  const rateOf = (emit, t) => {
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
  const emitAt = (node, t) => (isMix(node.emit) ? Object.values(node.emit).reduce((sum, e) => sum + rateOf(e, t), 0) : rateOf(node.emit, t));
  const pickEndpoint = (node, t) => {
    if (!isMix(node.emit)) return undefined;
    const entries = Object.entries(node.emit).map(([name, e]) => [name, rateOf(e, t)]);
    let pick = rand() * entries.reduce((sum, [, r]) => sum + r, 0);
    for (const [name, r] of entries) if ((pick -= r) <= 0) return name;
    return entries[entries.length - 1][0];
  };

  const emitOne = (node) => {
    const msg = newMsg(node.id, pickEndpoint(node, sim.time));
    if (sim.trafficState) sim.trafficState.emitted.push({ at: sim.time, traffic: null });
    return startJob(node, msg, null, { root: true });
  };

  function resetNode(node) {
    // In-flight work is lost; callers waiting on it get a reset.
    for (const job of node.jobs) {
      if (job.call && !job.done && !job.call.done) job.call.packets.push(launch(job.call.edge, "error", { call: job.call, ms: 0 }));
      job.dead = true;
    }
    tables.reset(node);
    node.jobs.clear();
    node.working = [];
    node.waiting = [];
  }

  // "from>to" in a scenario's `set` changes that edge: retries, timeout, backoff, p, breaker.
  const EDGE_SETTABLE = new Set(["retries", "timeout", "backoff", "p", "breaker", "rate"]);
  function setEdge(key, props) {
    const { from, to } = targetOf(key);
    const list = edges.filter((edge) => edge.from === from && edge.to === to);
    if (!list.length) throw new Error(`scenario: no edge "${key}"`);
    for (const edge of list) for (const [name, value] of Object.entries(props)) {
      if (!EDGE_SETTABLE.has(name)) throw new Error(`scenario: can't set "${name}" on an edge (settable: ${[...EDGE_SETTABLE].join(", ")})`);
      if (name === "breaker") {
        edge.breaker = breakerOf(value);
        sim.events.push({ type: "breaker", edge: edge.index, state: edge.breaker ? "closed" : "none", at: sim.time });
      } else edge[name] = value;
      if (name === "timeout") allowanceOf(edge);
    }
  }

  function tickNodes(dt) {
    const now = sim.time;
    for (const node of nodes.values()) {
      if (node.capacity) node.bucket = Math.min(node.capacity * (node.burst ?? 0.25) + 1, node.bucket + node.capacity * dt);
      if (!node.up) continue;
      if (node.workload) {
        node.workClocks ??= node.workload.map(() => 0);
        node.workload.forEach((work, index) => {
          const rate = rateOf(work.rate, now);
          if (!rate) return;
          node.workClocks[index] -= dt;
          while (node.workClocks[index] <= 0) {
            node.workClocks[index] += (0.6 + rand() * 0.8) / rate;
            const msg = newMsg(node.id, work.endpoint);
            const definition = sim.trafficState.definitions[work.traffic];
            attachContext(msg, { ...definition?.context, ...work.context }, work.traffic);
            sim.trafficState.emitted.push({ at: now, traffic: msg.traffic });
            startJob(node, msg, null, { root: true });
          }
        });
      } else if (isSchedule(node.emit)) {
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
        const [due, later] = split(node.working, (job) => job.readyAt <= now);
        if (due.length) {
          node.working = later;
          due.forEach(ready);
        }
      }
    }
  }

  function tickTimeouts() {
    const now = sim.time;
    // Timeouts: the caller gives up; a reply still on its way arrives late and is ignored.
    if (sim.timed.size) {
      for (const call of [...sim.timed]) if (now >= call.deadline) {
        for (const packet of call.packets) if (packet.dir < 0) packet.kind = "late";
        call.timedOut = true;
        settle(call, false, call.edge.timeout * 1000);
      }
    }
  }

  function tickPackets(dt) {
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
  }

  return { launch, newMsg, begin, respond, resetNode, setEdge, tickNodes, tickTimeouts, tickPackets };
}

export { breakerOf, createTransport };
