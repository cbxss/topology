# Craft

## Vocabulary

Each kind has one object in iso and one glyph in flat, on the same footprint, so the two views line up.

| Kind | Iso | Flat | LEDs |
|---|---|---|---|
| `client` | A laptop: deck with keyboard and trackpad outlines, lid with three rule lines on the screen | A monitor on a stand | one, on the screen bezel |
| `lb` | An octagonal puck with a fan of three lines from one point on top | An octagon with the fan | one |
| `gateway` | A gate: base, two posts, a lintel | A box with an arch | one, on the lintel |
| `service` | A stack of 1U servers (one per replica, up to 4) with drive bays and a status LED each | A card with a header and one pip per replica; extra replicas show as offset cards behind | one per replica |
| `worker` | As `service`, with a fan ring on top | As `service`, with a ring in the header | one per replica |
| `cache` | A board with two rows of memory chips | A box with a row of chips | one |
| `db` | Three stacked disks, `role` on the top | A cylinder, `role` on the lid | one per disk (the top one blinks) |
| `storage` | Three disks widening upward: a bucket | A bucket | one |
| `kafka` | A broker plinth with one lane per partition, 12 record cells each, and a cursor per consumer group | A box with lanes of cells and cursor ticks | three broker LEDs |
| `queue` | `kafka` with one lane | as `kafka` | three |
| `box` | A plain block with a seam | A plain box | one |
| `cdn` | A PoP slab with a globe on top | A box with a globe | one |
| `dns` | A small tower with a dish | A mast with a dish | one, on the dish |
| `external` | A block outlined dashed, three dots on top | A dashed box | one |
| `scheduler` | A clock face on a slab | A clock | one |
| `flags` | A panel of switches, one knob per flag sliding with its rollout | A list of switches | one, blinks on config changes |
| sidecar | A small box on the node's right side | A small box | one |
| `kafka` with `brokers` | Broker units down the left end of the plinth (click to fail) | Broker chips | one per broker |

## Colour

The machines stay monochrome in the kit's four tones; colour carries meaning only.

| What | Dark | Light |
|---|---|---|
| Request packet | white | black |
| Response packet | mid grey | mid grey |
| Retry | amber | amber |
| Error reply | red | red |
| Late reply (after a timeout) | dark grey | light grey |
| Buffer filling (queue cells) | amber | amber |
| Breaker port: open / half-open | red / amber | red / amber |
| Partition electing a leader | dimmed lane | dimmed lane |
| Record pulled from a log | blue | blue |
| Replication | green | green |
| Dropped (down or over capacity) | red, growing and fading at the target | red |
| LED: handled a message | green blink | green blink |
| LED: node down | red, node faded and outlined dashed | red |
| Unconsumed record cell | bright | dark |
| Cursor: group 1 / 2 / 3 | lit / blue / green | black / blue / green |

## Layout patterns

- **Read left to right.** Sources in the first column, sinks in the last. Auto-layout does this; when you place nodes yourself keep one column per hop.
- **Fan-out** (an LB over N services, a topic over N consumers): the targets in one column, rows centred on the source. Ports spread along the source's face; the channel lanes keep the middle legs apart.
- **Fan-in** (N clients into one LB): the mirror image.
- **Replicas** sit right under their primary in the same column, joined by a short vertical `replication` edge.
- **Zones** are contiguous rows (zone a above zone b), each a `group`; the region or VPC is a group of groups. Put shared things (the LB, a regional database) in the outer group, between the zones' rows.
- **Cache-aside**: the cache above the database in the next column; `api → cache` at `p: 1`, `api → db` at `p: 1 - hit`.
- **CDC / outbox**: `db → connector (worker) → kafka` with `route: "all"`; downstream consumers in groups.
- **Row pitch.** Tall nodes (db, storage, client) hide what lies just behind them in iso. Leave a row pitch of at least ~64 world units under a database, or let `--check` tell you which label is hidden.

## Story patterns

Each of these has an example to copy:

- **Consumer lost** (`order-events`). Fail one member of a consumer group. The group pauses to rebalance, the survivors fall behind, and recovery drains the lag. Size the survivors just under the inflow.
- **Health-check delay** (`checkout`). Fail a target behind an LB. A few requests are refused before `detect` notices; then the rest of the pool absorbs the load.
- **Retry storm** (`retry-storm`). Slow a dependency past its callers' `timeout`. Every call times out and retries multiply the load, so the buffer fills and 503s follow. Then turn on a breaker with a `set` step on the edge (`"a>b": { breaker: … }`), and fix the dependency later so the breaker half-opens and closes.
- **Regional failover** (`failover`). DNS with `ttl` over two `region` groups. Fail one region's LB: errors last for the TTL, then everything moves.
- **Broker loss** (`kafka-brokers`). RF 3, min ISR 2, acks=all. One broker down is an election pause; two down refuses every write.
- **Canary and kill switch** (`canary`). Ramp a flag, give v2 an `errorRate`, then `kill` the flag.
- **Traffic spike.** `set: { src: { emit: … } }`, or an `emit` curve, against a rate limit or a fixed capacity.

## Sizing the numbers

- Keep on-screen packets under about 30 per second in total; set `per` so the readout still shows real throughput.
- A consumer group's capacity is set by its busiest member: partitions are assigned `p % members`, so 3 partitions over 2 consumers means one consumer carries 2/3 of the topic. Size `rate` against that, not against the total ÷ members. This is real Kafka behaviour, and worth showing.
- To make a failure visible, leave little headroom: the surviving consumers should be just slower than the inflow, so lag grows steadily rather than exploding off the scale (the lanes show 12 offsets; the readout shows the rest).
- A rate limit reads best a little under the offered load (offered 14, `capacity: 12`): a steady trickle of red, not a flood.

## Anti-patterns

- **A diagram with nothing to try.** If clicking any node does nothing interesting, the figure has no question. Find the one failure worth showing and tune for it.
- **Invented numbers presented as real.** Say in the caption which numbers are illustrative.
- **Everything in one figure.** Past ~14 nodes the routing tangles and the packets turn to noise. Split by question.
- **Zones that overlap.** A non-member inside a group's box reads as a member. Rearrange rows.
- **Labels as paragraphs.** Labels are names (`orders-api`, `orders.v1`); the explanation goes in the caption.

## Adding a kind

1. `KINDS` in `kit/topo.mjs`: its footprint `{ w, d, h }`.
2. `ISO.<kind>(node, c)`: the solids, using `c.S` (`solidSvg`), `c.L` (`lineSvg`), `c.led(id, point)` and the drawing core's builders in `kit/iso.mjs` (`slabOf`, `cylinder`, `extrude`, `planOutline`, `sideArc`, …). Paint back to front. Give it at least one `data-led` with id `<node>:0`. Lines must end on something (`scripts/lines.mjs`), or carry `free` when they stand for text or a pointer tip.
3. `FLAT.<kind>(node, f)`: the glyph inside `f.box(node.plan)`, with `f.rect`, `f.line`, `f.led`.
4. `heightOf` if it is taller than its `KINDS.h`, and `ledFor` in `kit/topo-live.js` if its LEDs aren't `<node>:0`.
5. Add it to `KINDS` in `scripts/catalog.mjs` so it shows in the catalog, with a one-line description and its typical fields.
6. If it behaves differently (a new kind of buffer, say), the behaviour goes in `kit/topo-sim.mjs`, and `--check` must still read true.
