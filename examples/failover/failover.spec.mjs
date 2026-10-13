// Active-active across two regions behind DNS. When region a's load balancer dies, DNS keeps
// handing out its address until the record's TTL runs out; then everything moves to region b.
export default {
  title: "Region failover",
  fig: "Fig 4",
  caption:
    "DNS round-robins clients over two regions. Each region has its own load balancer, API and Postgres; region a's primary streams to region b over a 70 ms link. DNS health checks only take effect when cached answers expire (TTL 4 s), so a regional outage costs a few seconds of errors before traffic moves.",
  sim: { per: 50, seed: 9 },
  labels: "rate",
  grid: [120, 62],
  nodes: [
    { id: "users", kind: "client", emit: 12, at: [0, 1] },
    { id: "dns", kind: "dns", label: "route53", ttl: 4, at: [1, 1] },
    { id: "lb-a", kind: "lb", label: "alb-a", at: [2, 0] },
    { id: "api-a", kind: "service", replicas: 2, label: "api-a", at: [3, 0] },
    { id: "db-a", kind: "db", label: "pg-a", role: "primary", at: [4, 0] },
    { id: "lb-b", kind: "lb", label: "alb-b", at: [2, 2.2] },
    { id: "api-b", kind: "service", replicas: 2, label: "api-b", at: [3, 2.2] },
    { id: "db-b", kind: "db", label: "pg-b", role: "replica", at: [4, 2.2] },
  ],
  edges: [
    ["users", "dns"],
    ["dns", "lb-a"],
    ["dns", "lb-b"],
    ["lb-a", "api-a"],
    ["lb-b", "api-b"],
    ["api-a", "db-a"],
    { from: "api-b", to: "db-b" },
    { from: "db-a", to: "db-b", kind: "replication", ms: 70 },
  ],
  groups: [
    { id: "us-east", label: "us-east-1", region: true, nodes: ["lb-a", "api-a", "db-a"] },
    { id: "us-west", label: "us-west-2", region: true, nodes: ["lb-b", "api-b", "db-b"] },
  ],
  scenario: {
    length: 36,
    phases: [
      { name: "active-active", at: 0 },
      { name: "us-east down", at: 8 },
      { name: "failed over", at: 14 },
      { name: "restored", at: 26 },
    ],
    steps: [
      { at: 1, say: "DNS splits ~600 req/s across both regions. Every write in us-east also crosses to us-west's replica." },
      { phase: "us-east down", fail: "lb-a", say: "us-east's load balancer goes dark. Clients still hold DNS answers pointing at it: their requests are refused (red)." },
      { phase: "failed over", say: "The TTL has run out; DNS answers only with us-west, which now carries everything." },
      { phase: "restored", recover: "lb-a", say: "us-east is back and DNS returns it to the rotation." },
    ],
  },
};
