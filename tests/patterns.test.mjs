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

test("crudService upserts and reads; outbox publishes every committed change", async () => {
  const { crudService, outbox } = await import("../kit/patterns.mjs");
  const spec = compose(
    { records: { users: { keys: 30 } } },
    { nodes: [{ id: "app", kind: "client", emit: { "POST /users": 4, "GET /users/:id": 8 } }, { id: "pg", kind: "db", tables: { users: { key: "id" } } }] },
    crudService("users-api", { table: "users", db: "pg" }),
    outbox("cdc", { db: "pg", topic: "users.changes" }),
    link("app", "users-api"),
  );
  const sim = run(spec, 20);
  assert.ok(sim.tablesOf("pg")[0].count > 10, "rows written");
  assert.ok(sim.logs.get("users.changes").appended > 20, "changes published");
  assert.ok(sim.routesOf("users-api").some((r) => r.name === "GET /users/:id"));
});

test("system: namespaces a whole spec, drops its clients, and exposes its ports", async () => {
  const { system } = await import("../kit/patterns.mjs");
  const child = {
    title: "Inventory",
    ports: { in: "api", out: "db" },
    flags: { fast: { rollout: 0.5 } },
    scenario: { steps: [{ at: 1, fail: "db" }] },
    nodes: [
      { id: "web", kind: "client", emit: 5 },
      { id: "api", kind: "service", endpoints: { "GET /stock": { calls: [{ to: "db", op: "select", table: "stock" }] } } },
      { id: "db", kind: "db", tables: { stock: { key: "sku" } } },
      { id: "cache", kind: "cache" },
    ],
    edges: [["web", "api"], { from: "api", to: "db" }, { from: "api", to: "cache", flag: "fast" }],
    groups: [{ id: "data", nodes: ["db", "cache"] }],
    records: { stock: { key: "sku", keys: 20 } },
  };
  const s = system("inv", child);
  assert.deepEqual(s.nodes.map((n) => n.id), ["inv.api", "inv.db", "inv.cache"]);
  assert.equal(s.nodes[0].label, "api", "labels keep the short id");
  assert.equal(s.nodes[0].endpoints["GET /stock"].calls[0].to, "inv.db", "routes stay, call targets move");
  assert.deepEqual(s.edges.map((e) => `${e.from}>${e.to}`), ["inv.api>inv.db", "inv.api>inv.cache"]);
  assert.equal(s.edges[1].flag, "inv.fast");
  assert.ok(s.flags["inv.fast"]);
  assert.deepEqual(s.groups.map((g) => [g.id, g.nodes]), [["inv.data", ["inv.db", "inv.cache"]], ["inv", ["inv.api", "inv.data"]]]);
  assert.equal(s.groups[1].label, "Inventory");
  assert.equal(s.in, "inv.api");
  assert.equal(s.out, "inv.db");
  assert.equal(s.id("cache"), "inv.cache");
  assert.equal(system("inv", child, { shared: ["fast"] }).edges[1].flag, "fast");
  assert.equal(system("inv", child, { keepSources: true }).nodes.length, 4);

  const spec = compose(
    { scenario: { steps: [{ at: 3, fail: s.id("db") }] } },
    { nodes: [{ id: "shop", kind: "client", emit: { "GET /stock": 8 } }] },
    s,
    link("shop", s.in),
  );
  assert.ok(spec.records.stock);
  const sim = run(spec, 6);
  assert.ok(sim.tablesOf("inv.db")[0], "the embedded table answers");
  assert.ok(sim.routesOf("inv.api").some((r) => r.name === "GET /stock"));
});

test("system: `at` keeps the child's own drawing, moved; systems nest", async () => {
  const { system } = await import("../kit/patterns.mjs");
  const leaf = { nodes: [{ id: "c", kind: "client", emit: 2 }, { id: "a", kind: "service" }, { id: "b", kind: "db" }], edges: [["c", "a"], ["a", "b"]] };
  const placed = system("x", leaf, { at: [4, 2] });
  const [a, b] = placed.nodes;
  assert.deepEqual(a.at, [4, 2], "the first kept column lands at `at`");
  assert.equal(b.at[0] - a.at[0], 1, "auto-layout ranks survive");
  assert.ok(system("x", leaf).nodes.every((n) => !n.at), "without `at`, layout is left to the parent");

  const middle = compose({ title: "Middle", ports: { in: "gw" }, nodes: [{ id: "gw", kind: "gateway" }] }, system("leaf", leaf), link("gw", "leaf.a"));
  const outer = system("top", middle);
  assert.deepEqual(outer.nodes.map((n) => n.id), ["top.gw", "top.leaf.a", "top.leaf.b"]);
  assert.deepEqual(outer.groups.map((g) => g.id), ["top.leaf", "top"]);
  assert.deepEqual(quiet(compose({}, { nodes: [{ id: "u", kind: "client", emit: 4 }] }, outer, link("u", outer.in))), []);
});

test("system: routing rules follow their targets into the namespace", async () => {
  const { system } = await import("../kit/patterns.mjs");
  const send = (to) => ({ type: "send", to });
  const s = system("r", {
    nodes: [
      { id: "gw", kind: "gateway", routing: { rules: [{ id: "eu", when: { field: "context.region", eq: "eu" }, action: send("eu") }], fallback: { type: "weighted", targets: [{ to: "eu", weight: 1 }, { to: "us", weight: 3 }] } } },
      { id: "eu", kind: "service", endpoints: { "GET /x": { calls: [{ routing: { rules: [], fallback: send("db") } }] } } },
      { id: "us", kind: "service" },
      { id: "db", kind: "db" },
    ],
    edges: [["gw", "eu"], ["gw", "us"], ["eu", "db"]],
  });
  const [gw, eu] = s.nodes;
  assert.equal(gw.routing.rules[0].action.to, "r.eu");
  assert.deepEqual(gw.routing.fallback.targets.map((t) => t.to), ["r.eu", "r.us"]);
  assert.equal(gw.routing.rules[0].when.field, "context.region", "conditions are left alone");
  const call = eu.endpoints["GET /x"].calls[0];
  assert.equal(call.routing.fallback.to, "r.db");
  assert.ok(!("to" in call), "a routed call gains no `to`");
});

test("system and compose refuse what can't be embedded", async () => {
  const { system } = await import("../kit/patterns.mjs");
  const spec = { ports: { in: "web" }, nodes: [{ id: "web", kind: "client", emit: 1 }, { id: "api", kind: "service" }], edges: [["web", "api"]] };
  assert.throws(() => system("a.b", spec), /prefix/);
  assert.throws(() => system("s", spec), /port in names web/);
  assert.throws(() => modelOf({ ...spec, ports: { in: "nope" } }), /ports.in: unknown node nope/);
  assert.throws(() => compose({ records: { t: { keys: 1 } } }, { records: { t: { keys: 2 } } }), /two different records entries are called "t"/);
});

test("order-ledger: two figures chained through a new consumer group", async () => {
  const { default: spec } = await import("../examples/order-ledger/order-ledger.spec.mjs");
  assert.deepEqual(quiet(spec), []);
  const sim = run(spec, 8);
  assert.equal(sim.logs.get("orders.topic").groups.length, 3, "billing, search and ledger");
  assert.ok(sim.nodes.get("books.ledger").flow > 0, "the ledger consumes orders.v1");
  assert.ok(!spec.nodes.some((n) => n.id === "books.app"), "the ledger's own client is dropped");
});
