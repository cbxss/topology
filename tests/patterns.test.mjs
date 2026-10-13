import test from "node:test";
import assert from "node:assert/strict";
import { canary, cacheAside, compose, kafkaTopic, link, queueWorkers, region, replicatedDb } from "../kit/patterns.mjs";
import { modelOf, simSpec } from "../kit/topo.mjs";
import { createSim } from "../kit/topo-sim.mjs";
import { check } from "../scripts/page.mjs";

const run = (spec, seconds = 10) => {
  const sim = createSim(simSpec(modelOf(spec)));
  for (let i = 0; i < seconds * 60; i++) sim.step(1 / 60);
  return sim;
};
const quiet = (spec) => check(spec, { seconds: 10, log: () => {} }).warnings;

test("kafkaTopic: one worker per consumer, wired with its group", () => {
  const f = kafkaTopic("t", { partitions: 4, groups: { a: { consumers: 2, rate: 9 }, b: { consumers: 1 } } });
  assert.deepEqual(f.out, ["t-a-1", "t-a-2", "t-b"]);
  assert.deepEqual(f.edges.map((e) => e.group), ["a", "a", "b"]);
  const sim = run(compose({}, { nodes: [{ id: "p", kind: "service", emit: 6 }] }, f, link("p", f.in)));
  assert.equal(sim.logs.get("t").groups.length, 2);
  assert.ok(sim.nodes.get("t-b").flow > 0, "group b consumes");
});

test("region: entry and exit, a region plate, cache-aside and a replica", () => {
  const r = region("eu", { cache: { hit: 0.75 }, replica: true });
  assert.equal(r.in, "eu-lb");
  assert.equal(r.out, "eu-api");
  assert.equal(r.groups[0].region, true);
  assert.equal(r.edges.find((e) => e.to === "eu-db").p, 0.25);
  assert.ok(r.edges.some((e) => e.kind === "replication"));
  const spec = compose({}, { nodes: [{ id: "u", kind: "client", emit: 10 }] }, r, link("u", r.in));
  assert.deepEqual(quiet(spec), []);
});

test("cacheAside, replicatedDb, queueWorkers and canary compose and run", () => {
  const spec = compose(
    {},
    { nodes: [{ id: "u", kind: "client", emit: 12 }, { id: "lb", kind: "lb", route: "all" }, { id: "pg", kind: "db" }] },
    link("u", "lb"),
    canary("co", { router: "lb", rollout: 0.5 }),
    cacheAside("co-v1", { db: "pg", hit: 0.9 }),
    link("co-v2", "pg"),
    replicatedDb("archive", { replicas: 2 }),
    link("pg", "archive", { kind: "async" }),
    queueWorkers("q", { workers: 2, rate: 30 }),
    link("co-v1", "q"),
  );
  assert.ok(spec.flags.co);
  const sim = run(spec, 20);
  assert.ok(sim.nodes.get("co-v2").flow > 0, "the canary gets traffic");
  assert.ok(sim.nodes.get("archive-replica-2").flow > 0, "replication reaches the second replica");
  assert.ok(sim.nodes.get("q-worker-1").flow > 0, "workers consume");
});

test("compose rejects duplicate ids and needs the ids patterns depend on", () => {
  assert.throws(() => compose({}, region("x"), region("x")), /two nodes are called "x-lb"/);
  assert.throws(() => cacheAside("api", {}), /needs `db`/);
  assert.throws(() => canary("c", {}), /needs `router`/);
});
