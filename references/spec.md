# Spec

A spec is a `.spec.mjs` with a default export (or a `.json` file). `scripts/build.mjs` reads it, `kit/topo.mjs` lays it out and draws it, and `kit/topo-sim.mjs` runs it. A `<name>.layout.json` next to it (written by the serve editor) overrides node positions. Nothing else feeds the figure.

```js
export default {
  title: "Order events",          // card title (top right) and page title
  fig: "Fig 1",                   // top-left corner
  caption: "…",                   // under the card: what it is, the numbers, what to try
  hint: "…",                      // bottom-left corner; default "Hover a node · click to fail it · V for 2D"
  view: "iso",                    // or "flat": which view opens (both are built)
  grid: [150, 90],                // world units per column and row; default from the largest node
  labels: "rate",                 // live rate labels on every edge (default: only edges with `label`, `flag` or `unless`)
  sim: { per: 40, seed: 3 },      // see "Simulation"
  flags: { "new-checkout": { rollout: 0 } },   // feature flags in the modelled system
  scenario: { … },                // the story: phases and steps, see "Scenario"
  features: { trails: false },    // tool features, see "Features"
  keys: [{ mark: "lit", label: "Request" }],   // legend; default is derived from what the spec uses
  nodes: [ … ],
  edges: [ … ],
  groups: [ … ],
};
```

## Nodes

| Field | Meaning |
|---|---|
| `id` | Required, unique. Used by edges, groups, scenario steps and `data-node`. |
| `kind` | `client`, `lb`, `gateway`, `service`, `worker`, `cache`, `db`, `storage`, `kafka`, `queue`, `cdn`, `dns`, `external`, `scheduler`, `flags`, or `box` (anything else). Sets the drawing, the default service time and some routing defaults. |
| `label` | Text on the floor (iso) or under the glyph (flat). Default: `id`. Keep it under ~14 characters. |
| `at` | `[col, row]` in grid units, fractions allowed. If any node lacks `at`, the unplaced ones are auto-ranked. |
| `labelAt` | `front` or `side`: force the iso label spot (default: front, else side if front is hidden). |
| `w`, `d` | Override the footprint in world units. |
| `replicas` | `service`/`worker`: 1–4 stacked units, each with its own LED; requests rotate across them. |
| `role` | `db`: a tag on the top (`primary`, `replica`, `standby`). |
| `sidecar`, `sidecarMs` | A proxy box on the node's side that adds `sidecarMs` (default 1.5) to its service time. |
| **Traffic** | |
| `emit` | Makes the node a source. A number (requests per second, ±40% jitter), a curve `[[t, rate], …]` (linear, looping over the scenario's length), or `{ every, burst }` for a scheduler (`burst` requests every `every` seconds). |
| `route` | How a node forwards: `all` (every outgoing edge, each with its `p`; the default), `roundrobin` (one edge, rotating; default for `lb`, `gateway`, `dns`), `random` (one edge, weighted by `p`). |
| `ms` | Service time in model milliseconds. Defaults by kind: client 0, lb 0.3, gateway 1, service 8, worker 15, cache 0.4, db 4, storage 20, kafka 2, queue 1, cdn 0.5, dns 1, external 120, flags 1, box 5. Each request varies ±40%, and one in 30 takes 2–5× as long. |
| `capacity` | The node serves at most this many requests per second (a token bucket). |
| `burst` | Bucket size as a fraction of `capacity` (default 0.25). |
| `queue` | Buffer length when over capacity (default 0). A full buffer answers 503 at once. Lit amber cells on the node show how full it is. |
| `errorRate` | Fraction of requests the node answers with an error (a bad deploy). |
| `hit` | `cdn`/`cache` with `route: "all"`: only misses (1 − `hit`) go on to its outgoing edges. |
| `detect`, `ttl` | A router's delay before it notices a dead target: `detect` seconds (default 0.6 for `lb`/`gateway`), or `ttl` for `dns` (default 3). Until then it keeps sending there, and those requests are refused. |
| `health` | `false` on a router: it never notices. |
| `rate` | A consumer's pull rate from a log, per second (default 40). Can be set per edge instead. |
| `up` | `false` to start the node failed. |
| **Kafka** | |
| `partitions` | Number of partitions (lanes). Default 3. |
| `brokers`, `rf`, `minIsr`, `acks`, `election` | Brokers (drawn as clickable units), the replication factor (default 3), min in-sync replicas (default 2), `acks: "all"` to refuse writes under min ISR, and election seconds (default 2). See "Simulation". |
| `skew` | Write share per partition, e.g. `[0.5, 0.25, 0.25]` (a hot partition). Default round-robin. |

## Edges

`{ from, to, … }`, or the shorthand `["from", "to"]`.

| Field | Meaning |
|---|---|
| `kind` | `sync` (default between ordinary nodes: solid line, request then response), `async` (default to or from a `kafka`/`queue`: dashed, no response), `replication` (dashed; the source sends one along it for every request it handles), `config` (dotted; drawn, never carries traffic: a flag service pushing config). |
| `sync` | Override whether the target answers. A sync caller waits for the reply before it answers its own caller. |
| `ms` | Network round-trip in model milliseconds, counted twice per call (default `sim.net`, 0.5). |
| `p` | With `route: "all"`: the chance this edge is called per request (cache-aside: `api → db` with `p: 0.2` is an 80% hit ratio). With `route: "random"`: the weight. |
| `timeout` | Seconds of model time the caller waits. A slower reply is discarded (drawn grey) and counted as a failure at exactly `timeout`. |
| `retries`, `backoff` | Resend a failed call up to `retries` times, waiting `backoff · 2^attempt · (0.5–1.5)` seconds (default `backoff` 0.05). Retries are drawn amber. |
| `breaker` | `true` or `{ errors: 0.5, min: 8, window: 2, open: 3 }`: a caller-side circuit breaker. It opens when at least `min` calls in the last `window` seconds failed at a rate of `errors` or more. While open, calls fail at once without being sent. After `open` seconds it half-opens: one trial call, and success closes it. The port ring at the caller shows the state (red open, amber half-open). |
| `flag`, `unless` | Take this edge only when the named flag is on for this request (`flag`), or only when it's off (`unless`). A pair of edges, one `flag` and one `unless`, is a canary split. |
| `group` | On an edge out of a `kafka` node: the consumer group of the target (default `"default"`). |
| `key` | On an edge into a `kafka` node: a fixed partition key (hashed). |
| `rate` | A per-consumer pull rate that overrides the target's `rate`. |
| `label` | A fixed label on the edge. |
| `bend`, `via`, `axis` | Routing: where the elbow sits (0–1), explicit world-unit waypoints, or which faces to use (`x`/`y`). |
| `back` | `true` to ignore this edge for auto-ranking. |

## Patterns

`kit/patterns.mjs` has reusable fragments for the shapes that come up again and again. Each pattern returns `{ nodes, edges, groups, flags, in, out }`: `in` is the node to send traffic into, and `out` is the node or nodes it hands on from. `compose(meta, ...fragments)` joins fragments into a spec (`meta` is the rest of the spec: title, sim, scenario, extra nodes) and rejects duplicate ids. `link(from, to, options)` adds an edge, or one edge per pair when either side is a list.

| Pattern | Makes | `in` / `out` |
|---|---|---|
| `kafkaTopic(id, { partitions, brokers, rf, minIsr, acks, skew, election, groups: { name: { consumers, rate, label } } })` | A topic and one worker per consumer, each edge carrying its `group`. Consumers are `<id>-<group>-<n>`, or `<id>-<group>` for a single consumer. | the topic / the consumers |
| `region(id, { label, api, db, cache: { hit }, replica: { label, ms } })` | `<id>-lb` → `<id>-api` → `<id>-db` on a `region: true` plate; optionally `<id>-cache` (cache-aside) and `<id>-replica` (replication). `api` and `db` are merged into those nodes. | the LB / the API |
| `cacheAside(service, { db, hit, id, label })` | A cache the service always calls, and its call to `db` at `p: 1 − hit`. | the service / `[db]` |
| `replicatedDb(id, { label, replicas })` | A primary and `replicas` replicas, joined by replication edges. | the primary / `[primary]` |
| `queueWorkers(id, { workers, rate, worker })` | A queue and its competing workers. | the queue / the workers |
| `canary(id, { router, flag, rollout, v1, v2, flags })` | `<id>-v1` (`unless` the flag) and `<id>-v2` (`flag`) behind `router`, a `flags` node pushing config to it (`flags: false` to skip), and the flag in `spec.flags`. | the router / `[v1, v2]` |

Every pattern takes `at: [col, row]` to place its nodes at fixed offsets from there; leave `at` out of every pattern and node to let auto-layout place everything. `examples/platform/` is a figure built entirely from patterns, and `node scripts/catalog.mjs` draws every kind and pattern (`examples/catalog/catalog.html`, or `/catalog` on the dev server).

## Groups

`{ id, label, nodes: [ids], pad, region }`. A floor plate (iso) or dashed region (flat) around its members, which can be nodes or other groups. Inner groups stand on outer ones. `region: true` draws a heavier plate with a bigger label. The label runs along the plate's left edge.

## Feature flags

`flags: { name: { rollout: 0.1, sticky: false } }`. Each request draws once per flag and keeps that decision through every hop, so a request either always sees the flag or never does. `sticky: true` decides per source node instead. A `flags`-kind node shows one switch per flag (up to 4), its knob at the rollout. A config change reaches the system only while the flag service is up; while it is down, everyone keeps the last value.

## Scenario

```js
scenario: {
  length: 40,                     // seconds; default: last step or phase + 8
  loop: true,                     // default true: restart from 0 at the end
  phases: [{ name: "steady", at: 0 }, { name: "incident", at: 10 }, { name: "recovery", at: 22 }],
  steps: [
    { at: 1, say: "…" },                                    // narration only
    { phase: "incident", fail: "billing-a", say: "…" },     // at a phase's start
    { phase: "incident", after: 5, say: "…" },              // or after it
    { at: 12, recover: ["billing-a"] },
    { at: 6, set: { web: { emit: 18 } } },                  // change a node
    { at: 20, set: { "api>inventory": { breaker: true } } },// change an edge ("from>to")
    { at: 8, fail: "topic:b0" },                            // fail a Kafka broker
    { at: 6, flag: "new-checkout", rollout: 0.1 },          // move a flag
    { at: 24, kill: "new-checkout" },                       // kill switch: rollout 0
  ],
}
```

Settable on nodes: `emit`, `rate`, `capacity`, `burst`, `errorRate`, `ms`, `queue`, `detect`, `ttl`, `route`, `health`, `sidecarMs`. Settable on edges: `retries`, `timeout`, `backoff`, `p`, `breaker`, `rate`.

The page plays the story and loops it. A timeline under the card shows the phases (click one, or press 1–9) and a tick per step; the narration line shows the latest `say`. Scrubbing re-simulates from 0, and the sim is seeded, so a time always looks the same. Clicking a node or a broker takes over: the rest of the script stops applying until the reader presses play, which re-simulates the story up to the current time.

## Simulation

`sim` fields, all optional:

| Field | Default | Meaning |
|---|---|---|
| `per` | 1 | Requests each packet stands for. The readout multiplies by it. Keep packets under ~30/s on screen. |
| `seed` | 7 | The RNG seed: the same spec always runs the same way, in Node and in the page. |
| `speed` | 150 | Packet speed in world units per second (animation only). |
| `net` | 0.5 | Default network ms per hop, each way. |
| `window` | 2 | Seconds of history behind each rate. |
| `rebalance` | 0.9 | Seconds a consumer group pauses to rebalance after a member fails or returns. |
| `refuse` | 0.02 | Seconds before a refused connection's error starts back. |
| `jitter` | true | `false` makes every service time exact. |

**Time.** Packet travel is slowed down so people can watch it; everything else runs in real seconds. Latency is built up in model time, not measured off the clock: a job costs its queue wait plus its service time plus its slowest sync call. A call costs its network round trip plus the callee's job, plus any earlier failed attempts and their backoff. The readout's p50/p99 are over requests completed in the last 3 s.

**A request's life.**
- A source starts it.
- Each node, after its queue wait and service time, sends one along each `replication` edge, then routes on its other edges.
- Sync calls are awaited, and the node answers when all of them have answered, failed or timed out. Any failure makes its answer an error.
- A node that is down refuses (red, at once). A node over capacity with a full buffer answers 503.
- A node that dies mid-request resets its callers.
- A `roundrobin` router skips targets it knows are dead, after `detect` or `ttl`.

**Kafka.**
- Writes go to a partition by `key`, by `skew`, or round-robin.
- Each consumer group assigns partitions to its live members (`p % members`) and pulls from its most-lagged partition at each member's `rate`.
- With `brokers`, partition p's replicas are brokers `p … p + rf − 1`, led by the first. Losing a leader moves leadership to the next live replica, and the partition pauses (dims) for `election` seconds.
- A partition whose leader is down accepts nothing. With `acks: "all"`, a partition with fewer than `minIsr` live replicas refuses writes.

**Queue:** one lane; live consumers compete.

**Readout.**
- **Summary:** `in/s · p50 · p99 · lag`, then either `failing/s` (client-visible failures), `lost/s` (drops), `n down`, or `healthy`.
- **A focused node:** its rate, p50 (or the end-to-end p50/p99 at a source), capacity, queue depth, rejections, errors and open breakers.
- **A focused log:** its inflow, each group's lag and live consumers, and broker, election and ISR state.

## Features

Tool features, all on by default: `scenario`, `labels`, `trails`, `morph`, `sparkline`, `hops`, `breakers`, `queues`, `flags`, `edit`. Resolution order, last wins: defaults, then spec `features: { trails: false }`, then `build.mjs --features trails,-morph` or `--no-morph`, then `?features=-morph` on a serve page.

A disabled feature emits no markup and no inlined code, and the sim ignores the spec fields it owns. With `queues` off, `queue` is ignored. With `breakers` off, `breaker` is ignored. With `flags` off, `flag`/`unless` edges are always taken. With `scenario` off, there is no timeline and no steps. `morph` adds ~75 KB to the page (the iso kit and renderers inlined), so turn it off for the leanest page.

## Layout rules

- **Auto-layout** ranks nodes by longest path from the sources (ignoring `replication` and `back` edges), one column per rank, ordered by the average row of their inputs. A replication target goes right after its primary.
- **Routes** are orthogonal, leaving the face that looks at the target. Ports spread along shared faces, and edges whose elbows share a channel get separate lanes. A crossing at right angles hops on whichever edge has room.
- **`--check`** warns about overlapping nodes, edges passing under a node, and iso labels hidden behind a nearer node.
