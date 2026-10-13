// A topic on three brokers, replication factor 3, min.insync.replicas 2, producers on acks=all.
// Lose one broker: the partitions it led pause for a leader election, then carry on with two
// in-sync replicas. Lose a second: no partition has 2 in-sync replicas, so every write is refused.
export default {
  title: "Brokers and ISR",
  fig: "Fig 5",
  caption:
    "payments.v1 has 3 partitions on 3 brokers (RF 3, min ISR 2) and producers wait for acks=all. Partition 0 is hot: it gets half the writes. Click a broker unit on the plinth to fail it yourself; a dimmed lane is a partition with no leader.",
  sim: { per: 30, seed: 2 },
  labels: "rate",
  nodes: [
    { id: "api", kind: "service", replicas: 3, label: "payments-api", emit: 12 },
    { id: "topic", kind: "kafka", partitions: 3, brokers: 3, rf: 3, minIsr: 2, acks: "all", election: 2.5, skew: [0.5, 0.25, 0.25], label: "payments.v1" },
    { id: "ledger-a", kind: "worker", rate: 11, label: "ledger-a" },
    { id: "ledger-b", kind: "worker", rate: 11, label: "ledger-b" },
  ],
  edges: [
    { from: "api", to: "topic", sync: true, retries: 1, backoff: 0.2 },
    { from: "topic", to: "ledger-a", group: "ledger" },
    { from: "topic", to: "ledger-b", group: "ledger" },
  ],
  scenario: {
    length: 38,
    phases: [
      { name: "healthy", at: 0 },
      { name: "one broker down", at: 8 },
      { name: "two down", at: 18 },
      { name: "restored", at: 27 },
    ],
    steps: [
      { at: 1, say: "Every write waits for all in-sync replicas. Partition 0 takes half the traffic, so ledger-a (which owns it) works hardest." },
      { phase: "one broker down", fail: "topic:b0", say: "Broker 0 dies. Partition 0 loses its leader and pauses for an election (dim lane); writes to it fail and are retried." },
      { phase: "one broker down", after: 4, say: "A new leader is elected. With 2 of 3 replicas in sync, min ISR is still met: writes flow again." },
      { phase: "two down", fail: "topic:b1", say: "Broker 1 dies too. Every partition is down to 1 in-sync replica, under min ISR 2: with acks=all every write is refused." },
      { phase: "restored", recover: ["topic:b0", "topic:b1"], say: "Both brokers return and rejoin the ISR; writes resume and the consumers catch up." },
    ],
  },
};
