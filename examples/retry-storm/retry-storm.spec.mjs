// A dependency slows down; callers time out and retry; retries triple the load on the thing
// that is already struggling. A circuit breaker turns the storm into fast failures and lets
// the dependency recover.
export default {
  title: "Retry storm",
  fig: "Fig 3",
  caption:
    "inventory admits 14 req/s with a buffer of 6. orders-api calls it with a 150 ms timeout and 3 retries. When inventory slows past the timeout, every call times out and is retried: the load it sees triples, its buffer fills and it starts answering 503. A breaker on the call stops the amplification.",
  sim: { per: 20, seed: 4 },
  labels: "rate",
  grid: [150, 80],
  nodes: [
    { id: "clients", kind: "client", emit: 9, at: [0, 0] },
    { id: "gw", kind: "gateway", label: "gateway", at: [1, 0] },
    { id: "orders", kind: "service", replicas: 2, label: "orders-api", at: [2, 0] },
    { id: "inventory", kind: "service", label: "inventory", ms: 25, capacity: 14, queue: 6, burst: 0.1, at: [3, 0] },
    { id: "pg", kind: "db", label: "inventory-db", at: [4, 0] },
  ],
  edges: [
    ["clients", "gw"],
    ["gw", "orders"],
    { from: "orders", to: "inventory", timeout: 0.15, retries: 3, backoff: 0.05 },
    ["inventory", "pg"],
  ],
  scenario: {
    length: 50,
    phases: [
      { name: "steady", at: 0 },
      { name: "slowdown", at: 8 },
      { name: "breaker on", at: 20 },
      { name: "fixed", at: 30 },
    ],
    steps: [
      { at: 1, say: "~180 req/s. inventory answers in ~25 ms, well inside orders-api's 150 ms timeout." },
      { phase: "slowdown", set: { inventory: { ms: 260 } }, say: "inventory slows to ~260 ms (a bad query plan). Calls start timing out; each one is retried up to 3 times (amber)." },
      { phase: "slowdown", after: 5, say: "The storm: inventory now sees several times the real traffic, its buffer fills (amber cells) and it answers 503. Almost nothing succeeds." },
      { phase: "breaker on", set: { "orders>inventory": { breaker: { errors: 0.5, min: 6, window: 2, open: 2 } } }, say: "A breaker on the call. It trips open (red port): calls fail fast without touching inventory, so its load collapses." },
      { phase: "fixed", set: { inventory: { ms: 25 } }, say: "inventory is fixed. The breaker half-opens (amber), its trial call succeeds, and it closes." },
    ],
  },
};
