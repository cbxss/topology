export default {
  title: "Idempotent retries", fig: "Fig 10",
  caption: "Illustrative rates: 2 requests/s over 100 order keys. A 400 ms database write exceeds the 200 ms timeout: it commits, but the caller retries. INSERT then conflicts on the same key. Switching to UPSERT keeps one row per key; restoring latency lets callers succeed. This is idempotent row content, not exactly-once execution: each upsert still increments the version and WAL, and external side effects are not deduplicated.",
  sim: { seed: 12, jitter: false },
  records: { orders: { key: "orderId", keys: 100, fields: { status: ["new"] } } },
  nodes: [
    { id: "app", kind: "client", emit: { "POST /orders": 2 } },
    { id: "api", kind: "service", endpoints: {
      "POST /orders": { calls: [{ to: "pg", op: "insert", table: "orders" }] },
      "PUT /orders": { calls: [{ to: "pg", op: "upsert", table: "orders" }] },
    } },
    { id: "pg", kind: "db", tables: { orders: { key: "orderId", show: 6 } } },
  ],
  edges: [["app", "api"], { from: "api", to: "pg", timeout: 0.2, retries: 1, backoff: 0.05 }],
  scenario: { length: 48, phases: [{ name: "insert", at: 0 }, { name: "ambiguous timeout", at: 8 }, { name: "upsert", at: 22 }, { name: "recovered", at: 36 }], steps: [
    { at: 1, inspect: "pg", say: "INSERT creates a row. Reusing an existing key is a conflict." },
    { at: 8, set: { pg: { ms: 400 } }, say: "The write commits, but its reply exceeds the timeout. The retry reuses the same key and conflicts." },
    { at: 12, follow: "POST /orders", say: "Follow a request: a timeout does not mean that its write was rolled back." },
    { at: 22, follow: false, inspect: "pg", set: { app: { emit: { "PUT /orders": 2 } } }, say: "UPSERT preserves one row per key. Repeated writes still create versions; the timeout remains." },
    { at: 36, set: { pg: { ms: 4 } }, say: "Latency recovers. Upserts now succeed without retries; conflicts have stopped." },
  ] },
};
