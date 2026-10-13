---
name: topology
description: Build interactive, simulated figures of distributed systems (services, load balancers, gateways, CDNs, DNS, caches, databases with replicas, Kafka topics with partitions, brokers and consumer groups, queues, object storage, feature flags, regions and zones), drawn isometric or flat 2D from one declarative spec, in a framed card with a title, a hint, a live readout and a narrated scenario that plays on its own. A seeded simulation moves requests through the system with honest p50/p99 latency, queues, timeouts, retries, circuit breakers, health-check delays, Kafka lag and leader elections, and flag rollouts, and clicking a node fails it so the reader sees the load balancer route around it, a retry storm, the lag climb or a canary roll back. Use this whenever someone wants an architecture diagram, a system design or request-path figure, a data-flow or event-flow visualization, an incident or failure-mode explainer, a picture of how Kafka, queues, replication, caching, rate limiting, retries or failover behave, or "an isometric diagram of our infrastructure", for docs, a blog post, a design review, a runbook or a landing page, even if they never say "isometric", "simulation" or "interactive". Ships as one self-contained HTML file (or a static SVG), with a dev server that live-reloads while you edit.
license: MIT
compatibility: Written for Claude Code; the kit and scripts are plain Node with no agent-specific APIs, so it also runs in OpenCode and Codex. Needs Node.js 20.10+ (nothing to npm install), and Chrome or Chromium for the screenshot checks.
metadata:
  opencode/slash: "true"
---

# Topology

This skill draws a distributed system as a small, working model of itself. You write a spec (nodes, edges, zones, rates); the build lays it out, routes the links, draws it both isometric (solid machines on a floor) and flat (2D glyphs on the same layout), and inlines a simulation that moves packets through it. The figure sits in a framed card with a title, a hint and a live readout. **Every number the readout shows comes from the same model that moves the packets.**

Six complete examples ship with it, each with a story. Open the closest one before you start:

- `examples/order-events/`: Kafka with two consumer groups; a billing consumer dies, the group rebalances, lag climbs and drains. Auto-layout.
- `examples/checkout/`: zones, a rate-limited gateway (429s), cache-aside reads, a standby; a traffic spike, then an API dies and the NLB's health check routes around it.
- `examples/retry-storm/`: timeouts plus retries amplify load on a slowed dependency until its buffer overflows; a circuit breaker stops it.
- `examples/failover/`: DNS over two regions; a region's LB dies and DNS keeps sending there until the TTL runs out.
- `examples/kafka-brokers/`: three brokers, RF 3, min ISR 2, acks=all and a hot partition; lose one broker (election), then two (writes refused).
- `examples/canary/`: a flag service drives a canary from 10% to 50%; v2 starts failing; the kill switch.

Build one with `node scripts/build.mjs examples/checkout/checkout.spec.mjs` (add `--light` for the light theme), which writes `checkout.html` next to the spec. While authoring, run `node scripts/serve.mjs examples` instead: every page rebuilds on load and reloads when a spec, its layout file or the kit changes, and `?edit` lets you drag nodes in 2D.

## The idea that matters

**The figure should answer a question about the system, live.** "What happens to lag if a billing worker dies?" "Why do retries make outages worse?" "How long does a regional failover hurt?" Pick that question first. It decides which numbers have to be true and what the story shows. A diagram that only shows boxes and arrows is half done. One that plays the incident on its own, and then lets the reader break things themselves, is the point.

- **Truth first.** Use real rates, partition counts, replica counts, hit ratios and capacities. If you don't know them, ask or say what you assumed in the caption.
- **Tune it to the edge.** Set rates so the interesting failure is visible: consumers with a little headroom, a gateway cap just under the offered load. `--check` shows you the steady state before you look at a pixel.
- **One story per figure.** About 6–14 nodes. A larger system becomes several figures with the same scale and vocabulary (`fig: "Fig 2"`), each with its own question.

## Workflow

1. **Name the question and collect the numbers.** Write down: the sources and their rates, each hop, what fans out, what is sync (request/response) and what is async (logs, queues), partitions, consumer groups and their throughput, caches and hit ratios, replicas, capacities.
2. **Write the spec.** A `.spec.mjs` (or `.json`) with a default export; `references/spec.md` has every field and exactly what the simulation does with it. For the common shapes (a region, a Kafka topic with consumer groups, cache-aside, replicas, a job queue, a canary) use the patterns in `kit/patterns.mjs` and join them with `compose()` and `link()`; `examples/catalog/catalog.html` shows every node kind and pattern with the spec that makes it. Start without coordinates and let auto-layout rank it left to right; add `at: [col, row]` when you need control (zones, a particular reading order), or drag nodes on a `serve.mjs` `?edit` page.
3. **Write the story.** A `scenario` with 3–5 named phases (steady → incident → recovery) and a `say` line for each step: what happened, and what to watch for on screen ("bright cells", "amber retries", "the red port"). Make it loop cleanly: recover what you break, and leave time for lag to drain.
4. **Check the model.** `node scripts/build.mjs my.spec.mjs --check` runs the simulation headless. For each phase it prints the settled numbers (in/s, p50/p99, lag, failing) and the readout just before and 3 s after each step, then per-node stats and warnings:
   - lag that keeps growing
   - drops (except onto nodes the story fails on purpose)
   - idle edges, overlapping nodes, edges under nodes, hidden labels
   - a story that ends broken and will jump when it loops

   Fix the spec until the only warnings are ones you intend, and the phase numbers say what your narration says.
5. **Build both themes.** `node scripts/build.mjs my.spec.mjs` and `--light`. Pick the opening view with `view: "flat"` or `--view flat`; the reader can switch with the ISO/2D control or `V`.
6. **Look at it.** Read every PNG you make (`references/verify.md`):
   - `node scripts/capture.mjs my.html --out shots/iso.png` and `--key v` for 2D, `--width 390` for a phone, on the `-light.html` too.
   - Drive the failure: `node scripts/drive.mjs my.html '[["wait",1500],["click",".tp-iso [data-node=\"billing-a\"]"],["wait",6000],["shot","shots/failed.png"]]'` and read the readout it prints.
   - `node scripts/lines.mjs my.html` must print `line ends: 0` (and after `["key","v"]` for the flat view).
7. **Write the caption.** Under the card: what the system is, what the numbers are, and what to try. The hint corner says how to interact; the default hint is fine for most figures.

## Choosing iso or flat

- **Iso** for a landing page, a blog hero, a talk: the reader recognises the machines (a rack of 1U servers for a service, a stacked disk for a database, a broker with lanes of record cells for Kafka) and the floor plates read as zones.
- **Flat** for docs, runbooks and design reviews: denser, every label upright, routing easier to follow.
- Both are always built; `view` only sets which one opens.

## Visual language (short form)

`references/craft.md` has the full vocabulary, layout patterns and anti-patterns.

- **Monochrome machines, colour only for meaning.** Packet colours:

  | Colour | Packet |
  |---|---|
  | lit (white in dark, black in light) | request |
  | mid grey | response |
  | amber | retry |
  | red | error, or a drop at the target |
  | dark grey | late reply after a timeout |
  | blue | record pulled from a log |
  | green | replication |

  LEDs blink green when a node handles a request and turn red when it is down. Amber cells on a node are its buffer filling. A caller's port ring turns red when its breaker is open and amber when half-open.
- **Kafka is lanes of cells.** Each partition shows its last 12 offsets. A bright cell is a record the first consumer group hasn't committed yet, so lag is the bright run; the white cursor is that group's committed offset, the blue (and green) cursors other groups'.
- **Links lie on the floor.** Solid for sync calls (with a small port ring at the caller), dashed for async and replication, a chevron where they arrive. Parallel links get their own lanes.
- **Labels lie on the floor in iso**, in front of the node or along its side, whichever no nearer node hides; in flat they sit under each glyph. Zone labels are engraved on the plate's front corner.
- **Hover dims everything except a node and its neighbours**, and the readout (with a 30 s sparkline) switches to that node's numbers.
- **Edge labels** show live rates (`labels: "rate"`), flag shares and error rates; crossings hop.
- **Switching views morphs**: the iso camera swings to top-down, then crossfades into the 2D glyphs.

## Files

| File | Use it for |
|---|---|
| `scripts/build.mjs` | Spec → standalone HTML page (both views, the sim, the live code inlined). `--check`, `--light`, `--view`, `--out`, `--stdout`, `--svg` (static themed SVGs of each view), `--features`, `--no-<feature>`. |
| `scripts/serve.mjs` | The dev server: `node scripts/serve.mjs [dir] [--port 8765] [--host 127.0.0.1]`. Pages rebuild per request (kit edits apply too) and reload over SSE; `?theme=light`, `?view=flat`, `?features=-morph`, `?edit` (drag nodes in 2D, saved to `<name>.layout.json`). |
| `scripts/page.mjs` | Shared by both: spec loading with the layout sidecar, the page build, `--check` and its story timeline. |
| `kit/topo.mjs` | Normalising the spec, auto-layout, orthogonal routing with port spreading and channel lanes, the iso and flat renderers for every node kind, label placement, `TOPO_CSS`. Add a node kind here (`references/craft.md`, "Adding a kind"). |
| `kit/topo-sim.mjs` | The model: a seeded, tick-based simulation of request lifecycles (sync calls awaited, model-time latency, capacity and queues, refusals and resets, timeouts, retries, breakers, health-check delays, Kafka partitions, groups, brokers and ISR, queues, replication, flags, scenario steps) and the readout text. Pure; runs in Node and in the page. |
| `kit/topo-live.js` | The page runtime: steps the sim, draws packets (with trails), blinks LEDs, fills record and queue cells, moves cursors and flag knobs, updates breakers and edge labels, handles hover, click, keys, the sparkline and the view morph. Writes attributes, never re-renders. Exposes `window.__topo` for checks. |
| `kit/topo-story.js` | The scenario player: timeline, phases, narration, scrubbing (re-simulates from 0), takeover. |
| `kit/topo-edit.js` | The serve editor: drag nodes in 2D, snap to quarter cells, POST the layout. |
| `kit/patterns.mjs` | Reusable fragments: `kafkaTopic`, `region`, `cacheAside`, `replicatedDb`, `queueWorkers`, `canary`, plus `compose()` and `link()`. |
| `scripts/catalog.mjs` | Draws every node kind and pattern in iso and 2D with its spec (`examples/catalog/catalog.html`; `/catalog` on the dev server). |
| `kit/topo-features.mjs` | The tool's feature toggles and their resolution (spec < CLI < URL). |
| `tests/` | `node --test tests/*.test.mjs`: the model's behaviour and the page build. |
| `kit/iso.mjs` | The drawing core: an orthographic camera (`iso`, `depthOf`, `fitProjection`), shaded prisms (`extrude`, `slabOf`, `cylinder`), lines on faces (`onTop`, `ring`, `sideArc`, `sideSeam`, `radialTicks`, `topMatrix`), SVG emitters (`solidSvg`, `lineSvg`, `dotsSvg`, `faceTextSvg`, `figureSvg`), the card (`plateHtml`), the page (`pageHtml`) and the palette (`KIT_CSS`, `--tp-*` tokens). |
| `scripts/capture.mjs`, `scripts/drive.mjs`, `scripts/lines.mjs`, `scripts/browser.mjs` | Headless Chrome screenshots, scripted sessions and the line-end check, over a small DevTools client (`browser.mjs`). Set `CHROME_PATH` if Chrome isn't found. |

## Embedding

The output is one self-contained HTML file with no network requests (about 150 KB, or 300 KB with the morph). Put it in an `<iframe>`, or lift the `<figure>` and its `<style>` and `<script type="module">` into a page. `--svg` writes a static SVG of each view for places that can't run script (a README, a slide).

## References

- `references/spec.md`: every spec field, and exactly what the simulation does with it. Read it before writing a spec.
- `references/craft.md`: the node vocabulary in both views, packet and cursor colours, layout patterns (fan-in, fan-out, replicas, zones, cache-aside, CDC), sizing rates so failures show, anti-patterns, and how to add a node kind.
- `references/verify.md`: the check, capture and drive commands, a failure-scenario script, and the review checklist.
