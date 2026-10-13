// Orders land in Postgres and fan out through a Kafka topic to two consumer groups.
// Billing runs two consumers at 8 rec/s; with 3 partitions one of them owns two (~6.7 rec/s), so the group has little headroom:
// fail one billing worker and the group rebalances, then lag climbs.
export default {
  title: "Order events",
  fig: "Fig 1",
  caption:
    "Clients call orders-api through the load balancer. Each order is written to Postgres, replicated to a read replica, and published to orders.v1 (3 partitions). Billing (2 consumers) and the search indexer (1 consumer) read the topic as separate consumer groups, each with its own committed offset: the white and blue cursors on each partition.",
  sim: { per: 40, seed: 3 },
  scenario: {
    length: 40,
    phases: [
      { name: "steady", at: 0 },
      { name: "consumer lost", at: 10 },
      { name: "recovery", at: 22 },
    ],
    steps: [
      { at: 1, say: "Orders flow in at ~400/s. Billing and the search indexer read orders.v1 as separate consumer groups; both keep up." },
      { phase: "consumer lost", fail: "billing-a", say: "billing-a crashes. The billing group pauses to rebalance, then billing-b owns all three partitions: 8 rec/s against ~10 coming in." },
      { phase: "consumer lost", after: 5, say: "Billing lag climbs (bright cells, the white cursor falls behind). Search is unaffected: its blue cursor stays at the head." },
      { phase: "recovery", recover: "billing-a", say: "billing-a returns, the group rebalances again and the backlog drains." },
    ],
  },
  nodes: [
    { id: "web", kind: "client", emit: 6 },
    { id: "mobile", kind: "client", emit: 4 },
    { id: "alb", kind: "lb" },
    { id: "orders", kind: "service", replicas: 3, label: "orders-api" },
    { id: "pg", kind: "db", label: "postgres", role: "primary" },
    { id: "replica", kind: "db", label: "pg-replica", role: "replica" },
    { id: "topic", kind: "kafka", partitions: 3, label: "orders.v1" },
    { id: "billing-a", kind: "worker", rate: 8, label: "billing-a" },
    { id: "billing-b", kind: "worker", rate: 8, label: "billing-b" },
    { id: "indexer", kind: "worker", rate: 14, label: "indexer" },
  ],
  edges: [
    { from: "web", to: "alb" },
    { from: "mobile", to: "alb" },
    { from: "alb", to: "orders" },
    { from: "orders", to: "pg" },
    { from: "pg", to: "replica", kind: "replication" },
    { from: "orders", to: "topic" },
    { from: "topic", to: "billing-a", group: "billing" },
    { from: "topic", to: "billing-b", group: "billing" },
    { from: "topic", to: "indexer", group: "search" },
  ],
};
