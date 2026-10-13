---
name: topology
description: Build interactive, simulated figures of distributed systems (services, load balancers, gateways, caches, databases with replicas, Kafka topics with partitions and consumer groups, queues, object storage, availability zones), drawn isometric or flat 2D from one declarative spec. Packets move through the system from a seeded simulation, Kafka lag and consumer offsets are live, and clicking a node fails it so the reader sees the LB route around it, the consumer group rebalance or the lag climb. Use this whenever someone wants an architecture diagram, a system design figure, a request-path or data-flow visualization, an explainer of Kafka/queues/replication/caching/rate limiting/failover, or "an isometric diagram of our infrastructure", for docs, a blog post, a design review or a landing page, even if they never say "isometric" or "simulation".
license: MIT
compatibility: Written for Claude Code. Needs Node.js 20.10+ (no npm install), and Chrome or Chromium for the screenshot checks.
---

# Topology

This skill draws a distributed system as a small, working model of itself. You write a spec (nodes, edges, zones, rates); the build lays it out, routes the links, draws it both isometric (solid machines on a floor) and flat (2D glyphs on the same layout), and inlines a simulation that moves packets through it. The figure sits in a framed card with a title, a hint and a live readout. **Every number the readout shows comes from the same model that moves the packets.**

Two complete examples ship with it. Open the closest one before you start:

- `examples/order-events/`: clients → LB → a 3-replica API → Postgres (with a streaming replica) and a 3-partition Kafka topic read by two consumer groups. Billing has two consumers over three partitions, so one owns two: fail a billing worker and the group rebalances, then lag climbs. Auto-layout, no coordinates.
- `examples/checkout/`: a gateway with a rate limit (red 429s), an NLB across two zones, cache-aside reads (80% hit) and a primary with a standby in the other zone, inside nested VPC and zone plates. Placed with `at`.

Build one with `node scripts/build.mjs examples/checkout/checkout.spec.mjs` (add `--light` for the light theme). That writes `checkout.html` next to the spec.

## The idea that matters

**The figure should answer a question about the system, live.** "What happens to lag if a billing worker dies?" "Why do we see 429s?" "Does the standby get every write?" Pick that question first; it decides which numbers have to be true and which failure the hint invites. A diagram that only shows boxes and arrows is half done. One where the reader breaks a node and watches the consequence is the point.

- **Truth first.** Use real rates, partition counts, replica counts, hit ratios and capacities. If you don't know them, ask or say what you assumed in the caption.
- **Tune it to the edge.** Set rates so the interesting failure is visible: consumers with a little headroom, a gateway cap just under the offered load. `--check` shows you the steady state before you look at a pixel.
- **One story per figure.** About 6–14 nodes. A larger system becomes several figures with the same scale and vocabulary (`fig: "Fig 2"`), each with its own question.

## Workflow

1. **Name the question and collect the numbers.** Write down: the sources and their rates, each hop, what fans out, what is sync (request/response) and what is async (logs, queues), partitions, consumer groups and their throughput, caches and hit ratios, replicas, capacities.
2. **Write the spec.** A `.spec.mjs` (or `.json`) with a default export; `references/spec.md` has every field and exactly what the simulation does with it. Start without coordinates and let auto-layout rank it left to right; add `at: [col, row]` when you need control (zones, a particular reading order).
3. **Check the model.** `node scripts/build.mjs my.spec.mjs --check 30` runs the simulation headless and prints what the readout will say over time, per node, plus warnings: lag that keeps growing, drops, idle edges, overlapping nodes, edges passing under a node, labels hidden in iso. Fix the spec until the only warnings are ones you intend (say, shedding at a rate limit), and the steady state tells the story you want.
4. **Build both themes.** `node scripts/build.mjs my.spec.mjs` and `--light`. Pick the opening view with `view: "flat"` or `--view flat`; the reader can switch with the ISO/2D control or `V`.
5. **Look at it.** Read every PNG you make (`references/verify.md`):
   - `node scripts/capture.mjs my.html --out shots/iso.png` and `--key v` for 2D, `--width 390` for a phone, on the `-light.html` too.
   - Drive the failure: `node scripts/drive.mjs my.html '[["wait",1500],["click",".tp-iso [data-node=\"billing-a\"]"],["wait",6000],["shot","shots/failed.png"]]'` and read the readout it prints.
   - `node scripts/lines.mjs my.html` must print `line ends: 0` (and after `["key","v"]` for the flat view).
6. **Write the caption.** Under the card: what the system is, what the numbers are, and what to try. The hint corner says how to interact; the default hint is fine for most figures.

## Choosing iso or flat

- **Iso** for a landing page, a blog hero, a talk: the reader recognises the machines (a rack of 1U servers for a service, a stacked disk for a database, a broker with lanes of record cells for Kafka) and the floor plates read as zones.
- **Flat** for docs, runbooks and design reviews: denser, every label upright, routing easier to follow.
- Both are always built; `view` only sets which one opens.

## Visual language (short form)

`references/craft.md` has the full vocabulary, layout patterns and anti-patterns.

- **Monochrome machines, colour only for meaning.** Request packets are the lit tone (white in dark, black in light), responses mid grey, records pulled from a log blue, replication green, drops red. LEDs blink green when a node handles a message and turn red when it is down.
- **Kafka is lanes of cells.** Each partition shows its last 12 offsets. A bright cell is a record the first consumer group hasn't committed yet, so lag is the bright run; the white cursor is that group's committed offset, the blue (and green) cursors other groups'.
- **Links lie on the floor.** Solid for sync calls (with a small port ring at the caller), dashed for async and replication, a chevron where they arrive. Parallel links get their own lanes.
- **Labels lie on the floor in iso**, in front of the node or along its side, whichever no nearer node hides; in flat they sit under each glyph. Zone labels are engraved on the plate's front corner.
- **Hover dims everything except a node and its neighbours**, and the readout switches to that node's numbers.

## Files

| File | Use it for |
|---|---|
| `scripts/build.mjs` | Spec → standalone HTML page (both views, the sim, the live code inlined). `--check`, `--light`, `--view`, `--out`, `--svg` (static themed SVGs of each view). |
| `kit/topo.mjs` | Normalising the spec, auto-layout, orthogonal routing with port spreading and channel lanes, the iso and flat renderers for every node kind, label placement, `TOPO_CSS`. Add a node kind here (`references/craft.md`, "Adding a kind"). |
| `kit/topo-sim.mjs` | The model: a seeded, tick-based simulation (sources, routing, sync responses, capacity, Kafka partitions and consumer groups with rebalancing, queues, replication, failures) and the readout text. Pure; runs in Node and in the page. |
| `kit/topo-live.js` | The page runtime: steps the sim, draws packets into the visible view, blinks LEDs, fills record cells, moves cursors, handles hover, click, keys and the view switch. Writes attributes, never re-renders. Exposes `window.__topo` for checks. |
| `kit/iso.mjs` | The drawing core: an orthographic camera (`iso`, `depthOf`, `fitProjection`), shaded prisms (`extrude`, `slabOf`, `cylinder`), lines on faces (`onTop`, `ring`, `sideArc`, `sideSeam`, `radialTicks`, `topMatrix`), SVG emitters (`solidSvg`, `lineSvg`, `dotsSvg`, `faceTextSvg`, `figureSvg`), the card (`plateHtml`), the page (`pageHtml`) and the palette (`KIT_CSS`, `--tp-*` tokens). |
| `scripts/capture.mjs`, `scripts/drive.mjs`, `scripts/lines.mjs` | Headless Chrome screenshots, scripted sessions and the line-end check. |

## Embedding

The output is one self-contained HTML file with no network requests. Put it in an `<iframe>`, or lift the `<figure>` and its `<style>` and `<script type="module">` into a page. `--svg` writes a static SVG of each view for places that can't run script (a README, a slide).

## References

- `references/spec.md`: every spec field, and exactly what the simulation does with it. Read it before writing a spec.
- `references/craft.md`: the node vocabulary in both views, packet and cursor colours, layout patterns (fan-in, fan-out, replicas, zones, cache-aside, CDC), sizing rates so failures show, anti-patterns, and how to add a node kind.
- `references/verify.md`: the check, capture and drive commands, a failure-scenario script, and the review checklist.
