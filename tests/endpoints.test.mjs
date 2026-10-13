import test from "node:test";
import assert from "node:assert/strict";
import { createSim } from "../kit/topo-sim.mjs";
import { modelOf, simSpec } from "../kit/topo.mjs";
import { check } from "../scripts/page.mjs";

const spec = {
  nodes: [
    { id: "app", kind: "client", emit: { "POST /orders": 3, "GET /orders/:id": 9 } },
    {
      id: "api",
      kind: "service",
      endpoints: {
        "POST /orders": { ms: 20, calls: [{ to: "pg" }] },
        "GET /orders/:id": { ms: 2, calls: [{ to: "redis" }, { to: "pg", p: 0.25 }] },
      },
    },
    { id: "redis", kind: "cache" },
    { id: "pg", kind: "db" },
  ],
  edges: [["app", "api"], ["api", "redis"], ["api", "pg"]],
  sim: { seed: 4 },
};
const simOf = (s, layers = []) => createSim(simSpec(modelOf(s, layers)));
const run = (sim, seconds) => {
  for (let i = 0; i < seconds * 60; i++) sim.step(1 / 60);
  return sim;
};

test("an endpoint mix splits traffic by weight and tags every hop", () => {
  const sim = run(simOf(spec), 40);
  const routes = Object.fromEntries(sim.routesOf("api").map((r) => [r.name, r]));
  const share = routes["POST /orders"].rate / (routes["POST /orders"].rate + routes["GET /orders/:id"].rate);
  assert.ok(Math.abs(share - 0.25) < 0.06, `POST share ${share}`);
  assert.ok(sim.routesOf("pg").length === 2, "pg sees both routes");
});

test("each route has its own service time and calls", () => {
  const sim = run(simOf(spec), 40);
  const routes = Object.fromEntries(sim.routesOf("app").map((r) => [r.name, r]));
  assert.ok(routes["POST /orders"].p50 > 15, `POST p50 ${routes["POST /orders"].p50}`);
  assert.ok(routes["GET /orders/:id"].p50 < 6, `GET p50 ${routes["GET /orders/:id"].p50}`);
  // pg: every POST, and a quarter of GETs.
  const pg = Object.fromEntries(sim.routesOf("pg").map((r) => [r.name, r]));
  const getShare = pg["GET /orders/:id"].rate / routes["GET /orders/:id"].rate;
  assert.ok(Math.abs(getShare - 0.25) < 0.08, `GET → pg share ${getShare}`);
});

test("--check prints routes and warns about a call with no edge", () => {
  const broken = { ...spec, nodes: spec.nodes.map((n) => (n.id === "api" ? { ...n, endpoints: { ...n.endpoints, "DELETE /orders": { calls: [{ to: "archive" }] } } } : n)) };
  const lines = [];
  const { warnings } = check(broken, { seconds: 5, log: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.includes("POST /orders") && line.includes("p99")));
  assert.ok(warnings.some((w) => w.includes("DELETE /orders on api calls archive")));
});

test("endpoints feature off: one total rate, plain routing", () => {
  const sim = run(simOf(spec, ["-endpoints"]), 10);
  assert.equal(sim.routesOf("api").length, 0);
  assert.equal(sim.nodes.get("app").emit, 12);
  assert.ok(sim.nodes.get("redis").flow > 0 && sim.nodes.get("pg").flow > 0);
});
