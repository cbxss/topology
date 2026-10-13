// One service, two routes: POST /orders writes through to Postgres and publishes an event;
// GET /orders/:id reads through Redis and falls back to Postgres on a miss.
export default {
  title: "Orders API",
  fig: "Fig 8",
  caption:
    "The app sends ~3 writes and ~12 reads a second. POST /orders upserts the order in Postgres and publishes it; GET /orders/:id checks Redis first and reads Postgres on a miss (about 1 in 6). Click orders-api to see each route's rate and latency, and pick a route to follow only its packets.",
  sim: { per: 20, seed: 8 },
  grid: [140, 72],
  nodes: [
    { id: "app", kind: "client", at: [0, 0.5], emit: { "POST /orders": 3, "GET /orders/:id": 12 } },
    { id: "gw", kind: "gateway", label: "gateway", at: [1, 0.5] },
    {
      id: "orders",
      kind: "service",
      replicas: 2,
      label: "orders-api",
      at: [2, 0.5],
      endpoints: {
        "POST /orders": { ms: 9, calls: [{ to: "pg", op: "upsert", table: "orders" }, { to: "events" }] },
        "GET /orders/:id": { ms: 2, calls: [{ to: "redis" }, { to: "pg", op: "select", table: "orders", p: 0.16 }] },
      },
    },
    { id: "redis", kind: "cache", at: [3.2, -0.5] },
    { id: "pg", kind: "db", role: "primary", label: "postgres", at: [3.2, 0.5] },
    { id: "events", kind: "kafka", partitions: 2, label: "orders.v1", at: [3.4, 1.6] },
  ],
  edges: [["app", "gw"], ["gw", "orders"], ["orders", "redis"], ["orders", "pg"], ["orders", "events"]],
};
