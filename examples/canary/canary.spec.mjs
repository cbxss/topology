// A canary behind a feature flag. The flag service pushes config to the load balancer, which
// sends a rollout fraction of requests to v2. v2 has a bug that only shows at volume; the kill
// switch sends everything back to v1 at once.
export default {
  title: "Canary and kill switch",
  fig: "Fig 6",
  caption:
    "The LB sends each request to checkout-v2 if the new-checkout flag says so (its rollout share), else to v1. Flag changes travel from the flag service (dashed). At 50% v2's error rate shows up; the kill switch sets the rollout to 0 and the errors stop on the next request.",
  sim: { per: 40, seed: 6 },
  labels: "rate",
  grid: [140, 70],
  flags: { "new-checkout": { rollout: 0 } },
  nodes: [
    { id: "users", kind: "client", emit: 12, at: [0, 0.5] },
    { id: "lb", kind: "lb", route: "all", label: "lb", at: [1, 0.5] },
    { id: "v1", kind: "service", replicas: 3, label: "checkout-v1", at: [2, 0] },
    { id: "v2", kind: "service", replicas: 1, label: "checkout-v2", at: [2, 1] },
    { id: "db", kind: "db", label: "orders-db", at: [3, 0.5] },
    { id: "flags", kind: "flags", label: "flagd", at: [1, -0.7] },
  ],
  edges: [
    ["users", "lb"],
    { from: "lb", to: "v1", unless: "new-checkout" },
    { from: "lb", to: "v2", flag: "new-checkout" },
    ["v1", "db"],
    ["v2", "db"],
    { from: "flags", to: "lb", kind: "config" },
  ],
  scenario: {
    length: 38,
    phases: [
      { name: "v1 only", at: 0 },
      { name: "canary 10%", at: 6 },
      { name: "ramp 50%", at: 14 },
      { name: "kill switch", at: 24 },
    ],
    steps: [
      { at: 1, say: "All traffic goes to checkout-v1. new-checkout is at 0%." },
      { phase: "canary 10%", flag: "new-checkout", rollout: 0.1, say: "new-checkout goes to 10%: one request in ten lands on v2. It looks fine." },
      { phase: "ramp 50%", flag: "new-checkout", rollout: 0.5, say: "Ramped to 50%." },
      { phase: "ramp 50%", after: 2, set: { v2: { errorRate: 0.35 } }, say: "At volume v2's bug appears: about a third of its requests fail (red). Half of all users are on v2." },
      { phase: "kill switch", kill: "new-checkout", say: "Kill switch: rollout to 0. The next request goes to v1 and errors stop." },
    ],
  },
};
