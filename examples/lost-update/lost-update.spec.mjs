export default {
  title: "Lost updates", fig: "Fig 11",
  caption: "Illustrative workload: 8 read-modify-write requests/s share two hot keys; database work takes 150 ms. Without row locks, overlapping writers read the same version and overwrite intervening changes. Row locks serialize writers on each key, trading lost updates for waiting. The model detects version races; it does not execute SQL or compute a numeric balance.",
  sim: { seed: 9 },
  records: { counters: { key: "counterId", keys: 2 } },
  nodes: [
    { id: "app", kind: "client", emit: { "PATCH /counter": 8 } },
    { id: "api", kind: "service", endpoints: { "PATCH /counter": { calls: [{ to: "pg", op: "rmw", table: "counters" }] } } },
    { id: "pg", kind: "db", ms: 150, tables: { counters: { key: "counterId" } } },
  ],
  edges: [["app", "api"], ["api", "pg"]],
  scenario: { length: 36, phases: [{ name: "unlocked", at: 0 }, { name: "row locks", at: 14 }, { name: "recovered", at: 26 }], steps: [
    { at: 1, inspect: "pg", say: "Watch lost updates: overlapping writers read an old version before another writer commits." },
    { at: 14, set: { pg: { locks: true } }, say: "Enable row locks. Existing unlocked work drains, then writers wait for the key instead of overwriting each other." },
    { at: 26, set: { pg: { ms: 4 } }, say: "Shorter transactions drain the waiters. Locks remain enabled and lost updates stay at zero." },
  ] },
};
