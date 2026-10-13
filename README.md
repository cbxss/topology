# Topology

**A Claude skill that draws a distributed system as a small working model of itself.**

Write a spec of nodes, links, zones and rates. The build lays it out, routes the links, and draws it two ways: **isometric** (servers, disks, brokers and gateways standing on a floor) and **flat 2D** (the same layout as glyphs). A seeded simulation moves packets through it. Kafka partitions fill with records, consumer cursors chase them, the LB round-robins, the gateway sheds load, replicas follow their primary. Click any node to fail it and watch what happens next: the readout always says what the model says.

## Quick start

```sh
node scripts/build.mjs examples/order-events/order-events.spec.mjs          # → order-events.html
node scripts/build.mjs examples/order-events/order-events.spec.mjs --light
node scripts/build.mjs examples/order-events/order-events.spec.mjs --check  # run the model headless
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

Kinds: `client`, `lb`, `gateway`, `service`, `worker`, `cache`, `db`, `storage`, `kafka`, `queue`, `box`. Behaviour: sources (`emit`), routing (`all` with per-edge probability, `roundrobin`, `random`), sync responses, `capacity` (rate limits), Kafka partitions and consumer groups with rebalancing, competing-consumer queues, replication, failure injection. Every field is in [`references/spec.md`](references/spec.md).

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
examples/                order-events (Kafka, consumer groups), checkout (zones, rate limit, cache-aside)
```

## License

MIT. See [LICENSE](LICENSE).
