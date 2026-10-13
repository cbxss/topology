---
name: topology
description: Create or edit distributed-system architecture diagrams, request and event flows, and interactive failure explanations from a declarative spec. Render isometric or flat 2D figures as standalone HTML or static SVG. Use for infrastructure diagrams, incident explainers, and visual demonstrations of routing, retries, queues, Kafka, replication, or feature rollouts. Interactive figures include a seeded simulation, inspectors, saved-record fields, and optional narrated scenarios.
license: MIT
metadata:
  opencode/slash: "true"
  version: "1.0.0"
---

# Topology

Requires Node.js 20.10+ to build, Node.js 22+ and Chrome/Chromium for browser verification. No npm dependencies or agent-specific APIs; works with Codex, Claude Code, and OpenCode.

This skill draws a distributed system as a small, working model of itself. You write a spec (nodes, edges, zones, rates); the build lays it out, routes the links, draws it both isometric (solid machines on a floor) and flat (2D glyphs on the same layout), and inlines a simulation that moves packets through it. The figure sits in a framed card with a title, a hint and a live readout. **Every number the readout shows comes from the same model that moves the packets.**

Resolve every kit, script, example, and reference path relative to the directory containing this `SKILL.md`, including when installed by `npx skills add cbxss/topology` or from the npm package `@cbxss/topology`. The commands below assume that directory is the working directory. When working in a user project, invoke the builder by its absolute installed path and pass the project spec path; keep authored specs and generated outputs in the user project.

Start with `references/spec.md` and the closest example. The minimal endpoint/table recipe there is executable and covered by tests.

| Question | Start from |
|---|---|
| Consumer lag and rebalancing | `examples/order-events/` |
| Gateway capacity, cache-aside and health checks | `examples/checkout/` |
| Timeout amplification and breakers | `examples/retry-storm/` |
| Regional failover | `examples/failover/` |
| Broker elections and min ISR | `examples/kafka-brokers/` |
| Flag rollout and rollback | `examples/canary/` |
| Redis, ElastiCache and DynamoDB components | `examples/data-stores/` |
| Context-based downstream service/database routing and traffic colors | `examples/tenant-routing/` |
| Context retained through Kafka and consumer routing | `examples/event-routing/` |
| Route mixes, rows and WAL inspection | `examples/orders-api/` |
| Save then read back from a replica | `examples/read-your-writes/` |
| Committed writes retried after a timeout | `examples/idempotent-retries/` |
| Hot-key races and row locks | `examples/lost-update/` |
| Compose a larger system from fragments | `examples/platform/` |

Build one with `node scripts/build.mjs examples/checkout/checkout.spec.mjs` (add `--light` for the light theme), which writes `checkout.html` next to the spec. While authoring, run `node scripts/serve.mjs examples` instead: every page rebuilds on load and reloads when a spec, its layout file or the kit changes, and `?edit` lets you drag nodes in 2D.

## The idea that matters

**The figure should answer a question about the system, live.** "What happens to lag if a billing worker dies?" "Why do retries make outages worse?" "How long does a regional failover hurt?" Pick that question first. It decides which numbers have to be true and what the story shows. For interactive explanations, show the behavior that answers that question. For static diagrams or a requested narrow edit, keep the deliverable within that scope; a scenario is optional.

- **Truth first.** Use real rates, partition counts, replica counts, hit ratios and capacities. If you don't know them, ask or say what you assumed in the caption.
- **Tune it to the edge.** Set rates so the interesting failure is visible: consumers with a little headroom, a gateway cap just under the offered load. `--check` shows you the steady state before you look at a pixel.
- **One story per figure.** About 6–14 nodes. A larger system becomes several figures with the same scale and vocabulary (`fig: "Fig 2"`), each with its own question.

## Static figures

For a slide or static diagram, omit traffic and scenarios unless requested. Run
`node scripts/build.mjs my.spec.mjs --svg --light`: this emits
`my-light.html`, `my-light-iso.svg` and `my-light-flat.svg` next to the spec.
Deliver the requested SVG; HTML is a build byproduct. Check layout with
`--check`; idle edges and missing emit are expected for a structural diagram.
Inspect the actual SVG in a browser or an HTML `<img>` wrapper at the intended
slide size. Failure driving, phone tests and extra themes are unnecessary unless
those are part of the requested deliverable.

## Interactive workflow

1. **Name the question and collect the numbers.** Write down: the sources and their rates, each hop, what fans out, what is sync (request/response) and what is async (logs, queues), partitions, consumer groups and their throughput, caches and hit ratios, replicas, capacities.
2. **Write the spec.** A `.spec.mjs` (or `.json`) with a default export; `references/spec.md` has every field and exactly what the simulation does with it. For the common shapes (a region, a Kafka topic with consumer groups, cache-aside, replicas, a job queue, a canary) use the patterns in `kit/patterns.mjs` and join them with `compose()` and `link()` (to reuse a whole existing figure, embed its spec with `system()`, see "Composing systems" in `references/spec.md`); `examples/catalog/catalog.html` shows every node kind and pattern with the spec that makes it. Start without coordinates and let auto-layout rank it left to right; add `at: [col, row]` when you need control (zones, a particular reading order), or drag nodes on a `serve.mjs` `?edit` page.
   **Drawing a real codebase? Cite it.** Declare its repos in `sources` and give every node and edge `refs` to the code or config it comes from (`"infra:k8s/api.yaml#replicas:"`, with `field: "replicas"` when a number comes from there), and `notes` for what the code can't say; mark guesses as `{ text, field, assumed: true }`. Refs and notes never appear in the figure. **Before changing an existing figure, run `node scripts/build.mjs my.spec.mjs --sources` first**: it shows where each component lives (with snippets) and flags refs that are missing, whose numbers no longer match, or whose files changed since the pinned `rev`. Fix what it flags, then update `rev`. See "Sources and notes" in `references/spec.md`.
3. **Write the story when useful.** For an incident or behavior explanation, add a `scenario` with 3–5 named phases (steady → incident → recovery) and a `say` line for each step: what happened, and what to watch for on screen ("bright cells", "amber retries", "the red port"). Make it loop cleanly: recover what you break, and leave time for lag to drain.
4. **Check the model.** `node scripts/build.mjs my.spec.mjs --check` runs the simulation headless. For each phase it prints the settled numbers (in/s, p50/p99, lag, failing, dropped traffic, and table metrics such as stale reads) and the readout just before and 3 s after each step, then per-node stats and warnings:
   - lag that keeps growing
   - drops (except onto nodes the story fails on purpose)
   - idle edges, overlapping nodes, edges under nodes, hidden labels
   - a story that ends broken and will jump when it loops

   Fix the spec until the only warnings are ones you intend, and the phase numbers say what your narration says.
5. **Build both themes.** `node scripts/build.mjs my.spec.mjs` and `--light`. Pick the opening view with `view: "flat"` or `--view flat`; the reader can switch with the ISO/2D control or `V`.
6. **Look at it.** Read every PNG you make (`references/verify.md`):
   - `node scripts/capture.mjs my.html --out shots/iso.png` and `--key v` for 2D, `--width 390` for a phone, on the `-light.html` too.
   - Drive the failure: `node scripts/drive.mjs my.html '[["wait",1500],["click",".tp-iso [data-node=\"billing-a\"]"],["key","f"],["wait",6000],["shot","shots/failed.png"]]'` and read the readout it prints.
   - `node scripts/lines.mjs my.html` must print `line ends: 0` (and after `["key","v"]` for the flat view).
7. **Write the caption.** Under the card: what the system is, what the numbers are, and what to try. The hint corner says how to interact; the default hint is fine for most figures.

## Progressive disclosure

Keep the overview legible: topology, traffic and the story first. Clicking a node opens its inspector; do not place route lists, table rows or WAL details on every glyph. Reveal those in the inspector when the question needs them. Declare the fields you want to inspect in `records.<table>.fields`; the inspector cannot show fields the model never stored. Click a database row for all saved fields and its separate version metadata; Follow writes pins the key and shows primary/replica state as real writes arrive. Select a route to filter traffic, then use Follow a request for the causal sequence. Failure is explicit: the inspector's Fail/Restore button or F on the focused node. Kafka broker units still toggle directly.

Use scenario `inspect` and `follow` only when narration calls for the detail, and close them with `false` afterward. Disclose illustrative rates, `sim.per` scaling, synthetic rows, probability-based cache misses, and model limits in the caption. UPSERT is not exactly-once processing; `rmw` detects version races rather than executing SQL. Verify claimed versions in an actual trace; avoid hard-coded version numbers that vary with timing.

For context routing, use the public `workload`, `traffic`, `policies` and `routing` fields in the spec reference. Disclose synthetic metadata, weighted choices, and dispatch-offset semantics. Keep rule explanations and context in the inspector/follow view; use class labels and state shapes alongside color. Verify a down destination does not silently spill into fallback. Authors need the reference and examples, not engine internals.

Reuse the shipped kit. Author a spec and build it; modifying the engine is needed only for a new simulation capability.

## Choosing iso or flat

- **Iso** for a landing page, a blog hero, a talk: the reader recognises the machines (a rack of 1U servers for a service, a stacked disk for a database, a broker with lanes of record cells for Kafka) and the floor plates read as zones.
- **Flat** for docs, runbooks and design reviews: denser, every label upright, routing easier to follow.
- Both are always built; `view` only sets which one opens.

## Visual language (short form)

`references/craft.md` has the full vocabulary, layout patterns and anti-patterns.

- **Monochrome machines, colour only for meaning.** Default Activity packet colours (Traffic mode identifies request classes instead):

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
| `scripts/build.mjs` | Spec → standalone HTML page (both views, the sim, the live code inlined). `--check`, `--light`, `--view`, `--out`, `--stdout`, `--svg` (static themed SVGs of each view), `--features`, `--no-<feature>`, `--sources` (check the spec's source refs; `--json`, `--fetch`, `--source-dir`, `--strict`). |
| `scripts/serve.mjs` | The dev server: `node scripts/serve.mjs [dir] [--port 8765] [--host 127.0.0.1]`. Pages rebuild per request (kit edits apply too) and reload over SSE; `?theme=light`, `?view=flat`, `?features=-morph`, `?edit` (drag nodes in 2D, saved to `<name>.layout.json`). |
| `scripts/page.mjs` | Shared by both: spec loading with the layout sidecar, the page build, `--check` and its story timeline. |
| `kit/topo.mjs` | Normalising the spec, auto-layout, orthogonal routing with port spreading and channel lanes, the iso and flat renderers for every node kind, label placement, `TOPO_CSS`. Add a node kind here (`references/craft.md`, "Adding a kind"). |
| `kit/components.mjs` | Reusable Redis, ElastiCache and DynamoDB component registry and drawings; product kinds reuse cache/database simulation behavior. |
| `kit/topo-sim.mjs` | Stable simulation import path. Its implementation lives in `kit/sim/`; authors use the spec reference and examples. Maintainer boundaries and verification: `references/engine.md`. |
| `kit/topo-live.js` | The page runtime: steps the sim, draws packets (with trails), blinks LEDs, fills record and queue cells, moves cursors and flag knobs, updates breakers and edge labels, handles hover, click, keys, the sparkline and the view morph. Writes attributes, never re-renders. Exposes `window.__topo` for checks. |
| `kit/topo-traffic.js`, `kit/traffic.css` | Presentation-only traffic palette, class legend, filters and color-mode controls. |
| `kit/topo-records.js` | Saved-record details and record-specific write following, backed by actual stores and retained WAL. |
| `kit/topo-story.js` | The scenario player: timeline, phases, narration, scrubbing (re-simulates from 0), takeover. |
| `kit/topo-edit.js` | The serve editor: drag nodes in 2D, snap to quarter cells, POST the layout. |
| `kit/patterns.mjs` | Reusable fragments: `kafkaTopic`, `region`, `cacheAside`, `replicatedDb`, `queueWorkers`, `canary`, `system()` (embed another spec), plus `compose()`, `link()` and `importSpec()`. |
| `kit/provenance.mjs`, `scripts/sources.mjs` | Source refs and notes: their shape, stripping them from pages, and resolving and checking them for `--sources`. |
| `scripts/catalog.mjs` | Draws every node kind and pattern in iso and 2D with its spec (`examples/catalog/catalog.html`; `/catalog` on the dev server). |
| `kit/topo-features.mjs` | The tool's feature toggles and their resolution (spec < CLI < URL). |
| `tests/` | `node --test tests/*.test.mjs`: the model's behaviour and the page build. |
| `kit/iso.mjs` | The drawing core: an orthographic camera (`iso`, `depthOf`, `fitProjection`), shaded prisms (`extrude`, `slabOf`, `cylinder`), lines on faces (`onTop`, `ring`, `sideArc`, `sideSeam`, `radialTicks`, `topMatrix`), SVG emitters (`solidSvg`, `lineSvg`, `dotsSvg`, `faceTextSvg`, `figureSvg`), the card (`plateHtml`), the page (`pageHtml`) and the palette (`KIT_CSS`, `--tp-*` tokens). |
| `scripts/capture.mjs`, `scripts/drive.mjs`, `scripts/lines.mjs`, `scripts/browser.mjs` | Headless Chrome screenshots, scripted sessions and the line-end check, over a small DevTools client (`browser.mjs`). Set `CHROME_PATH` if Chrome isn't found. |

## Embedding

The output is one self-contained HTML file with no network requests; size depends on enabled features. Put it in an `<iframe>`, or lift the `<figure>` and its `<style>` and `<script type="module">` into a page. `--svg` writes a static SVG of each view for places that can't run script (a README, a slide).

## References

- `references/spec.md`: every spec field, and exactly what the simulation does with it. Read it before writing a spec.
- `references/craft.md`: the node vocabulary in both views, packet and cursor colours, layout patterns (fan-in, fan-out, replicas, zones, cache-aside, CDC), sizing rates so failures show, anti-patterns, and how to add a node kind.
- `references/verify.md`: the check, capture and drive commands, a failure-scenario script, and the review checklist.
