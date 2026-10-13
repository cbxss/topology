# Spec

A spec is a `.spec.mjs` with a default export (or a `.json` file). `scripts/build.mjs` reads it, `kit/topo.mjs` lays it out and draws it, and `kit/topo-sim.mjs` runs it. A `<name>.layout.json` next to it (written by the serve editor) overrides node positions. Nothing else feeds the figure.

```js
export default {
  title: "Order events",          // card title (top right) and page title
  fig: "Fig 1",                   // top-left corner
  caption: "…",                   // under the card: what it is, the numbers, what to try
  hint: "…",                      // bottom-left corner; default "Hover a node · click to inspect · V for 2D"
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

## Minimal endpoint/table recipe

Save this as `profile.spec.mjs`. It uses only the authoring contract: a route mix, a synthetic record, sequential calls, a primary/replica pair and a scenario. Rates are literal (`sim.per` defaults to 1). `then: true` waits for the preceding synchronous stage; replication remains asynchronous.

<!-- tested: endpoint-table-recipe -->
```js
export default {
  title: "Save a profile, then read it",
  caption: "Illustrative: 6 requests/s over 30 synthetic profiles. A 4 s replica apply delay exposes stale reads; reading back from the primary fixes this request path. This models row versions, not SQL transactions.",
  sim: { seed: 21 },
  grid: [150, 80],
  records: { profiles: { key: "userId", keys: 30, fields: { plan: ["free", "pro"] } } },
  nodes: [
    { id: "app", kind: "client", at: [0, 0.5], emit: { "PUT /profile": 6 } },
    { id: "api", kind: "service", at: [1, 0.5], endpoints: {
      "PUT /profile": { calls: [
        { to: "primary", op: "upsert", table: "profiles" },
        { to: "replica", op: "select", table: "profiles", then: true },
      ] },
      "PUT /profile (fixed)": { calls: [
        { to: "primary", op: "upsert", table: "profiles" },
        { to: "primary", op: "select", table: "profiles", then: true },
      ] },
    } },
    { id: "primary", kind: "db", at: [2.2, 0], tables: { profiles: { key: "userId", show: 6 } } },
    { id: "replica", kind: "db", at: [2.2, 1.05] },
  ],
  edges: [["app", "api"], ["api", "primary"], ["api", "replica"],
    { from: "primary", to: "replica", kind: "replication" }],
  scenario: {
    length: 36,
    phases: [{ name: "steady", at: 0 }, { name: "behind", at: 8 }, { name: "fixed", at: 22 }],
    steps: [
      { at: 1, say: "Each request saves a profile, then reads it back." },
      { at: 8, set: { replica: { lag: 4 } }, inspect: "replica", say: "Delayed apply makes the read-back stale. Inspect the replica's rows." },
      { at: 13, follow: "PUT /profile", say: "Follow the write and its replica read-back; compare their versions." },
      { at: 22, follow: false, inspect: false, set: { app: { emit: { "PUT /profile (fixed)": 6 } } }, say: "Read-back now goes to the primary, even while replication is delayed." },
      { at: 28, set: { replica: { lag: 0 } }, say: "The replica catches up." },
    ],
  },
};
```

```sh
node scripts/build.mjs profile.spec.mjs --check
node scripts/build.mjs profile.spec.mjs
node scripts/build.mjs profile.spec.mjs --light
node scripts/build.mjs profile.spec.mjs --trace "PUT /profile"
```

`--trace` starts after 5 seconds, so this command samples the initial phase. Use the browser's Follow control during the incident, or the documented `traceText` warmup option below. Check that the behind phase has stale reads and the settled fixed phase has none; exact rates depend on seed, layout and timing. Use the screenshot and line-end workflow in [verify.md](verify.md).

**Authoring boundary.** Add or change nodes, edges, endpoints, records, tables, phases and the documented knobs in the spec. Reuse an example or pattern. A new drawing kind, operation, routing algorithm or consistency guarantee is engine development; record it as unsupported instead of inventing a field or silently changing the model. Engine organization is documented separately in [engine.md](engine.md).

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
| `kind` | `sync` (default between ordinary nodes: solid line, request then response), `async` (default to or from a `kafka`/`queue`: dashed, no response), `replication` (dashed; a table-backed source sends a WAL entry per committed write; other sources send one per handled request), `config` (dotted; drawn, never carries traffic: a flag service pushing config). |
| `sync` | Override whether the target answers. A sync caller waits for the reply before it answers its own caller. |
| `ms` | One-way network latency in model milliseconds, counted twice per call (default `sim.net`, 0.5). |
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

## Endpoints

A source can emit a route mix: `emit: { "POST /orders": 3, "GET /orders/:id": 12 }`. Values are rates or rate curves, not percentages. The total is their sum; each request keeps its selected route at every hop. These are exact string labels, not HTTP path matching.

A service declares `endpoints: { "POST /orders": { ms: 9, calls: [{ to: "pg", op: "upsert", table: "orders" }, { to: "replica", op: "select", table: "orders", then: true }] } }`.

- `ms` overrides that node's service time for this route.
- `calls` replaces ordinary routing for that endpoint. Every `to` needs an outgoing edge; its sync/async mode, timeout and retries still apply.
- A call's `p` is its independent probability (default 1). Calls in one stage run in parallel. `then: true` starts a new stage after earlier synchronous calls finish successfully. Async work is not awaited.
- `op` and `table` select a database operation. Without them, the call is ordinary traffic.
- Nodes without a matching endpoint forward normally. Inspect a service for per-route rate, p50/p99 and errors; select a route to filter packets.

## Records and tables

Top-level `records: { orders: { key: "orderId", keys: 40, start: 1000, skew: 0.5, fields: { status: ["new", "paid"] } } }` describes synthetic records. `keys` is the keyspace size (default 100), `start` the first numeric key (default 1000), and `skew` the fraction choosing the hottest 5% of keys. Field values are sampled from their arrays. A request picks one record per table and reuses its key and fields through subsequent calls and retries. `key` names the record identifier; declare the corresponding display key on the table too.

A database declares `tables: { orders: { key: "orderId", show: 6 } }`. Tables start empty; `show` limits displayed recent rows, not storage. A database receiving a replication edge inherits its primary's table declarations if it has none. Put the primary before its replica in `nodes`.

| Operation | Behavior |
|---|---|
| `select` | Reads the key; missing rows are successful misses. A row older than the primary or this request's write is stale; a missing row is also stale when a newer row is expected. |
| `insert` | Creates version 1; an existing key is a conflict and fails the call. |
| `upsert` | Inserts or replaces fields and increments the version. Repeated content preserves one row per key, but still generates versions and WAL entries. |
| `update` | Replaces an existing row's fields and increments its version; missing keys are successful misses. |
| `delete` | Removes an existing key and emits WAL; missing keys do nothing. |
| `rmw` | Captures the version when work starts, then writes at commit. An intervening version change counts as a lost update. This detects a race; it does not evaluate arithmetic or SQL. |

`locks: true` serializes writes per table/key at that node. `lag` delays a replica's WAL apply by seconds after arrival. Both can change in a scenario. Inspect a database for recent rows, versions, fields, WAL positions, writes, conflicts, stale reads, lock waits and lost updates. Click a row to open every saved field alongside a read-only `SELECT * FROM "table" WHERE "key" = value` illustration. This reads the selected node’s in-memory row; it is not a SQL parser. Only fields declared by the record schema and actually stored are shown; version is separate simulation metadata. **Follow writes** pins that table/key, highlights its packets, and compares the actual saved versions and values at the primary and replicas as traffic updates them. This waits for real workload writes; it does not generate a save. WAL details show only the bounded retained history, not a complete audit log. Current operation rates are node-wide, even when several tables are displayed; row counts are per table. WAL lag is a simplified position gap, not a durable PostgreSQL replication protocol or transaction isolation guarantee.

`--check` reports settled stale-read, conflict and lost-update rates per phase (events/s, multiplied by `sim.per`). A stale read can be a successful request: “healthy” means no transport/request failure, not fresh data. Packet travel affects operation ordering; tune replica lag against the actual layout and verify a trace. Use `sim.per: 1` when displaying literal workload rates alongside finite row counts.

## Following a request

Click a node to inspect it; choose a route and **Follow a request** to follow the next matching source request. Other packets dim, playback slows, and a span list shows service work, calls, retries and table results in model milliseconds. **Another** follows another request; close the panel to stop. `node scripts/build.mjs my.spec.mjs --trace "POST /orders"` prints a trace after a 5-second warmup. For an incident trace use `traceText(spec, route, { warmup: 14 })` from `scripts/page.mjs`.

Scenario steps can use `inspect: "pg"` or `inspect: false`, and `follow: "POST /orders"` or `follow: false`. These expose detail at the narrated moment; they do not change the workload. The browser API exposes `window.__topo.inspector.show(id)` and `window.__topo.story.seek(seconds)`; the pure model exposes `sim.follow(route)` and `sim.tracing`.

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
| `system(prefix, spec, { at, label, keepSources, shared, plate, region })` | A whole other spec, embedded: see "Composing systems". | `ports.in` (default: what its dropped clients called) / `ports.out` |

Every pattern takes `at: [col, row]` to place its nodes at fixed offsets from there; leave `at` out of every pattern and node to let auto-layout place everything. `examples/platform/` is a figure built entirely from patterns, and `node scripts/catalog.mjs` draws every kind and pattern (`examples/catalog/catalog.html`, or `/catalog` on the dev server).

### Composing systems

A figure can reuse another figure's system. The child stays an ordinary spec that builds on its own; it may declare `ports: { in: "api", events: "topic" }`, naming the node ids other figures may link to (validated). The parent embeds it with `system()`:

```js
import { compose, importSpec, link, system } from "../../kit/patterns.mjs";

const ledger = system("books", await importSpec(new URL("../ledger/ledger.spec.mjs", import.meta.url)), { at: [3, 4] });
export default compose({ title: "Orders → ledger", sim: { per: 40 } }, orders, ledger,
  link("topic", ledger.in, { group: "ledger" }));
```

- **Ids.** Every node, edge, group and flag becomes `<prefix>.<id>` (`books.shard-3`); `id("shard-3")` on the fragment returns that. Labels keep the short id. Endpoint call targets and `routing` targets move with them; route names, table names and routing conditions do not. `shared: ["flag"]` keeps a flag's name so parent and child switch together. Prefixes cannot contain `.`, `>` or `:`; nesting gives `outer.inner.id`.
- **Sources.** The child's `client` nodes with `emit` or `workload` are dropped with their edges, so the parent drives the system; `keepSources: true` keeps them. Other sources (schedulers, internal emitters) stay.
- **Story and model.** The child's scenario is dropped; the parent's steps can target embedded ids (`fail: "books.shard-3"`, `set: { "books.ledger>books.shard-1": { timeout: 0.2 } }`). The parent's `sim` and `grid` apply; `compose` warns when the child was written for a different `sim.per`, because its rates and capacities are per packet. `records`, `traffic` and `policies` merge by name and must agree.
- **Drawing.** With `at`, the child keeps its own drawing, its `at`s or else its own auto-layout, moved so its top-left lands at `at`. Without `at`, its positions are dropped and the parent's auto-layout places everything; don't mix a placed parent with an unplaced system. Edge `via` waypoints are dropped (they are world units). The system stands on a plate labelled with its `title` (`label` overrides, `region: true` for a heavier plate, `plate: false` for none); its own groups nest inside.
- **Layout files.** `importSpec(fileOrUrl)` loads the child the way `build.mjs` does, with its `<name>.layout.json`; a plain `import` skips that file. Positions dragged in the parent's editor are saved under the embedded ids in the parent's layout file.

`examples/ledger` is a standalone system with ports; `examples/order-ledger` embeds it and order-events in one figure.

## Sources and notes

For agents, not readers: where a figure's claims come from. None of it is drawn, and the build strips it before anything is embedded in the page.

```js
export default {
  sources: {                                                  // name → repo
    infra:  { repo: "../../infra" },                          // a local checkout, relative to this spec
    ledger: { repo: "github.com/acme/ledger", rev: "a1b2c3d" },  // a remote, pinned to a commit
  },                                                          // `self` is always defined: this spec's repo
  refs:  ["infra:terraform/ledger/main.tf"],                  // the whole system
  notes: ["Resharding is manual."],
  nodes: [{ id: "ledger", kind: "service", replicas: 3,
    refs: [
      "ledger:cmd/server/main.go#func main",
      { ref: "infra:k8s/ledger.yaml#replicas:", field: "replicas", note: "prod HPA floor" },
    ],
    notes: ["Idempotent by entry id.", { text: "≈400/s from the ledger dashboard", field: "emit", assumed: true }],
  }],
  edges: [{ from: "ledger", to: "shard-0", timeout: 0.2, refs: [{ ref: "ledger:config/prod.yaml#db_timeout:", field: "timeout" }] }],
};
```

`refs` and `notes` are arrays on the spec, any node, edge (object form) or group. A ref is `"<source>:<path>[#anchor]"` or `{ ref, field, note }`; the anchor is a literal substring (first match) or `/regex/`, never a line number. A note is text or `{ text, field, assumed }`.

`node scripts/build.mjs my.spec.mjs --sources` resolves every ref and prints each one with its status and the matched lines, then the notes, the `assumed` notes and the `unsourced` nodes and edges. `--json` prints the same as `{ sources, items, unsourced, assumed, summary }`.

| Status | Meaning |
|---|---|
| `ok` | The file and anchor exist; a `field`'s number matches. |
| `missing-file`, `missing-anchor` | The file, or the anchor in it, is gone. |
| `mismatch` | The first number after the anchor (or on the next line) differs from the spec's `field`. Units convert: `200ms` matches `timeout: 0.2`, `85%` matches `hit: 0.85`. |
| `stale` | With `rev`: the file changed since that commit (the commits are listed, and uncommitted edits). Refs are read at `rev`. |
| `unresolved` | The repo isn't available: a remote without `--fetch`, a missing directory or an unknown `rev`. |

The command exits 1 on `missing-*` or `mismatch`, and also on `stale` or `unresolved` with `--strict`. Remotes (`github.com/org/repo`, `https://`, `git@`, `file://`) are never fetched unless you pass `--fetch`, which keeps a blobless clone in `~/.cache/topology/repos` using your git credentials. To read a local checkout instead, pass `--source-dir ledger=~/Code/ledger`, or map repos to checkouts in a `.topology-sources.json` next to the spec (`{ "github.com/acme/ledger": "~/Code/ledger" }`, gitignored). The spec is never rewritten: after fixing what the report flags, update `rev` yourself.

With `system()`, the child's sources are namespaced like its ids (`books.ledger`), its refs are rewritten to match, and its spec-level refs and notes move onto its plate. `importSpec` makes the child's relative repos absolute and sets its `self`; a plain `import` leaves them relative to the parent and `self` pointing at the parent's repo.

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

Settable on nodes: `emit`, `rate`, `capacity`, `burst`, `errorRate`, `ms`, `queue`, `detect`, `ttl`, `route`, `health`, `sidecarMs`, `lag`, `locks`. Settable on edges: `retries`, `timeout`, `backoff`, `p`, `breaker`, `rate`.

The page plays the story and loops it. A timeline under the card shows the phases (click one, or press 1–9) and a tick per step; the narration line shows the latest `say`. Scrubbing re-simulates from 0, and the sim is seeded, so a time always looks the same. Failing/restoring a node (inspector button or F), or clicking a broker unit, takes over: the rest of the script stops applying until the reader presses play, which re-simulates the story up to the current time.

## Simulation

`sim` fields, all optional:

| Field | Default | Meaning |
|---|---|---|
| `per` | 1 | Requests each packet stands for. The readout multiplies by it. Keep packets under ~30/s on screen. |
| `seed` | 7 | The RNG seed: the same spec always runs the same way, in Node and in the page. |
| `speed` | 150 | Packet speed in world units per second. Travel affects event ordering but is excluded from reported network latency. |
| `net` | 0.5 | Default network ms per hop, each way. |
| `window` | 2 | Seconds of history behind each rate. |
| `rebalance` | 0.9 | Seconds a consumer group pauses to rebalance after a member fails or returns. |
| `refuse` | 0.02 | Seconds before a refused connection's error starts back. |
| `jitter` | true | `false` makes every service time exact; source interarrival times still vary. |
| `length`, `loop` | 0, true | Rate-curve horizon and wrapping. A scenario supplies `length`; its playback loop is controlled by `scenario.loop`. |

**Time.** Packet travel is slowed down so people can watch it; everything else runs in real seconds. Latency is built up in model time, not measured off the clock: a job costs its queue wait plus its service time plus its slowest sync call. A call costs its network round trip plus the callee's job, plus any earlier failed attempts and their backoff. The readout's p50/p99 are over requests completed in the last 3 s.

**A request's life.**
- A source starts it.
- Each node waits for its queue and service work, then routes its calls. Table-backed databases replicate committed writes only.
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

Tool features, all on by default: `scenario`, `labels`, `trails`, `morph`, `sparkline`, `hops`, `breakers`, `queues`, `flags`, `edit`, `endpoints`, `tables`, `trace`. Resolution order, last wins: defaults, then spec `features: { trails: false }`, then `build.mjs --features trails,-morph` or `--no-morph`, then `?features=-morph` on a serve page.

A disabled feature removes its UI and owned behavior; shared inlined code can remain. With `queues` off, `queue` is ignored. With `breakers` off, `breaker` is ignored. With `flags` off, `flag`/`unless` edges are always taken. With `scenario` off, there is no timeline and no steps. `morph` adds ~75 KB to the page (the iso kit and renderers inlined), so turn it off for the leanest page.

## Layout rules

- **Auto-layout** ranks nodes by longest path from the sources (ignoring `replication` and `back` edges), one column per rank, ordered by the average row of their inputs. A replication target goes right after its primary.
- **Routes** are orthogonal, leaving the face that looks at the target. Ports spread along shared faces, and edges whose elbows share a channel get separate lanes. A crossing at right angles hops on whichever edge has room.
- **`--check`** warns about overlapping nodes, edges passing under a node, and iso labels hidden behind a nearer node.

With `endpoints` disabled, route mixes become total rates and endpoint declarations are ignored. With `tables` disabled, stores and table operations are removed. With `trace` disabled, the following panel is omitted. Feature removal strips owned behavior; shared simulation code can remain in the bundle.


## Product components

Use `kind: "redis"`, `kind: "elasticache"`, or `kind: "dynamodb"` anywhere a
node is accepted. Both views use distinct silhouettes: a low tile stack for Redis, an enclosed stack for ElastiCache, and a rectangular cell cabinet for DynamoDB.
Redis and ElastiCache reuse `cache` behavior and its default service time;
DynamoDB reuses `db` behavior, including `tables`, saved fields and write following.
Rates, service times and capacities are illustrative knobs, not vendor defaults.

```js
{ id: "sessions", kind: "redis", label: "Redis sessions" }
{ id: "cache", kind: "elasticache", label: "ElastiCache" }
{ id: "items", kind: "dynamodb", tables: { items: { key: "itemId" } } }
```

`cacheAside("api", { db: "items", kind: "elasticache", hit: 0.8 })` composes the
same probabilistic cache-aside pattern with the selected component. The default
`kind` remains `cache`; `redis` is also accepted.
See [data-stores.spec.mjs](../examples/data-stores/data-stores.spec.mjs) for a runnable
composition with real simulated writes and record inspection.

These are product-labelled components over the existing model: Redis commands,
TTL/eviction, ElastiCache provisioning/failover, and DynamoDB capacity units,
conditional expressions, consistency options and global tables are not modeled.
The record query display is illustrative; it does not imply DynamoDB supports SQL.

## Validation and recovery limits

Build and `--check` reject unknown kinds/operations, missing call edges or tables,
invalid field-sample arrays, duplicate IDs, invalid numeric rates and unknown
scenario targets. Runtime scenario errors also exit nonzero. Workload warnings
such as intended overload or idle edges remain nonfatal; explain those in the
caption. Phase summaries report dropped traffic separately from client-visible
failures, which matters for asynchronous publishes.

Table row versions remain monotonic across delete/recreate. Direct replicas
buffer out-of-order WAL and advance their applied position contiguously.
Unacknowledged entries are retained separately from the bounded inspection
history and retried through the simulated transport after failures. Rows,
buffered entries and pending WAL survive a node outage; they are still only
in-memory simulation state, not disk durability. Pending replication consumes
memory in proportion to unacknowledged writes during an outage. Write to the
primary; cascading table replication and independently writable replicas are
unsupported.

Queues and Kafka nodes stop serving consumers while down. Existing backlog
remains in memory; publishes arriving during downtime are dropped/refused.
Consumers resume on recovery. Consumption advances offsets when dispatched,
not after a durable consumer acknowledgement; crash redelivery and durable
broker storage are outside this model.

## Request context, routing and traffic classes

Use `workload` when requests need metadata. Keep `emit` for existing numeric,
curve, scheduled-burst or endpoint-mix sources. A node cannot declare both.
Context is synthetic JSON; no HTTP parser or real header capture is involved.

<!-- tested: routing-recipe -->
```js
export default {
  traffic: {
    standard: { label: "Standard", color: "cyan", context: { tier: "standard" } },
    premium: { label: "Premium", color: "violet", context: { tier: "premium" } },
  },
  policies: { premium: { field: "context.tier", eq: "premium" } },
  nodes: [
    { id: "app", kind: "client", workload: [
      { traffic: "standard", endpoint: "GET /orders", rate: 8 },
      { traffic: "premium", endpoint: "GET /orders", rate: 3, context: { region: "eu" } },
    ] },
    { id: "gateway", kind: "gateway", routing: {
      rules: [{ id: "premium-service", when: { policy: "premium" }, action: { type: "send", to: "dedicated" } }],
      fallback: { type: "send", to: "shared" },
    } },
    { id: "dedicated", kind: "service" },
    { id: "shared", kind: "service" },
  ],
  edges: [["app", "gateway"], ["gateway", "dedicated"], ["gateway", "shared"]],
};
```

| Field | Contract |
|---|---|
| `traffic` | Map of class IDs to optional `label`, named `color`, and default `context` object. |
| `workload` | Nonempty array of `{rate, traffic?, endpoint?, context?}`. Rate is a nonnegative number or increasing `[[seconds, rate], …]` curve. |
| `context` | Acyclic JSON object. Class defaults and workload overrides merge **shallowly**; nested objects are replaced. The resolved object is cloned and deeply frozen at emission. |
| `policies` | Named predicates, reusable through `{policy: "name"}`. References must exist and be acyclic. |
| `routing` | `{rules: [{id, when, action}, …], fallback: action}`. First matching rule wins; fallback is required. Rule IDs are unique within the routing block; `fallback` is reserved. |
| `colorBy` | `traffic`, `activity`, or `none`. Specs declaring classes default to traffic; older specs retain their activity display. |

Predicates support one comparison per leaf: `{field, eq: scalar}`,
`{field, in: [scalars]}`, `{field, exists: boolean}`, or numeric `gt`, `gte`,
`lt`, `lte`. Scalars are strings, finite numbers, booleans and null. Comparisons
are strict: missing differs from null, zero and false; numeric strings are not
numbers. Compose using `{all: [predicates]}`, `{any: [predicates]}` and
`{not: predicate}`. Lists are nonempty and short-circuit in declaration order.

Fields are dot paths into `context`, or `request.endpoint`, `request.source`
(the originating source, including after Kafka/queue delivery), and
`request.traffic`. Use array paths for literal dots in keys, for example
`{field: ["context", "headers", "x.tenant"], eq: "acme"}`. Context can represent
headers, tenant, region, operation or any other declared metadata. There are no
arbitrary expressions, regular expressions, context mutations or hash routing.

Actions are `{type: "send", to: "node"}`, `{type: "reject"}`, or
`{type: "weighted", targets: [{to: "a", weight: 3}, {to: "b", weight: 1}]}`.
Weights are positive and finite; the seeded choice happens once per call and
retries reuse that destination. Every possible target needs exactly one outgoing
data edge. Config and replication edges are not routing targets. A down target,
open breaker or false flag gate fails through existing transport behavior;
**fallback handles unmatched conditions, not failed delivery**. Rule actions
ignore edge `p`; they do not create a health-aware pool.

Endpoint `calls` take precedence over node routing. A call may add `when` and
may replace `to` with `routing`. Its `p`, `then`, `op` and `table` still apply:
conditions are checked before probability, skipped stages advance, and table
operations run at the chosen destination. All possible table destinations must
support that table/operation. For example:

```js
{ when: {field: "context.write", eq: true}, then: true,
  op: "upsert", table: "orders",
  routing: {rules: [{id: "premium-db", when: {policy: "premium"},
    action: {type: "send", to: "premium-db"}}],
    fallback: {type: "send", to: "shared-db"}} }
```

Disabling endpoints removes endpoint labels/call behavior while retaining
workload rates and context. Disabling tables removes table operations while
retaining routing. Routing is available independently of trace and color UI.

Kafka and queues retain an immutable envelope per pending partition offset.
Consumers receive the original class, context, endpoint, generated records,
flag draws and root/parent identity. Each delivery has a new message ID and
independent mutable execution state. Kafka still assigns partitions to groups;
queue workers still compete. Put content-routing rules on consumers, not the
log node. Envelopes are reclaimed after all groups dispatch them. This models
**dispatch offsets**, not durable ACKs, redelivery or exactly-once processing.
An undrained backlog retains its envelopes in memory.

Follow a request displays class/context, rule decisions, compared values,
selected destinations and outcomes. Kafka/queue descendants remain part of the
journey after the initial response; pending work is shown explicitly. A follow
captures at most 256 spans or 60 simulated seconds and labels truncation.
`--trace` includes the same routing explanation. Inspectors and `--check` show
recent decision counts. Class legends count source emissions/s; node inspectors
count arrivals/s, which may include retries and async deliveries. These are
observed rolling rates, not percentages or configured rates.

Traffic colors are `cyan`, `blue`, `violet`, `magenta`, `teal`, `lime`, with
separate dark/light values. Omitted colors cycle in declaration order; repeated
colors and more than six classes produce a `--check` warning. Red and amber
remain status colors. Traffic mode uses class-colored requests, hollow
responses, square records, diamond replication, amber-outlined retries, red
error/drop crosses and faded late replies. Activity preserves the older packet
colors; None uses monochrome state shapes. Class buttons support multiple
selection; no selection means all. They highlight observed paths and intersect
route filtering. Record selection and followed traces take visibility priority.
Display controls consume no random draws and never alter the simulation.

Complete stories: `examples/tenant-routing/` (two routing decisions and tenant
failure isolation), `examples/event-routing/` (mixed Kafka backlog and context).
