import test from "node:test";
import assert from "node:assert/strict";
import { modelOf, simSpec } from "../kit/topo.mjs";
import { createSim } from "../kit/topo-sim.mjs";
import { buildPage, check } from "../scripts/page.mjs";
import { cacheAside } from "../kit/patterns.mjs";
import spec from "../examples/data-stores/data-stores.spec.mjs";

test("product components retain drawing identity and reuse cache/table behavior", () => {
  const model = modelOf(spec);
  assert.equal(model.byId.get("sessions").kind, "redis");
  assert.equal(model.byId.get("cache").kind, "elasticache");
  assert.equal(model.byId.get("items").kind, "dynamodb");
  const sim = createSim(simSpec(model));
  for (let i = 0; i < 1200; i++) sim.step(1 / 60);
  assert.equal(sim.nodes.get("sessions").kind, "cache");
  assert.equal(sim.nodes.get("cache").ms, 0.4);
  assert.ok(sim.nodes.get("cache").flow > 0);
  const table = sim.tablesOf("items")[0];
  assert.ok(table.count > 0);
  const row = sim.recordOf("items", "items", table.rows[0].key);
  assert.deepEqual(Object.keys(row.row.fields), ["name", "stock", "available"]);
  for (const theme of ["dark", "light"]) {
    const { html } = buildPage(spec, { theme });
    for (const kind of ["redis", "elasticache", "dynamodb"]) {
      assert.equal(html.split(`data-kind="${kind}"`).length - 1, 2, `${kind} in both views`);
    }
  }
  assert.deepEqual(check(spec, { log: () => {} }).warnings, []);
});

test("cacheAside accepts product components without changing routing", () => {
  for (const kind of ["cache", "redis", "elasticache"]) {
    const fragment = cacheAside("api", { db: "db", hit: 0.75, kind });
    assert.equal(fragment.nodes[0].kind, kind);
    assert.equal(fragment.edges[1].p, 0.25);
  }
  assert.throws(() => cacheAside("api", { db: "db", kind: "dynamodb" }), /kind must/);
});
