// One service, two routes: POST /orders upserts the order into Postgres and publishes an event;
// GET /orders/:id checks Redis and probabilistically reads the replica.
export default {
  title: "Orders API",
  fig: "Fig 8",
  caption:
    "Illustrative workload: the app sends ~3 writes and ~12 reads a second over 40 orders. POST /orders upserts the order into Postgres (insert the first time, then a new version) and publishes it; the primary streams its WAL to a replica. GET /orders/:id checks Redis and independently samples a replica read (about 1 in 6). Click orders-api for each route's numbers, or either database then a row to inspect every saved field. Field values are synthetic and sampled independently on each request.",
  sim: { seed: 8 },
  grid: [140, 72],
  records: { orders: { key: "orderId", keys: 40, fields: {
    customerId: [201, 202, 203, 204],
    status: ["new", "paid", "shipped"],
    item: ["Notebook", "Desk lamp", "Travel mug"],
    quantity: [1, 2, 3],
    totalCents: [2400, 4800, 7200],
    currency: ["USD"],
    shippingCity: ["Portland", "Seattle", "Austin"],
  } } },
  nodes: [
    { id: "app", kind: "client", at: [0, 0.75], emit: { "POST /orders": 3, "GET /orders/:id": 12 } },
    { id: "gw", kind: "gateway", label: "gateway", at: [1, 0.75] },
    {
      id: "orders",
      kind: "service",
      replicas: 2,
      label: "orders-api",
      at: [2, 0.75],
      endpoints: {
        "POST /orders": { ms: 9, calls: [{ to: "pg", op: "upsert", table: "orders" }, { to: "events" }] },
        "GET /orders/:id": { ms: 2, calls: [{ to: "redis" }, { to: "replica", op: "select", table: "orders", p: 0.16 }] },
      },
    },
    { id: "redis", kind: "cache", at: [3.3, -0.45] },
    { id: "pg", kind: "db", role: "primary", label: "postgres", at: [3.3, 0.55], tables: { orders: { key: "orderId", show: 6 } } },
    { id: "replica", kind: "db", role: "replica", label: "pg-replica", at: [3.3, 1.6] },
    { id: "events", kind: "kafka", partitions: 2, label: "orders.v1", at: [3.5, 2.65] },
  ],
  edges: [["app", "gw"], ["gw", "orders"], ["orders", "redis"], ["orders", "pg"], ["orders", "replica"], ["orders", "events"], { from: "pg", to: "replica", kind: "replication" }],
};
