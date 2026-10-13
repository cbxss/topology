// A read-heavy request path across two availability zones: a gateway with a rate limit,
// an LB spreading over one API per zone, cache-aside reads (80% hit) and a Postgres primary
// with a synchronous standby in the other zone. Fail an API and the LB routes around it;
// fail the cache and every read goes to Postgres.
export default {
  title: "Checkout reads",
  fig: "Fig 2",
  caption:
    "Clients send ~14 req/s to the gateway, which admits at most 12 req/s (the red packets are 429s). The LB round-robins over the healthy API in each zone. Each API checks Redis first; on a miss (about 1 in 5) it reads Postgres. The primary streams its WAL to a standby in zone b.",
  sim: { per: 100, seed: 11 },
  grid: [118, 64],
  nodes: [
    { id: "clients", kind: "client", at: [0, 0.8], emit: 14 },
    { id: "gw", kind: "gateway", label: "gateway", at: [1, 0.8], capacity: 12, burst: 0.2 },
    { id: "lb", kind: "lb", label: "nlb", at: [2, 0.8] },
    { id: "api-a", kind: "service", replicas: 2, label: "api-a", at: [3, 0] },
    { id: "api-b", kind: "service", replicas: 2, label: "api-b", at: [3, 1.65] },
    { id: "redis", kind: "cache", label: "redis", at: [4.35, -1] },
    { id: "pg", kind: "db", label: "pg-primary", role: "primary", at: [4.35, 0] },
    { id: "standby", kind: "db", label: "pg-standby", role: "standby", at: [4.35, 1.65] },
  ],
  edges: [
    { from: "clients", to: "gw" },
    { from: "gw", to: "lb" },
    { from: "lb", to: "api-a" },
    { from: "lb", to: "api-b" },
    { from: "api-a", to: "redis" },
    { from: "api-b", to: "redis" },
    { from: "api-a", to: "pg", p: 0.2 },
    { from: "api-b", to: "pg", p: 0.2 },
    { from: "pg", to: "standby", kind: "replication" },
  ],
  groups: [
    { id: "az-a", label: "zone a", nodes: ["api-a", "redis", "pg"] },
    { id: "az-b", label: "zone b", nodes: ["api-b", "standby"] },
    { id: "vpc", label: "vpc · us-east-1", nodes: ["az-a", "az-b", "lb"] },
  ],
};
