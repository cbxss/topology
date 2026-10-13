// A whole platform built from patterns (kit/patterns.mjs): a CDN in front of one region with a
// read cache and a replica, publishing orders to Kafka for two consumer groups, plus a job queue.
// The story fails the cache, then a billing consumer.
import { compose, kafkaTopic, link, queueWorkers, region } from "../../kit/patterns.mjs";

const us = region("us", { label: "us-east-1", cache: { hit: 0.85 }, replica: true, at: [2, 0.6] });
const orders = kafkaTopic("orders", { partitions: 3, groups: { billing: { consumers: 2, rate: 3.4 }, search: { consumers: 1, rate: 16 } }, at: [5.1, 0.6] });
const jobs = queueWorkers("jobs", { workers: 2, rate: 5, at: [5.1, 3.4] });

export default compose(
  {
    title: "Platform",
    fig: "Fig 7",
    caption:
      "Built from patterns: region() gives the load balancer, API, cache-aside reads (85% hit) and a primary with a replica on a region plate; kafkaTopic() the topic and its two consumer groups; queueWorkers() the job queue. Fail the cache and every read goes to Postgres; fail a billing consumer and the group rebalances while lag climbs.",
    sim: { per: 40, seed: 12 },
    grid: [124, 70],
    labels: "rate",
    nodes: [
      { id: "users", kind: "client", emit: 10, at: [0, 0.6] },
      { id: "cdn", kind: "cdn", hit: 0.6, at: [1, 0.6] },
    ],
    scenario: {
      length: 50,
      phases: [
        { name: "steady", at: 0 },
        { name: "cache down", at: 8 },
        { name: "consumer lost", at: 18 },
        { name: "recovered", at: 30 },
      ],
      steps: [
        { at: 1, say: "The CDN answers 60% of requests; the rest reach the API, which reads through Redis (85% hit) and publishes every order to Kafka and a job to the queue." },
        { phase: "cache down", fail: "us-cache", say: "Redis dies. Its calls are refused, so those requests fail; reads that missed still reach Postgres." },
        { phase: "consumer lost", recover: "us-cache", fail: "orders-billing-1", say: "Redis is back. Now a billing consumer dies: the group rebalances and billing lag climbs." },
        { phase: "recovered", recover: "orders-billing-1", say: "Both consumers are back and the backlog drains." },
      ],
    },
  },
  us,
  orders,
  jobs,
  link("users", "cdn"),
  link("cdn", us.in),
  link(us.out, [orders.in, jobs.in]),
);
