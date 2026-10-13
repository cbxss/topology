# Topology

**A Claude skill that draws a distributed system as a small working model of itself.**

Write a spec of nodes, links, zones, rates and a short story. The build lays it out, routes the links, and draws it two ways: **isometric** (servers, disks, brokers and gateways standing on a floor) and **flat 2D** (the same layout as glyphs, reached by a camera morph). A seeded simulation moves requests through it with honest p50/p99 latency:

- queues fill and answer 503
- timeouts trigger retries, and breakers trip
- Kafka partitions fill, cursors chase them, and leaders get re-elected
- DNS keeps sending to a dead region until its TTL expires
- canaries ramp, and a kill switch sends traffic back

The story plays on its own with a timeline and narration. Click any node to take over and break things yourself; the readout always says what the model says.

## Quick start

```sh
node scripts/serve.mjs examples                                             # dev server with live reload: http://127.0.0.1:8765/
node scripts/build.mjs examples/order-events/order-events.spec.mjs          # → order-events.html
node scripts/build.mjs examples/order-events/order-events.spec.mjs --light
node scripts/build.mjs examples/order-events/order-events.spec.mjs --check  # run the model and the story headless
node --test tests/*.test.mjs                                                # the model's tests
```

No dependencies: Node 20.10+ only. Chrome or Chromium for the screenshot checks.

Install as a skill by copying or symlinking this folder to `~/.claude/skills/topology`, then ask Claude for an architecture figure:

```text
/topology show our checkout path: CloudFront → ALB → 3 api pods → Redis (85% hit) → Aurora with a reader, and the outbox to Kafka
```

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

Tool features (the morph, trails, labels, hops and the rest) can be toggled per spec, per build or per URL. Every field is in [`references/spec.md`](references/spec.md).

## Layout

```
SKILL.md                 the skill: when to use it, the workflow, the visual language
references/spec.md       every spec field and exactly what the simulation does
references/craft.md      vocabulary, colour, layout patterns, sizing numbers, adding a kind
references/verify.md     --check, capture, drive, line ends, the review checklist
kit/topo.mjs             layout, routing, iso and flat renderers, label placement, CSS
kit/topo-sim.mjs         the model (pure, seeded; runs in Node and in the page)
kit/topo-live.js         the page runtime
kit/iso.mjs              the drawing core: camera, shaded solids, lines on faces, SVG, the card
scripts/build.mjs        spec → standalone HTML (and --check, --svg)
scripts/capture.mjs …    headless Chrome screenshots, scripted sessions, line-end check (browser.mjs)
kit/topo-story.js        the scenario player; kit/topo-edit.js the drag editor; kit/topo-features.mjs toggles
scripts/serve.mjs        dev server: rebuild per request, SSE reload, ?edit
examples/                order-events, checkout, retry-storm, failover, kafka-brokers, canary
tests/                   node --test tests/*.test.mjs
```

## License

MIT. See [LICENSE](LICENSE).
