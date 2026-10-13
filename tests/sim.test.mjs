import test from "node:test";
import assert from "node:assert/strict";
import { createSim } from "../kit/topo-sim.mjs";
import { modelOf, simSpec } from "../kit/topo.mjs";
import orderEvents from "../examples/order-events/order-events.spec.mjs";

const simOf = (spec, features) => createSim(simSpec(modelOf(spec, features ? [features] : [])));
const run = (sim, seconds) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) sim.step(1 / 60);
};
const chain = (extra = {}) => ({
  nodes: [
    { id: "c", kind: "client", emit: 4 },
    { id: "a", kind: "service", ms: 10 },
    { id: "b", kind: "db", ms: 20, ...(extra.b || {}) },
  ],
  edges: [{ from: "c", to: "a" }, { from: "a", to: "b", ...(extra.ab || {}) }],
  sim: { seed: 1 },
});

test("same seed, same run", () => {
  const trace = () => {
    const sim = simOf(orderEvents);
    run(sim, 10);
    return [sim.summary(), ...[...sim.nodes.keys()].map((id) => sim.statsOf(id))].join("\n");
  };
  assert.equal(trace(), trace());
});

test("a sync chain answers only after its leaf, and latency is model time", () => {
  const sim = simOf(chain());
  run(sim, 8);
  const lat = sim.latencyOf("c");
  assert.ok(lat.count > 10, `completed ${lat.count}`);
  // a (10 ms) + b (20 ms); animation travel is excluded.
  assert.ok(lat.p50 >= 29 && lat.p50 < 40, `p50 ${lat.p50}`);
  assert.equal(lat.failed, 0);
});

test("a full queue answers 503 and the client sees failures", () => {
  const spec = chain({ b: { capacity: 1, queue: 2, burst: 0 } });
  const sim = simOf(spec);
  run(sim, 10);
  const b = sim.nodes.get("b");
  assert.ok(b.dropRate > 0, "rejections");
  assert.ok(sim.latencyOf("c").failed > 0, "failed roots");
  // queued requests wait: latency well above service time
  assert.ok(sim.latencyOf("c").p99 > 300, `p99 ${sim.latencyOf("c").p99}`);
});

test("queues feature off: no buffer, arrivals over capacity drop", () => {
  const sim = simOf(chain({ b: { capacity: 1, queue: 50 } }), "-queues");
  run(sim, 6);
  assert.equal(sim.nodes.get("b").queueMax, 0);
});

test("retries resend failed calls", () => {
  const spec = chain({ ab: { retries: 2, backoff: 0.01 }, b: { up: false } });
  const sim = simOf(spec);
  run(sim, 8);
  const edge = sim.edges[1];
  const a = sim.nodes.get("a").handled;
  assert.ok(edge.sent >= a * 2.4 && edge.sent <= a * 3, `sent ${edge.sent} for ${a} requests`);
});

test("timeouts fail slow calls and late replies are ignored", () => {
  const spec = chain({ ab: { timeout: 0.05 }, b: { ms: 200 } });
  const sim = simOf(spec);
  run(sim, 6);
  assert.ok(sim.edges[1].failed > 5, `failed ${sim.edges[1].failed}`);
  assert.ok(sim.latencyOf("c").failed > 5);
});

test("a breaker opens on errors, then half-opens and closes on recovery", () => {
  const spec = chain({ ab: { breaker: { errors: 0.5, min: 4, window: 2, open: 1 } } });
  const sim = simOf(spec);
  const states = [];
  const watch = (frames) => {
    for (let i = 0; i < frames; i++) {
      sim.step(1 / 60);
      for (const e of sim.events) if (e.type === "breaker") states.push(e.state);
      sim.events.length = 0;
    }
  };
  run(sim, 2);
  sim.setUp("b", false);
  watch(300);
  assert.ok(states.includes("open"), states.join());
  assert.ok(sim.edges[1].fast > 0, "fast failures while open");
  sim.setUp("b", true);
  watch(300);
  assert.ok(states.includes("half"), states.join());
  assert.equal(sim.edges[1].breaker.state, "closed", states.join());
});

test("an LB keeps sending to a dead target until health checks notice", () => {
  const spec = {
    nodes: [
      { id: "c", kind: "client", emit: 10 },
      { id: "lb", kind: "lb", detect: 1 },
      { id: "x", kind: "service" },
      { id: "y", kind: "service" },
    ],
    edges: [["c", "lb"], ["lb", "x"], ["lb", "y"]],
  };
  const sim = simOf(spec);
  run(sim, 3);
  sim.setUp("x", false);
  const before = sim.edges[1].sent;
  run(sim, 0.8);
  assert.ok(sim.edges[1].sent > before, "still sends during detection");
  run(sim, 1);
  const after = sim.edges[1].sent;
  run(sim, 2);
  assert.equal(sim.edges[1].sent, after, "stops once detected");
});

test("kafka lag grows when a consumer dies and drains when it returns", () => {
  const sim = simOf(orderEvents, "-scenario");
  run(sim, 10);
  assert.ok(sim.lagOf("topic", "billing") < 10);
  sim.setUp("billing-a", false);
  run(sim, 20);
  const peak = sim.lagOf("topic", "billing");
  assert.ok(peak > 30, `lag ${peak}`);
  sim.setUp("billing-a", true);
  run(sim, 40);
  assert.ok(sim.lagOf("topic", "billing") < peak / 2);
});

test("scenario steps apply at their time, by phase too", () => {
  const spec = {
    ...chain(),
    scenario: { phases: [{ name: "steady", at: 0 }, { name: "incident", at: 3 }], steps: [{ phase: "incident", after: 1, fail: "b" }, { at: 7, recover: "b" }, { at: 2, set: { c: { emit: 8 } } }] },
  };
  const sim = simOf(spec);
  run(sim, 3.9);
  assert.ok(sim.nodes.get("b").up);
  assert.equal(sim.nodes.get("c").emit, 8);
  run(sim, 0.2);
  assert.ok(!sim.nodes.get("b").up);
  run(sim, 3);
  assert.ok(sim.nodes.get("b").up);
});

test("emit curves interpolate", () => {
  const spec = { ...chain(), sim: { seed: 2 } };
  spec.nodes = spec.nodes.map((n) => (n.id === "c" ? { ...n, emit: [[0, 2], [10, 20]] } : n));
  const sim = simOf(spec);
  run(sim, 3);
  const early = sim.nodes.get("c").flow;
  run(sim, 6);
  assert.ok(sim.nodes.get("c").flow > early * 2, `${early} → ${sim.nodes.get("c").flow}`);
});

test("flag rollout splits traffic, kill switch stops it, flag service down freezes config", () => {
  const spec = {
    nodes: [
      { id: "c", kind: "client", emit: 40 },
      { id: "lb", kind: "lb", route: "all" },
      { id: "v1", kind: "service" },
      { id: "v2", kind: "service" },
      { id: "flags", kind: "flags" },
    ],
    edges: [["c", "lb"], { from: "lb", to: "v1", unless: "v2" }, { from: "lb", to: "v2", flag: "v2" }],
    flags: { v2: { rollout: 0.25 } },
    sim: { seed: 5 },
  };
  const sim = simOf(spec);
  run(sim, 50);
  const share = sim.edges[2].sent / (sim.edges[1].sent + sim.edges[2].sent);
  assert.ok(Math.abs(share - 0.25) < 0.03, `share ${share}`);
  sim.setUp("flags", false);
  sim.apply({ flag: "v2", rollout: 1 });
  assert.equal(sim.flags.get("v2").effective, 0.25, "frozen while flag service is down");
  sim.setUp("flags", true);
  assert.equal(sim.flags.get("v2").effective, 1);
  sim.apply({ kill: "v2" });
  const v2 = sim.edges[2].sent;
  run(sim, 2);
  assert.equal(sim.edges[2].sent, v2, "nothing to v2 after the kill");
});

test("kafka brokers: losing a leader pauses its partitions; under min ISR, acks=all refuses writes", () => {
  const spec = {
    nodes: [
      { id: "p", kind: "service", emit: 20 },
      { id: "t", kind: "kafka", partitions: 3, brokers: 3, rf: 3, minIsr: 2, acks: "all", election: 1 },
      { id: "c", kind: "worker", rate: 40 },
    ],
    edges: [{ from: "p", to: "t", sync: true }, { from: "t", to: "c" }],
  };
  const sim = simOf(spec);
  run(sim, 4);
  const log = sim.logs.get("t");
  sim.setUp("t:b0", false);
  assert.equal(sim.readable(log, 0), false, "partition 0 is electing");
  assert.equal(log.parts[0].leader, 1);
  run(sim, 1.2);
  assert.equal(sim.readable(log, 0), true, "elected");
  const before = sim.edges[0].dropped;
  sim.setUp("t:b1", false);
  run(sim, 3);
  assert.ok(sim.edges[0].dropped > before + 10, "writes refused under min ISR");
  sim.setUp("t:b0", true);
  sim.setUp("t:b1", true);
  const after = sim.edges[0].dropped;
  run(sim, 3);
  assert.ok(sim.edges[0].dropped - after < 3, "writes accepted again");
});

test("a CDN with hit 0.9 sends about a tenth of requests to its origin", () => {
  const spec = {
    nodes: [{ id: "u", kind: "client", emit: 40 }, { id: "cdn", kind: "cdn", hit: 0.9 }, { id: "o", kind: "service" }],
    edges: [["u", "cdn"], ["cdn", "o"]],
    sim: { seed: 3 },
  };
  const sim = simOf(spec);
  run(sim, 30);
  const share = sim.edges[1].sent / sim.edges[0].sent;
  assert.ok(Math.abs(share - 0.1) < 0.03, `share ${share}`);
});

test("scenario `set` can change an edge: a breaker added mid-run", () => {
  const spec = { ...chain(), scenario: { steps: [{ at: 1, set: { "a>b": { breaker: true, timeout: 0.1 } } }] } };
  const sim = simOf(spec);
  run(sim, 1.5);
  assert.equal(sim.edges[1].breaker.state, "closed");
  assert.equal(sim.edges[1].timeout, 0.1);
});
