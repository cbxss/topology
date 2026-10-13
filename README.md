# Topology

**A Claude skill that draws a distributed system as a small working model of itself.**

Write a spec of nodes, links, zones, rates and a short story. The build lays it out, routes the links, and draws it two ways: **isometric** (servers, disks, brokers and gateways standing on a floor) and **flat 2D** (the same layout as glyphs, reached by a camera morph). A seeded simulation moves requests through it with honest p50/p99 latency:

- queues fill and answer 503
- timeouts trigger retries, and breakers trip
- Kafka partitions fill, cursors chase them, and leaders get re-elected
- DNS keeps sending to a dead region until its TTL expires
- canaries ramp, and a kill switch sends traffic back

The story plays on its own with a timeline and narration. Click a node to inspect routes or tables, follow a request, and use Fail/Restore or F to take over; the readout always says what the model says.

## Quick start

```sh
node scripts/serve.mjs examples                                             # dev server with live reload: http://127.0.0.1:8765/
node scripts/build.mjs examples/order-events/order-events.spec.mjs          # → order-events.html
node scripts/build.mjs examples/order-events/order-events.spec.mjs --light
node scripts/build.mjs examples/order-events/order-events.spec.mjs --check  # run the model and the story headless
node --test tests/*.test.mjs                                                # the model's tests
```

No dependencies: Node 20.10+ for building. Browser checks require Node 22+ (built-in WebSocket) and Chrome or Chromium.

Install as a skill by copying or symlinking this folder to `~/.claude/skills/topology`, then ask Claude for an architecture figure:

```text
/topology show our checkout path: CloudFront → ALB → 3 api pods → Redis (85% hit) → Aurora with a reader, and the outbox to Kafka
```

<details>
<summary><b>More prompts</b>, from the skill's <a href="evals/evals.json">evals</a></summary>

- "I'm writing a blog post about why our Kafka consumers fall behind. Checkout publishes to a 6-partition topic at ~1,200 msgs/s; fulfillment has 3 consumers at ~450/s each, analytics 1 at ~1,500/s. Show what happens to fulfillment's lag when one consumer dies."
- "can you make a diagram of our checkout request path for the design review? browser → cloudfront → ALB → checkout-api (3 pods) → redis (~85% hit), on a miss aurora with one reader, plus stripe (~300 ms). make it something people can poke at"
- "Make a figure for our incident write-up showing how retries turned a slow inventory service into a full outage, and how adding a circuit breaker fixed it." (with the timeout, retries, capacity and slowdown)
- "We run active-active in two regions behind Route 53 (TTL 60s)… I need a 2D diagram for the runbook that shows what a regional failover looks like."
- "Show how we roll out a new checkout behind a feature flag: 5% → 25% → 50%, v2 starting to throw errors at 50%, and us hitting the kill switch."
- "Here's our docker-compose… turn this into one of those animated system figures. I don't have real traffic numbers."
- "just need a static svg of a simple 3-tier app for a slide"
- "My team doesn't get why losing ONE Kafka broker is fine but losing TWO stops all writes (RF 3, min ISR 2, acks=all). Can you make something that shows it?"

Each comes with what a good answer contains, for running with the skill-creator.
</details>

## A spec

```js
export default {
  title: "Order events",
  sim: { per: 40 },
  nodes: [
    { id: "web", kind: "client", emit: 6 },
    { id: "alb", kind: "lb" },
    { id: "orders", kind: "service", replicas: 3, label: "orders-api" },
    { id: "pg", kind: "db", role: "primary" },
    { id: "topic", kind: "kafka", partitions: 3, label: "orders.v1" },
    { id: "billing", kind: "worker", rate: 12 },
  ],
  edges: [
    ["web", "alb"], ["alb", "orders"], ["orders", "pg"], ["orders", "topic"],
    { from: "topic", to: "billing", group: "billing" },
  ],
};
```

Kinds: `client`, `lb`, `gateway`, `service`, `worker`, `cache`, `db`, `storage`, `kafka`, `queue`, `cdn`, `dns`, `external`, `scheduler`, `flags`, `box`.

Behaviour:
- sources, emit curves and schedulers
- routing: `all` with per-edge probability, `roundrobin` with health-check delay, `random`
- awaited sync calls, with model-time latency
- `capacity` + `queue`, timeouts, retries with backoff, circuit breakers
- Kafka partitions, consumer groups, brokers, RF, min ISR, acks, hot partitions
- competing-consumer queues, replication, CDN hit ratios, DNS TTLs
- feature flags with rollouts and kill switches
- scenarios with named phases

Common shapes come as patterns you compose: `region()`, `kafkaTopic()`, `cacheAside()`, `replicatedDb()`, `queueWorkers()`, `canary()`. Browse every kind and pattern, drawn in iso and 2D with the spec that makes it, in the [component catalog](examples/catalog/catalog.html) (`node scripts/catalog.mjs`).

Tool features (the morph, trails, labels, hops and the rest) can be toggled per spec, per build or per URL. Every field is in [`references/spec.md`](references/spec.md).

## Layout

```
SKILL.md                 the skill: when to use it, the workflow, the visual language
references/spec.md       every spec field and exactly what the simulation does
references/craft.md      vocabulary, colour, layout patterns, sizing numbers, adding a kind
references/verify.md     --check, capture, drive, line ends, the review checklist
kit/topo.mjs             layout, routing, iso and flat renderers, label placement, CSS
kit/topo-sim.mjs         stable simulation entry point (implementation in kit/sim/)
kit/topo-live.js         the page runtime
kit/iso.mjs              the drawing core: camera, shaded solids, lines on faces, SVG, the card
scripts/build.mjs        spec → standalone HTML (and --check, --svg)
scripts/capture.mjs …    headless Chrome screenshots, scripted sessions, line-end check (browser.mjs)
kit/topo-story.js        the scenario player; kit/topo-edit.js the drag editor; kit/topo-features.mjs toggles
scripts/serve.mjs        dev server: rebuild per request, SSE reload, ?edit
kit/patterns.mjs         reusable fragments: region, kafkaTopic, cacheAside, replicatedDb, queueWorkers, canary
scripts/catalog.mjs      the component catalog page
examples/                order-events, checkout, retry-storm, failover, kafka-brokers, canary, platform (all patterns), catalog
tests/                   node --test tests/*.test.mjs
evals/evals.json         test prompts and what a good answer contains
agents/openai.yaml       display name and short description for Codex
.github/workflows/ci.yml tests, --check on every example, rebuild, committed pages unchanged
```

## License

MIT. See [LICENSE](LICENSE).

### Endpoint and data stories

- [Orders API](examples/orders-api/orders-api.spec.mjs): route mixes, synthetic records and table inspection.
- [Read your writes](examples/read-your-writes/read-your-writes.spec.mjs): replica lag and stale reads.
- [Idempotent retries](examples/idempotent-retries/idempotent-retries.spec.mjs): committed writes, timeouts, conflicts and upserts.
- [Lost updates](examples/lost-update/lost-update.spec.mjs): hot-key races and row locks.

The overview stays compact; click for details, choose a route to filter traffic, then follow a request for its span timeline. These examples model illustrative workloads, not a SQL database or exactly-once side effects.

To author a figure, start with [the spec reference and runnable recipe](references/spec.md#minimal-endpointtable-recipe), choose an example from [the skill](SKILL.md), and run the [verification workflow](references/verify.md). The kit supplies the engine; a new supported story needs only a spec. [Engine maintenance](references/engine.md) documents module ownership and browser packaging.
