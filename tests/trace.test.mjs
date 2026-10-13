import test from "node:test";
import assert from "node:assert/strict";
import { createSim } from "../kit/topo-sim.mjs";
import { modelOf, simSpec } from "../kit/topo.mjs";
import { traceText } from "../scripts/page.mjs";
import spec from "../examples/orders-api/orders-api.spec.mjs";

const follow = (endpoint) => {
  const sim = createSim(simSpec(modelOf(spec)));
  for (let i = 0; i < 300; i++) sim.step(1 / 60);
  sim.follow(endpoint);
  for (let i = 0; i < 3600 && !(sim.tracing.done && sim.tracing.spans.every((s) => s.done)); i++) sim.step(1 / 60);
  return sim.tracing;
};

test("following a write records every hop, with the table op and the async children", () => {
  const t = follow("POST /orders");
  assert.ok(t.done);
  const nodes = t.spans.map((s) => s.node);
  for (const id of ["app", "gw", "orders", "pg", "replica", "events"]) assert.ok(nodes.includes(id), `span at ${id}`);
  const pg = t.spans.find((s) => s.node === "pg");
  assert.match(pg.label, /^upsert orders\/\d+ → (insert|update) v\d+$/);
  assert.ok(t.spans.find((s) => s.node === "replica").async, "the replica applies asynchronously");
});

test("spans nest and add up: a child starts inside its parent, the root is the request's latency", () => {
  const t = follow("POST /orders");
  for (const s of t.spans) if (s.parent != null && !s.async) {
    const p = t.spans[s.parent];
    assert.ok(s.start >= p.start && s.start + s.total <= p.start + p.total + 0.5, `${s.node} inside ${p.node}`);
  }
  const root = t.spans[0];
  const orders = t.spans.find((s) => s.node === "orders");
  assert.ok(root.total >= orders.total, "the root covers the service");
});

test("--trace prints the same tree as text", () => {
  const lines = traceText(spec, "GET /orders/:id");
  assert.match(lines[0], /^GET \/orders\/:id: /);
  assert.ok(lines.some((l) => l.includes("redis")));
});
