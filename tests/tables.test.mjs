import test from "node:test";
import assert from "node:assert/strict";
import { createSim } from "../kit/topo-sim.mjs";
import { modelOf, simSpec } from "../kit/topo.mjs";

const simOf = (spec, layers = []) => createSim(simSpec(modelOf(spec, layers)));
const run = (sim, seconds) => {
  for (let i = 0; i < seconds * 60; i++) sim.step(1 / 60);
  return sim;
};
const orders = (calls, extra = {}) => ({
  records: { orders: { key: "orderId", keys: 20 } },
  nodes: [
    { id: "app", kind: "client", emit: { "POST /orders": 8 } },
    { id: "api", kind: "service", endpoints: { "POST /orders": { ms: 5, calls } } },
    { id: "pg", kind: "db", tables: { orders: { key: "orderId" } }, ...(extra.pg || {}) },
    { id: "replica", kind: "db", role: "replica", ...(extra.replica || {}) },
  ],
  edges: [["app", "api"], ["api", "pg"], ["api", "replica"], { from: "pg", to: "replica", kind: "replication" }],
  sim: { seed: 9 },
});

test("upsert inserts a row, then bumps its version", () => {
  const sim = run(simOf(orders([{ to: "pg", op: "upsert", table: "orders" }])), 15);
  const [t] = sim.tablesOf("pg");
  assert.ok(t.count > 10 && t.count <= 20, `rows ${t.count}`);
  assert.ok(t.rows.some((r) => r.version > 1), "some rows updated");
  assert.equal(sim.latencyOf("app").failed, 0);
});

test("insert on an existing key is a conflict and fails the request", () => {
  const sim = run(simOf(orders([{ to: "pg", op: "insert", table: "orders" }])), 15);
  assert.ok(sim.tablesOf("pg")[0].conflicts > 0);
  assert.ok(sim.latencyOf("app").failed > 0);
});

test("replicas apply WAL entries; with lag, reading your own write from the replica is stale", () => {
  const calls = [{ to: "pg", op: "upsert", table: "orders" }, { to: "replica", op: "select", table: "orders", then: true }];
  const fresh = run(simOf(orders(calls)), 15);
  const lagged = run(simOf(orders(calls, { replica: { lag: 1.5 } })), 15);
  assert.ok(fresh.tablesOf("replica")[0].count > 5, "replica has rows");
  assert.ok(lagged.tablesOf("replica")[0].stale > fresh.tablesOf("replica")[0].stale, `stale ${lagged.tablesOf("replica")[0].stale} vs ${fresh.tablesOf("replica")[0].stale}`);
  assert.ok(lagged.tablesOf("replica")[0].behind >= 1, "replica behind the primary");
});

test("a write-then-read request costs both stages", () => {
  const one = run(simOf(orders([{ to: "pg", op: "upsert", table: "orders" }])), 10).latencyOf("app").p50;
  const two = run(simOf(orders([{ to: "pg", op: "upsert", table: "orders" }, { to: "pg", op: "select", table: "orders", then: true }])), 10).latencyOf("app").p50;
  assert.ok(two > one + 2, `${one} → ${two}`);
});

test("unlocked read-modify-write loses updates on a hot key; row locks queue writers instead", () => {
  const hot = (pg) => ({ ...orders([{ to: "pg", op: "rmw", table: "orders" }], { pg }), records: { orders: { keys: 2 } } });
  const loose = run(simOf(hot({ ms: 150 })), 15);
  const locked = run(simOf(hot({ ms: 150, locks: true })), 15);
  assert.ok(loose.tablesOf("pg")[0].lost > 0, "lost updates without locks");
  assert.equal(locked.tablesOf("pg")[0].lost, 0, "none with locks");
  assert.ok(locked.tablesOf("pg")[0].lockWaits > 0, "writers wait");
});

test("tables feature off: no store, plain traffic", () => {
  const sim = run(simOf(orders([{ to: "pg", op: "upsert", table: "orders" }]), ["-tables"]), 5);
  assert.equal(sim.tablesOf("pg").length, 0);
  assert.ok(sim.nodes.get("pg").flow > 0);
});
