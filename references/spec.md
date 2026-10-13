# Spec

A spec is a `.spec.mjs` with a default export (or a `.json` file). `scripts/build.mjs` reads it, `kit/topo.mjs` lays it out and draws it, and `kit/topo-sim.mjs` runs it. Nothing else feeds the figure.

```js
export default {
  title: "Order events",          // card title (top right) and page title
  fig: "Fig 1",                   // top-left corner
  caption: "…",                   // under the card: what it is, the numbers, what to try
  hint: "…",                      // bottom-left corner; default "Hover a node · click to fail it · V for 2D"
  view: "iso",                    // or "flat": which view opens (both are built)
  grid: [150, 90],                // world units per column and row; default from the largest node
  sim: { per: 40, seed: 3 },      // see "Simulation"
  keys: [{ mark: "lit", label: "Request" }],   // legend; default is derived from what the spec uses
  nodes: [ … ],
  edges: [ … ],
  groups: [ … ],
};
```

## Nodes

| Field | Meaning |
|---|---|
| `id` | Required, unique. Used by edges, groups and `data-node`. |
| `kind` | `client`, `lb`, `gateway`, `service`, `worker`, `cache`, `db`, `storage`, `kafka`, `queue`, or `box` (anything else). Sets the drawing and some defaults. |
| `label` | Text on the floor (iso) or under the glyph (flat). Default: `id`. Keep it under ~14 characters. |
| `at` | `[col, row]` in grid units, fractions allowed. Omit on every node for auto-layout; if any node lacks `at`, the unplaced ones are auto-ranked. |
| `replicas` | `service`/`worker`: 1–4 stacked units, each with its own LED; requests rotate across them. |
| `partitions` | `kafka`: number of partitions (lanes). Default 3. |
| `role` | `db`: a tag on the top (`primary`, `replica`, `standby`). |
| `emit` | Makes the node a source: packets per second it starts, with ±40% jitter. |
| `rate` | A consumer's pull rate from a log, packets per second (default 40). Can be set per edge instead. |
| `route` | How a node forwards: `all` (every outgoing edge, each with its `p`; the default), `roundrobin` (one edge, rotating; the default for `lb` and `gateway`), `random` (one edge, weighted by `p`). |
| `latency` | Seconds a node holds a message before forwarding or answering (default `sim.latency`, 0.03). |
| `capacity` | Admits at most this many packets per second (a token bucket); the rest are dropped red. For rate limits and overload. |
| `burst` | Bucket size as a fraction of `capacity` (default 0.25). |
| `health` | `false` on an `lb`/`gateway`: no health checks, it keeps sending to a dead target (drops). |
| `up` | `false` to start the node failed. |
| `labelAt` | `front` or `side` to force the iso label spot (default: front, else side if front is hidden). |
| `w`, `d` | Override the footprint in world units. |

## Edges

`{ from, to, … }`, or the shorthand `["from", "to"]`.

| Field | Meaning |
|---|---|
| `kind` | `sync` (default between ordinary nodes: solid line, request then response), `async` (default to or from a `kafka`/`queue`: dashed, no response), `replication` (dashed; the source sends one along it for every message it handles). |
| `sync` | Override whether the target answers. Responses travel back along the edge after the target's `latency`; they don't wait for the target's own downstream calls. |
| `p` | With `route: "all"`: the chance this edge is called per message (cache-aside: `api → db` with `p: 0.2` is an 80% hit ratio). With `route: "random"`: the weight. |
| `group` | On an edge out of a `kafka` node: the consumer group of the target (default `"default"`). Each group has its own committed offsets. |
| `key` | On an edge into a `kafka` node: a fixed partition key (hashed), to show a hot partition. Without it, writes round-robin over partitions. |
| `rate` | A per-consumer pull rate that overrides the target's `rate`. |
| `bend` | 0–1: where along the run the elbow pair sits (default: the middle, or the edge's own lane when several share a channel). |
| `via` | World-unit waypoints `[[x, y], …]` that replace the routed corners: the escape hatch for a route around a node. |
| `axis` | `x` or `y`: force which faces the edge leaves and enters. |
| `back` | `true` to ignore this edge for auto-ranking (a callback that would otherwise push its source right). |

## Groups

`{ id, label, nodes: [ids], pad }`. A floor plate (iso) or dashed region (flat) around its members, which can be nodes or other groups. Inner groups stand on outer ones. Zones read best as contiguous rows or columns: if a node that isn't a member sits inside a group's box, rearrange.

## Simulation

`sim` fields, all optional:

| Field | Default | Meaning |
|---|---|---|
| `per` | 1 | Messages each packet stands for. The readout multiplies by it: `emit: 6, per: 40` reads 240/s. Keep packets under ~30/s on screen. |
| `seed` | 7 | The RNG seed. The same spec always runs the same way, in Node and in the page. |
| `speed` | 150 | Packet speed, world units per second. Edge length sets travel time. |
| `latency` | 0.03 | Default node latency in seconds. |
| `window` | 2 | Seconds of history behind each rate in the readout. |
| `rebalance` | 0.9 | Seconds a consumer group stops consuming while it rebalances after a member fails or returns. |

What happens, exactly:

- **Sources** (`emit`) start packets and forward them.
- **Forwarding**: when a node finishes a message (after `latency`) it sends one along each `replication` edge, then routes on its other edges per `route`. A `roundrobin` node skips targets that are down (unless `health: false`); with no healthy target the message is lost.
- **Arrival**: a node that is down, or out of `capacity` tokens, drops the packet (red, fades out at the target). Otherwise it handles it: the LED of the next replica blinks, and a `sync` edge answers.
- **Kafka**: an arriving record is appended to a partition (its `key`'s hash, else round-robin). Each consumer group assigns partitions to its live members round-robin (`p % members`), so 3 partitions over 2 consumers gives one consumer two. Each consumer pulls up to its `rate`, always from its assigned partition with the most lag, commits, and sends the record down its edge (blue); the consumer then forwards it like any node. When a member fails or recovers, the group pauses for `rebalance` seconds and reassigns. Lag is log-end offset minus committed offset, summed over partitions.
- **Queue**: one lane; every live consumer competes for the same messages (no assignment, no rebalance pause).
- **Failure**: clicking a node (or Enter on the focused node) toggles it. A down node drops what arrives, forgets work in progress and stops emitting or consuming.

The readout shows the summary (`380/s in · lag 40 · healthy`, or `… lost`, or `n down`) and, while a node is focused, that node's line: rate, capacity and rejections, or for a log its inflow, each group's lag and live consumers, and `rebalancing`.

## Layout rules

- Auto-layout ranks nodes by longest path from the sources (ignoring `replication` and `back` edges), one column per rank, ordered within a column by the average row of their inputs. A replication target goes in its primary's column, right after it.
- Routes are orthogonal: an edge leaves the face that looks at its target (x faces unless the target is mostly above or below) and enters the opposite face, with one elbow pair. Ports spread along a face when several edges share it; edges whose elbows fall in the same channel get separate lanes.
- `--check` warns about overlapping nodes, edges that pass under a node, and iso labels hidden behind a nearer node. Fix them with `at`, `grid`, `bend`, `via` or `labelAt`.
