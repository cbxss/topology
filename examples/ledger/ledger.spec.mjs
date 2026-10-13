// A ledger service sharded over ten Postgres databases: each entry goes to one shard, picked
// at random. It stands alone, and `ports` lets another figure embed it with system() and send
// its own traffic in (see examples/order-ledger).
const SHARDS = 10;
const shards = Array.from({ length: SHARDS }, (_, i) => `shard-${i}`);

export default {
  title: "Ledger",
  fig: "Fig 8",
  caption:
    "Clients post entries to ledger-api (3 pods), which writes each one to one of ten Postgres shards. Fail a shard and the tenth of entries routed to it is refused; the other nine keep taking writes.",
  sim: { per: 40, seed: 5 },
  grid: [124, 70],
  ports: { in: "ledger" },
  scenario: {
    length: 30,
    phases: [{ name: "steady", at: 0 }, { name: "shard lost", at: 10 }, { name: "recovered", at: 20 }],
    steps: [
      { at: 1, say: "Entries spread evenly: each shard takes about a tenth of the writes." },
      { phase: "shard lost", fail: "shard-3", say: "shard-3 dies. The entries routed to it are refused, about 10% of writes; the other shards are unaffected." },
      { phase: "recovered", recover: "shard-3", say: "shard-3 is back and takes its share again." },
    ],
  },
  nodes: [
    { id: "app", kind: "client", emit: 10, at: [0, 1.2] },
    { id: "ledger", kind: "service", replicas: 3, route: "random", label: "ledger-api", at: [1.2, 1.2] },
    ...shards.map((id, i) => ({ id, kind: "db", at: [2.4 + (i >> 1) * 1.1, (i % 2) * 2.4] })),
  ],
  edges: [["app", "ledger"], ...shards.map((id) => ({ from: "ledger", to: id, axis: "y", bend: 0.5 }))],
};
